import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { forgetInstall, listInstalls, renameInstall } from "@/lib/installs";
import { labelProblem } from "@/lib/installs-plan";

export const dynamic = "force-dynamic";

// The roster (ADR-220): every copy of Ledgr this owner runs.
//
//   GET                          the roster, as this copy sees it
//   PATCH  {id, label}           rename any copy, from any copy
//   DELETE {id}                  forget a copy that is gone for good
//
// Renaming from anywhere is deliberate and was asked for: a machine is named
// once when it is set up, and the owner must be able to correct that later
// without walking to it. A label is a display name, so the worst a concurrent
// edit can do is flip which name wins.
export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json({ installs: await listInstalls(owner.id) });
}

export async function PATCH(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as { id?: unknown; label?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "which copy?" }, { status: 400 });
    }
    if (typeof body.label !== "string") {
      return NextResponse.json({ error: "label must be text" }, { status: 400 });
    }
    const problem = labelProblem(body.label);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const install = await renameInstall(owner.id, body.id, body.label);
    if (!install) {
      return NextResponse.json({ error: "that copy is not in the list" }, { status: 404 });
    }
    return NextResponse.json({ install });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "which copy?" }, { status: 400 });
    }
    if (!(await forgetInstall(owner.id, body.id))) {
      // Removing your own row would make the roster lie about the machine you
      // are looking at, and the next daily announce would recreate it anyway.
      return NextResponse.json(
        { error: "This is the copy you are using, so it cannot be removed from the list." },
        { status: 409 }
      );
    }
    return NextResponse.json({ installs: await listInstalls(owner.id) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
