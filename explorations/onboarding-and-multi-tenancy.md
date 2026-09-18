# Making Ledgr easy to set up (and the multi-tenancy question underneath it)

**Status:** exploration, not a decision. Started by Tyler + Claude, 2026-08-14, for discussion with Brandon. §9–§10 added 2026-08-15 (business model + uniqueness).
**Trigger:** standing up instances for Michelle and Miles. Setting up Michelle's took a written guide with 4 account signups and 8 steps, which is fine for a builder and impossible for anyone else.
**Nothing here is agreed.** The multi-tenancy half is core (Principle 7, `schema.md`, owner-scoping) and would need both-agree + an ADR. The quick-wins half is not core and could start whenever.

---

## 1. The problem, measured

What it currently takes to give one person a Ledgr, from `~/Downloads/ledgr-setup-for-michelle.md`:

- **4 account signups:** GitHub, Neon, Clerk, Vercel
- **8 numbered steps**, several strictly ordered (migrate before first sign-in, or the app looks broken)
- **~10 environment variables**, two of which are secrets pasted by hand
- **A terminal**, Node 20+, `npm install`
- **A build-command override** (`npm run build:satellite`)
- **A fine-grained GitHub PAT** with Contents: read+write, scoped to their fork

Plus failure modes that are invisible when you hit them:

- The sign-in email must match the seeded owner row **exactly, case-sensitively** (`eq(users.email, authUser.email)`, no normalization). Miss it and you get "Signed in, but not recognized."
- The Neon string must be the **pooler** one.
- A missing Clerk key on a deployed instance is a hard **503**, not a partial page.
- Any commit on their fork's `main` breaks fast-forward and silently drifts the fork.

**This is a developer onboarding.** Better docs cannot fix it; the cost is structural.

---

## 2. Where the cost actually comes from

One choice: **Principle 7, "multi-user-ready, not multi-user."** One instance per person, each with its own database, auth app, and deploy.

That choice bought real things and they still hold:

- **Physical data isolation.** Brandon's pastoral notes are in a database that literally contains nobody else's data.
- **Sunday-proof independence.** One instance breaking cannot take out another.
- **No permissions model to build**, which is a large amount of product surface avoided.
- **Free tier per person**, ~$0/month each.

And it is the direct cause of every one of the four signups. The four accounts are not incidental complexity; they *are* the architecture, showing through.

---

## 3. The finding that reframes this

Auditing `src/db/schema.ts`: **16 of 20 tables already carry `owner_id`.** Only four do not.

| Table | Why it's global | Blocker? |
|---|---|---|
| `types` | `key` is the primary key; no `owner_id` at all | **Yes.** User-editable and shared. One person renaming a type, adding a property, or setting `default_widgets` would change it for everyone. |
| `relations` | links two items | No. Both endpoints are owner-scoped items, so isolation is transitive. Needs review, not redesign. |
| `itemRelatedness` | derived cache over items | No. Same transitive story. |
| `errorLog` | operational | No. Legitimately instance-level. |

So multi-tenancy is closer to **one hard table plus a change in security posture** than to a rewrite. That is a much smaller number than it felt like before looking.

Not free, though. Also per-user in a shared deploy, and currently per-*instance* env vars:

- Microsoft Graph tenant/client secret, mailbox UPN
- R2 bucket and credentials
- Todoist token, AssemblyAI key
- Timezone (already per-user in `users.settings`, so there is precedent for the move)

Each of those would become a row rather than an env var.

---

## 4. The part that deserves the most weight

Today, a query that forgets `owner_id` leaks nothing, because there is only one person's data in the database. In a shared deploy, **that same bug is a breach.** The invariant is unchanged; the consequence of breaking it is not.

This directly reopens a decision already made: **ADR-075 declined a confidential tier for pastoral content, on the reasoning that platform security was sufficient.** That reasoning was sound *because* single-tenancy made it true. In a shared database it no longer is, and ADR-075 would have to be re-argued rather than assumed.

Brandon holds the confidential pastoral content. This is more his call than anyone's.

---

## 5. Options

### A. Automate provisioning, keep single-tenant

