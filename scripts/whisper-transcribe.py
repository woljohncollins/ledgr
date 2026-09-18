#!/usr/bin/env python3
"""
whisper-transcribe.py — audio file in, plain transcript text out on stdout.

Called by src/lib/youtube/fetch.ts when a saved YouTube video has no captions
to pull. This is the slow road: minutes on the GPU rather than seconds of text,
so nothing calls it unless the fast road found nothing.

Trimmed from Brandon's proven transcribe_media.py: same self-bootstrapping pip
install, same NVIDIA detection, same CUDA library bootstrap with a CPU fallback,
none of its CLI (no srt, no outdir, no flags). A copy rather than a reference on
purpose, so Ledgr never reaches into a personal skills folder and so this works
on any machine that runs the app.

Device and model are automatic:
  - NVIDIA GPU present -> CUDA + large-v3 (fast and most accurate)
  - anything else      -> CPU  + small int8 (slow but it finishes)
Any CUDA failure falls back to CPU rather than erroring out.

Audio decodes through PyAV, which faster-whisper bundles, so NO ffmpeg install
is needed. That is what lets the caller download the audio stream exactly as
YouTube serves it, with no conversion step.

Usage:  py scripts/whisper-transcribe.py AUDIO_FILE
Transcript text goes to stdout; every diagnostic goes to stderr, so the caller
can read stdout as the transcript and nothing else.
"""
import importlib
import os
import shutil
import subprocess
import sys


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def pip_install(pip_name):
    eprint(f"[setup] installing {pip_name} ...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", pip_name]
    )


def ensure_module(mod, pip_name=None):
    try:
        return importlib.import_module(mod)
    except ImportError:
        pip_install(pip_name or mod)
        importlib.invalidate_caches()
        return importlib.import_module(mod)


def has_nvidia():
    if shutil.which("nvidia-smi") is None:
        return False
    try:
        subprocess.run(
            ["nvidia-smi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True
        )
        return True
    except Exception:
        return False


def enable_cuda_libs():
    """Install the pip-provided CUDA 12 libraries (cuBLAS + cuDNN 9) and put them
    where the dynamic loader will look, so CTranslate2 finds them on Windows and
    Linux alike. Without this a machine with a perfectly good GPU falls back to
    the CPU and takes ten times as long."""
    for pip_name, mod in [
        ("nvidia-cublas-cu12", "nvidia.cublas"),
        ("nvidia-cudnn-cu12", "nvidia.cudnn"),
    ]:
        try:
            importlib.import_module(mod)
        except ImportError:
            pip_install(pip_name)
    import nvidia  # noqa: E402

    base = os.path.dirname(nvidia.__file__)
    for sub in ("cublas", "cudnn"):
        libdir = os.path.join(base, sub, "bin" if os.name == "nt" else "lib")
        if os.path.isdir(libdir):
            if os.name == "nt":
                os.add_dll_directory(libdir)
            os.environ["PATH"] = libdir + os.pathsep + os.environ.get("PATH", "")
            os.environ["LD_LIBRARY_PATH"] = libdir + os.pathsep + os.environ.get(
                "LD_LIBRARY_PATH", ""
            )


def main():
    if len(sys.argv) < 2:
        eprint("usage: whisper-transcribe.py AUDIO_FILE")
        sys.exit(2)

    src = os.path.abspath(os.path.expanduser(sys.argv[1]))
    if not os.path.isfile(src):
        eprint(f"ERROR: file not found: {src}")
        sys.exit(2)

    device = "cuda" if has_nvidia() else "cpu"

    def defaults_for(dev):
        return ("large-v3", "float16") if dev == "cuda" else ("small", "int8")

    model, compute_type = defaults_for(device)

    ensure_module("faster_whisper", "faster-whisper")
    if device == "cuda":
        try:
            enable_cuda_libs()
        except Exception as e:
            eprint(f"[setup] CUDA lib setup failed ({e}); falling back to CPU.")
            device = "cpu"
            model, compute_type = defaults_for(device)

    from faster_whisper import WhisperModel  # noqa: E402

    def run(dev, ct, mdl):
        eprint(f"[transcribe] device={dev} model={mdl} compute={ct}")
        m = WhisperModel(mdl, device=dev, compute_type=ct)
        segs, info = m.transcribe(src, vad_filter=True)
        return list(segs), info

    try:
        segments, info = run(device, compute_type, model)
    except Exception as e:
        if device == "cuda":
            eprint(f"[transcribe] CUDA run failed ({e}); retrying on CPU.")
            device = "cpu"
            model, compute_type = defaults_for(device)
            segments, info = run(device, compute_type, model)
        else:
            raise

    lang = getattr(info, "language", "?")
    dur = getattr(info, "duration", 0) or 0
    eprint(f"[done] language={lang} duration={dur:.0f}s device={device} model={model}")

    # stdout is the transcript and nothing else.
    print("".join(s.text for s in segments).strip())


if __name__ == "__main__":
    main()
