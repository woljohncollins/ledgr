// GET /api/contacts/search?q=jo → matches from the owner's Outlook contacts
// directory (bridge-exported; see src/lib/contacts-directory.ts). Read-only.
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { bestPhone, loadDirectory, searchContacts } from "@/lib/contacts-directory";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 80);
  const { contacts, exportedAt } = await loadDirectory(owner.id);
  const hits = searchContacts(contacts, q).map((c) => ({
    id: c.id,
    name: c.name,
    email: c.emails[0] ?? null,
    phone: bestPhone(c) ?? null,
    company: c.company ?? null,
    title: c.title ?? null,
    city: c.city ?? null,
  }));
  return NextResponse.json({ total: contacts.length, exportedAt, hits });
}
