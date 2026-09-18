import { NextResponse } from "next/server";

// The JSON 404 for anything under /api/machine that no real route claims
// (ADR-262).
//
// Without it an unmatched machine path falls through to the Next.js page tree
// and answers with the app's HTML shell. To a browser that is a tidy not-found
// page; to a script it is a catastrophe, because HTML is not JSON and the status
// does not say so loudly enough — `GET /api/machine/items/<uuid>` before the
// per-item route existed returned a 200 carrying a web page, and every client
// that didn't sniff the content type read that as a successful item fetch. A
// wrong answer that looks like a right one costs more than an error.
//
// Static and dynamic segments both beat a catch-all in Next.js routing, so this
// only ever runs for paths nothing else matches. It answers every method, and
// deliberately does not authenticate: "this endpoint does not exist" is not a
// secret, and a 401 here would send a caller hunting for a credential problem
// that isn't there.
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

type Context = { params: Promise<{ unmatched: string[] }> };

async function notFound(request: Request, context: Context) {
  const path = (await context.params).unmatched.join("/");
  const res = NextResponse.json(
    {
      error: `no such endpoint: ${request.method} /api/machine/${path}`,
      // Pointing at the index is cheap here and saves the guess-a-URL loop that
      // produced this request in the first place.
      hint: "GET /api/machine/items lists items; GET /api/machine/items/<uuid> reads one. See Build -> API for the full set.",
    },
    { status: 404 }
  );
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export const GET = notFound;
export const POST = notFound;
export const PATCH = notFound;
export const PUT = notFound;
export const DELETE = notFound;

export function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}