A `npx create-ledgr` that drives the Neon, Vercel, and GitHub APIs to provision everything.

- **For:** architecture untouched; isolation and ADR-075 hold; each person still owns their data.
- **Against:** the user still needs accounts and API tokens for several services, which is most of the pain. Clerk application creation may not even be programmatic on the free tier (unverified). Automating a 4-account setup still leaves a 4-account setup.
- **Read:** helps builders, does not reach "average user."

### B. Hosted multi-tenant

One deployment, one database, many users. Setup becomes: sign up.

- **For:** eliminates the problem completely rather than reducing it. Cheaper in total (one Neon, one Vercel, one Clerk). `owner_id` groundwork is largely done — that was the point of Principle 7's "ready."
- **Against:** contradicts Principle 7 as written; needs `types` owner-scoped; reopens ADR-075; isolation becomes a property we enforce rather than one physics enforces; somebody becomes the operator, on the hook for uptime, backups, and other people's data.
- **Read:** the only option that genuinely reaches "average user."

### C. Hybrid: hosted for normal users, self-host for power users

The conventional answer. Hosted instance for whoever wants it; the fork route stays for anyone who wants their own.

- **For:** does not force one answer; Brandon could stay single-tenant permanently while others share a hosted instance.
- **Against:** two deployment shapes to keep working, which is the most expensive option in maintenance even though each half is understood.

### D. Cut the number of services, stay single-tenant

Attack the signups directly rather than the architecture. See §6 — this is mostly already possible.

- **For:** no core change, no ADR, could start immediately.
- **Against:** floor of "one Vercel account + a deploy" — very good, not quite "sign up and go."

---

## 6. Worth doing regardless of which option wins

None of these need the big decision. All of them shorten the guide today.

1. **First sign-in claims the instance.** When there is no owner row, the first authenticated user becomes the owner. Kills the exact-email-match trap and the ADR-184 "Signed in, but not recognized" dead end in one move, and deletes a whole provisioning step. **Best value-to-effort on this list.**
2. **Remove the separate Clerk account.** The auth provider interface already exists for exactly this — it was built so a local single-user mode could stand in (CLAUDE.md, provider-interface discipline). A "solo" adapter would remove the single biggest signup.
3. **Deploy button + Neon via Vercel Marketplace.** Collapses several signups into one and sets `DATABASE_URL` automatically.
4. **`npm run build:satellite` as the default for new instances.** Built 2026-08-14 (ADR-194). Makes migrate-on-deploy the norm for anyone who is not a builder, so schema and code cannot drift apart.
5. **A `/setup` page** that inspects config and names what is missing, instead of a 503 or a nav-less scaffold.

Rough shape: **items 1–5 take Michelle's guide from 8 steps to about 2, without touching the architecture.** That may be enough, and it is worth finding out before deciding anything larger.

---

## 7. The question under the technical question

"Too complicated for the average user" implies Ledgr becomes something other people use. Today it is explicitly a personal system for a handful of known people, and that framing is load-bearing in a lot of decisions (ADR-075, Principle 7, no permissions UI, no invitations).

Worth answering before optimizing:

- **Who is the average user?** Family and friends we set up by hand (Michelle, Miles), or strangers who sign up?
- **If strangers: who operates it?** Uptime, backups, someone else's data, and a support burden that lands on whoever's name is on it.
- **Does Brandon want his instance to stay separate regardless?** A defensible answer that costs nothing, and it makes option C the natural shape.

The technical work follows from these. The reverse does not.

---

## 8. Where Tyler and Claude landed (opening position, not a conclusion)

- Do §6 items 1–5 now. They are not core, they help every option, and item 1 removes the most common failure outright.
- Then re-measure. Two steps may be good enough, which would make the architecture question moot for a long time.
- Treat option B as genuinely open rather than blocked. The schema is closer to ready than it felt, and the honest obstacles are `types` and ADR-075, not the data model at large.
- Answer §7 before committing to B or C, because the operator question is a bigger commitment than the code.

**For Brandon:** §4 and §7 are the parts where your answer changes the plan. The rest is legwork either way.

---

## 9. The business-model layer (added 2026-08-15)

