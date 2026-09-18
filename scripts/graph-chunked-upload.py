#!/usr/bin/env python3
"""Upload a file to a Microsoft Graph upload session in fragments.

Why this exists: .github/workflows/backup.yml used to PUT the whole dump in one
request. Graph caps a single upload-session request well below what the weekly
dump now weighs — 200MB on 2026-08-07 went through, 276MB on 2026-08-14 came
back HTTP 400 — so the weekly backup failed every run from then on, and
silently, because the workflow's report-error step had no token configured.

Fragments must be a multiple of 320 KiB. 40 MiB sits inside Graph's documented
60 MiB per-request ceiling with room for the dump to keep growing.

Deliberately stdlib only: it runs on a GitHub runner with no pip install step,
and urllib is enough.

    python3 scripts/graph-chunked-upload.py <uploadUrl> <path>
"""

import os
import sys
import urllib.error
import urllib.request

CHUNK = 40 * 1024 * 1024  # multiple of 320 KiB (320 KiB * 128)
RETRIES = 3


def put_fragment(url: str, data: bytes, start: int, total: int) -> int:
    """PUT one fragment, retrying only what Graph documents as retryable."""
    end = start + len(data) - 1
    for attempt in range(RETRIES):
        request = urllib.request.Request(url, data=data, method="PUT")
        request.add_header("Content-Length", str(len(data)))
        request.add_header("Content-Range", f"bytes {start}-{end}/{total}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status
        except urllib.error.HTTPError as err:
            # 429 and 5xx are transient. A 4xx is our own bug (bad range, dead
            # session) and must fail the run loudly rather than retry into the
            # same wall three times.
            retryable = err.code == 429 or err.code >= 500
            if attempt == RETRIES - 1 or not retryable:
                body = err.read()[:500].decode("utf-8", "replace")
                print(f"::error::upload failed at bytes {start}-{end}: HTTP {err.code} {body}")
                sys.exit(1)
        except urllib.error.URLError as err:
            if attempt == RETRIES - 1:
                print(f"::error::upload failed at bytes {start}-{end}: {err}")
                sys.exit(1)
    raise AssertionError("unreachable")


def main() -> None:
    if len(sys.argv) != 3:
        print("::error::usage: graph-chunked-upload.py <uploadUrl> <path>")
        sys.exit(2)
    url, path = sys.argv[1], sys.argv[2]
    total = os.path.getsize(path)
    if total == 0:
        print("::error::refusing to upload a zero-byte file")
        sys.exit(1)

    sent = 0
    with open(path, "rb") as handle:
        while sent < total:
            data = handle.read(CHUNK)
            if not data:
                break
            status = put_fragment(url, data, sent, total)
            sent += len(data)
            print(f"  {sent}/{total} bytes (HTTP {status})", flush=True)

    # A short read would otherwise leave a truncated file in OneDrive looking
    # like a good backup, which is the one outcome worse than no backup.
    if sent != total:
        print(f"::error::sent {sent} of {total} bytes")
        sys.exit(1)


def selftest() -> None:
    """Fragmentation + reassembly + fail-fast, against a throwaway local server.

    No framework: the interesting logic here is the byte ranges and the retry
    classification, and both are cheap to exercise for real.
    """
    import http.server
    import tempfile
    import threading

    received: list[tuple[str, bytes]] = []
    fail_with = {"code": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self) -> None:  # noqa: N802 - stdlib naming
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.headers["Content-Range"], body))
            code = fail_with["code"] or 202
            self.send_response(code)
            self.end_headers()

        def log_message(self, *_args: object) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/session"

    global CHUNK
    CHUNK = 1024  # small, so the test file spans several fragments
    payload = bytes(range(256)) * 20  # 5120 bytes -> 5 fragments
    with tempfile.NamedTemporaryFile(delete=False) as fh:
        fh.write(payload)
        path = fh.name

    sys.argv = ["x", url, path]
    main()
    assert len(received) == 5, f"expected 5 fragments, got {len(received)}"
    assert received[0][0] == f"bytes 0-1023/{len(payload)}", received[0][0]
    assert received[-1][0] == f"bytes 4096-5119/{len(payload)}", received[-1][0]
    assert b"".join(b for _, b in received) == payload, "reassembly mismatch"

    # A 4xx must fail the run immediately, not retry into the same wall.
    received.clear()
    fail_with["code"] = 400
    try:
        main()
    except SystemExit as exit_err:
        assert exit_err.code == 1, exit_err.code
        assert len(received) == 1, f"a 4xx was retried {len(received)} times"
    else:
        raise AssertionError("a 400 should have exited non-zero")

    os.unlink(path)
    server.shutdown()
    print("selftest OK: 5 fragments, exact ranges, byte-identical reassembly, 4xx fails fast")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