New inputs from Tyler, on top of the setup question:

- **Self-hosting on our own hardware.** Brandon and Tyler are discussing hosting Ledgr on their own server (currently a PC with a lot of disk). That may be where hosting-for-others starts. Note this rhymes with `local-p2p-sync.md` (cloud demoted to one always-on peer) and leans directly on the provider-interface discipline — storage/auth/scheduler behind interfaces was built so a non-Vercel deployment is a packaging exercise, not a rewrite.
- **Two-tier model.** (1) **Free self-setup:** people technical enough to make their own Vercel/Neon/Clerk accounts run their own instance, exactly like today but with §6 smoothing. (2) **Hosted, paid:** an Evernote-style model where people sign up for an account we host, for a small monthly/yearly price. This is option C from §5 with pricing attached.
- **Positioning as Tyler frames it:** part note graph database (Evernote/Obsidian), part productivity tool (Todoist/Basecamp), still shape-customizable (users create their own types, like Coda/Notion) *without* requiring them to build databases.
- **Honest status:** beta. Small bugs remain, a handful of features still to add (though not many). Charging money is premature until that changes.

A self-host server opens a **fifth deployment shape** worth naming: N *single-tenant* instances on one box (one Postgres server with a database per person, one app container per person, Caddy/Traefik in front). It keeps Principle 7 and physics-enforced isolation intact — no `types` migration, no ADR-075 re-argument — while making "we host it for you" true. It trades that for ops on our hardware: residential internet, one power cord, backups on us. Fine for friends/family; not what you sell to strangers with an uptime expectation.

Sequencing that follows from "it's a beta": don't charge anyone yet. Charging converts a hobby into obligations (support, uptime, other people's data, terms of service, a billing entity). A free friends-and-family hosted tier answers §7's "who is the average user" question empirically before any of that is taken on.

## 10. Is Ledgr actually unique? (researched 2026-08-15)

The uncomfortable finding first: **"typed objects instead of databases" is not unique.** Capacities is exactly that pitch (object-centric, every note is a typed object with properties and a body), Anytype is the local-first/encrypted version of the same idea, and Tana's supertags are the power-user version. The "AI can reach into your notes" angle is also filling fast: Tana ships MCP-connected AI chat at the center of the product, Reflect has an MCP beta, and "MCP-first PKM" is now a genre with its own comparison posts.

What Ledgr genuinely has that the named competitors don't, in rough order of defensibility:

1. **Markdown-canonical with a one-way file export.** Capacities and Tana are walled clouds; Obsidian has the files but not the structured app. "Your data is markdown you can walk away with, *and* it's a real app" is a real position.
2. **Bespoke canvases per content type** (sermons, chord charts, papers with footnotes and `.docx` export, meetings wired to M365). Horizontal tools make you build these; Ledgr ships them. This is vertical depth, and verticals are where small products win.
3. **MCP depth.** ~36 tools plus a served user guide is deeper than the MCP betas shipping elsewhere — a lead measured in months, not a moat.
4. **Self-hostable at ~$0** on free tiers, or on your own box.

So the honest answer to "unique enough for the market": **as a horizontal notes+tasks product, no** — that market is crowded with funded, polished incumbents. **As a tool for a specific kind of person** (ministry staff being the proven case: the sermon/song/passage/meeting modules exist because a working pastor needed them), yes, there is a real wedge no incumbent serves. "People in our lives" and "people like Brandon" may be the same market, and it's one nobody else is building for.

### 10a. Tyler's refinement: the fused combination doesn't exist (2026-08-15)

Tyler's pushback on the above: typed-object *notes* exist, but has anyone shipped a **complete productivity tool fused with a note graph** — not "you could build one"? Checked, and he's right. The market splits into three camps, none of which is Ledgr:

1. **Note-graph tools with deliberately no task manager.** Capacities' own positioning is "we eliminated task management; pair us with Todoist" — the pairing is the officially recommended architecture. Obsidian, Anytype, Reflect are variations of the same story (plugins or a second app).
2. **Build-it-yourself workspaces** (Notion, Coda, Tana, Fibery). You *can* assemble a task system from databases/supertags, but nobody ships one, and the assembled version hits a ceiling: no real recurrence engine (Notion cannot express "one item with a per-date completion log," ADR-073/T1's model), no ICS feed, no native reminders. This is Tyler's point that competitors are really "services you could build our tool on top of."
3. **Pure task managers** (Todoist, Things, TickTick, Motion) with no knowledge layer at all.

Ledgr ships both halves natively — a Todoist-grade task manager (recurrence log, subtask rollups, focus layer, calendar/ICS) where the tasks are *nodes in the same typed graph* as notes, meetings, people, and passages. The strongest evidence the gap is real: **Ledgr itself ran the camp-1 pairing (Todoist alongside) and abandoned it as inadequate — that's what ADR-073 was.** We are our own existence proof.

### 10b. The ministry vertical, taken seriously (Tyler, 2026-08-15)

Tyler: "pastor-type software definitely doesn't exist — ministry is always underserved because it doesn't have the margins." Assessment: correct, and the existing church-software market proves the gap rather than filling it. What exists is **church ops** (Planning Center, Breeze, Tithely — org-level ChMS, giving, service planning), **study** (Logos), and **single-task tools** (Sermonary for sermon writing). Nothing is the *minister's personal work OS*: sermon pipeline + pastoral care notes + meetings + people + passages as first-class related objects. That seat is empty.

Two honest caveats. (1) Small margins cut both ways: pastors *do* pay for Logos, Planning Center, and Sermonary, so a small personal subscription is within a book-allowance budget — but this is a lifestyle-business-sized market, not a venture-sized one. That fits how we're building anyway. (2) The confidential-tier question (ADR-075) gets *heavier* in this vertical, since pastoral care notes are the sensitive core of the use case; any hosted-for-pastors offering reopens it with force.

---

## 11. From beta to company (Tyler's question, 2026-08-15)

The question: if the beta runs self-hosted for friends/family, what does it take to scale to real customers — strangers who pay? This has a known shape (Ghost, Plausible, Cal.com all ran it: open/self-hostable core + paid hosted service), and it phases cleanly. Nothing in phases 1–3 needs to start until its trigger fires.

**Phase 0 — now (beta, free, known people).** Ship §6 items 1–5. Stand up the friends/family box (§9's N-single-tenant-instances shape). No entity, no terms, no billing — free use by people we know creates none of those obligations. What this phase is *for*: measuring the support burden and learning which features strangers would trip on.

**Phase 1 — the first dollar (entity + legal).** Triggered by charging anyone, even $1.
- **LLC, two members.** Decide the Tyler/Brandon split and write the operating agreement *now, while it's friendly and worth nothing* — two-founder splits decided late are how partnerships die. Illinois filing is ~$150 + $75/yr.
- **Terms of Service + Privacy Policy.** Non-optional given the data (pastoral care notes are among the most sensitive consumer data there is).
- **The name.** "Ledgr" likely collides with Ledger (the hardware-wallet company has aggressive trademarks) and the accounting-software genre. Check before printing it on anything; a rename is cheap now and expensive later.
- **The license.** The repo is public with **no LICENSE file**, which legally means all-rights-reserved: source-visible, but nobody may run it. The free self-host tier *requires* picking a real license. The proven pattern for our two-tier model is source-available or open-core (AGPL like Cal.com, or a Fair-Source/BSL-style license that permits self-hosting but not competing hosting). This is a both-agree decision.
- Stripe for billing; liability/cyber insurance once revenue is real.

**Phase 2 — the first stranger (infrastructure + operations).** Triggered by a customer we don't know.
- **Off the home PC.** Residential internet and one power cord are fine for friends, not for paying strangers. Managed infra (Vercel/Neon paid tiers, or a VPS fleet) with real backups and monitoring.
- **A control plane.** The actual engineering between beta and company: signup → provision a database → migrate → seed owner → subdomain → welcome email, unattended. The 2026-08-14 self-update work (instances report their version and update themselves, commit 3fbe738) is already control-plane groundwork.
- **Tenancy decision, for real this time.** DB-per-customer keeps Principle 7's physics (Neon makes project-per-tenant workable; one Postgres cluster with a database per customer also works) vs. true multi-tenant (owner-scope `types`, re-argue ADR-075). Managed-single-tenant is the likelier fit: it's what we already are, automated.
- **Operations identity:** support email, status page, uptime expectations, a security posture we can say out loud (the ADR-075 revisit probably lands here, possibly as encryption-at-rest for care notes — which doubles as marketing, §12).

**Phase 3 — go-to-market.** §12.

The meta-point: **becoming a company is the largest both-agree item in the project's history.** It touches Brandon's employment, his data, his name, and every core invariant. Nothing past Phase 0 moves without that conversation, and Phase 1's operating agreement *is* that conversation, formalized.

**Brandon's involvement is a spectrum, not a switch (Tyler, 2026-08-15).** Full partner, minority partner, advisor-plus-key-customer, or just the user the product was born from — all fine, and the relationship is good enough that any of them works. The paperwork isn't there because the relationship needs protecting; it's there so the *company* is sellable/investable/insurable later regardless of which point on the spectrum he picks. Whatever he chooses, the Phase 1 conversation memorializes it:

- **Copyright doesn't follow the fork.** With no license and two contributors, Brandon owns the copyright in everything he wrote, forever, in every fork. Commercializing a fork without his written consent would mean selling code he co-owns. So whichever way he goes, the Phase 1 conversation has to produce either an operating agreement (he's in) or an IP assignment / broad license grant (he's out). Same meeting, two possible documents.
- **The founding story survives his exit** — "built with a working Executive Pastor who still runs his whole ministry in it" is arguably a *cleaner* pitch than co-founder — but using his name and story in marketing needs his blessing in writing either way.
- **The advisor role can be real, not vibes:** a simple advisor agreement (small equity or a free-forever hosted instance plus a say in the roadmap) keeps his ministry-practitioner input flowing, which is the product's actual moat (§10b).

## 12. Marketing, starting in the church market (Tyler, 2026-08-15)

The church market is a **trust market, not an ads market**: pastors buy what pastors they respect use. That's bad news for growth hacking and good news for us, because the one asset money can't buy — a real Executive Pastor running his entire ministry in the product — is the founding story.

**Positioning: sell the week, not the database.** Never market "typed object graph with fused task management." Market outcomes in the buyer's language: "your sermon prep, care visits, meetings, and to-dos in one place," "Sunday-proof — your sermon works when the wifi doesn't," "never lose the thread on someone you're shepherding." The graph is *why it works*, not the pitch.

**The channel plan, in order of leverage:**
1. **Word of mouth through real networks.** Pastors cluster: denominational gatherings, regional associations, pastor breakfasts. Seed 10–20 pastors Brandon and Tyler actually know with free accounts and hand-holding; their testimony is the launch asset. (This doubles as the strangers-adjacent beta cohort.)
2. **Content marketing from Brandon's real practice.** "How I prep a sermon," "how I track pastoral care without dropping anyone," "my Monday review" — blog posts and screen-recorded walkthroughs of the *actual* workflow. Church-leadership content has a huge established audience (the Carey Nieuwhof / ChurchLeaders ecosystem) hungry for exactly this, and it compounds.
3. **Communities where church-tech buyers already are:** Church IT Network, the big church-communications Facebook groups, r/pastors, Planning Center and Logos user communities (people already paying for ministry software are the qualified list).
4. **Podcast guesting > conference booths.** Church-leadership podcasts take guests with a story ("Executive Pastor builds his own tool") cheaply; booths are expensive and slow.
5. **Goodwill pricing as seeding:** free for church planters and missionaries. Costs little, generates the exact word-of-mouth this market runs on, and is the right instinct anyway.

**Pricing sketch:** ~$8–12/mo or ~$99/yr personal, expensable against a book/software allowance (the Logos/Sermonary precedent). Church-staff multi-seat later, not at launch.

**Privacy as a feature, not a footnote.** In this vertical, "your care notes live in a database that contains only your data, and you can export everything as markdown and leave" is a differentiator no incumbent can say. The ADR-075 revisit, whatever it decides, should be written up as a public trust page eventually.
