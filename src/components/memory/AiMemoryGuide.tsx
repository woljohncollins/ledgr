// The AI Memory explainer (ADR-137): the thinking + strategy behind the feature
// and how to use it well in any LLM. Plain presentational JSX (no "use client",
// no server-only imports) so it can be rendered both inside the client
// "Learn more" modal (SettingsForm) and directly on the Build → AI Memory page.
// Same content, one source. Typographic punctuation avoids the unescaped-entity
// lint rule.

// The copy-paste stanza the owner pastes into each AI's custom-instructions slot
// (mirrors docs/ai-memory.md). Exported so the modal can offer a copy button.
export const MEMORY_INSTRUCTION_STANZA = `## Ledgr memory
I keep my durable memories in Ledgr, reachable through its MCP server.
- At the start of a session, call get_memory_stumps and read the
  ledgr://guide/memory-protocol resource. That call returns only my pinned
  memories, the standing rules you need every run. Everything else is on demand:
  when a person, project or system comes up that you don't know, search_items for
  it by name with type: "memory". A stump is a pointer — pull the memory (and
  follow its links) only when it's relevant to what we're doing.
- When you learn something durable and worth carrying forward — a working
  preference, a fact about a person, a project decision — file it with remember (a
  self-contained title, detail in the body, set kind + horizon, link the
  people/projects it's about). Save memories to Ledgr, not to a local file or your
  own memory.`;

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-5 text-sm font-semibold text-neutral-100">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{children}</p>;
}

export default function AiMemoryGuide() {
  return (
    <div className="text-neutral-300">
      <p className="text-sm leading-relaxed text-neutral-400">
        AI Memory lets an assistant keep durable notes about you and your work
        <em className="text-neutral-300"> in Ledgr</em> — your database, your export,
        your backup — instead of a single AI vendor&rsquo;s private memory. It stays
        yours, and it works the same from any AI that can connect. Here&rsquo;s the
        idea and how to get the most from it.
      </p>

      <H>Two layers: stumps and depth</H>
      <P>
        Each memory is a short <strong className="text-neutral-200">stump</strong> (a
        one-line reminder) with optional detail behind it. Your assistant loads just
        the stumps at the start of a session — a small, cheap index — so it
        <em> knows what exists</em> without carrying every detail. It only opens a
        memory&rsquo;s full text when that stump is actually relevant to what
        you&rsquo;re doing. Awareness is cheap; depth is on demand.
      </P>

      <H>The links are the point</H>
      <P>
        A memory is connected to the people, projects, and notes it&rsquo;s about. So
        when you mention someone, the assistant can step from a memory about them
        into everything else related to them — surfacing context you didn&rsquo;t
        think to bring up. That web of connections is what makes recall feel like it
        genuinely knows your world, not just a flat list of facts.
      </P>

      <H>What keeps a memory &ldquo;always on&rdquo;</H>
      <P>
        One dial, and only one: <strong className="text-neutral-200">Pin</strong>. A
        pinned memory loads on every single run; nothing else does. Reserve it for
        standing rules the assistant needs cold and could never find by searching, and
        keep the pinned list short. Everything unpinned is reached on demand, by
        searching the person, project or system you are working on.
      </P>
      <P>
        The other two labels describe the memory, they do not decide what loads.
        {" "}<strong className="text-neutral-200">Kind</strong> says what it is about
        (who you are, how to work with you, a project, a reference).
        {" "}<strong className="text-neutral-200">Horizon</strong> says whether it stays
        true: <em>evergreen</em> indefinitely, <em>seasonal</em> for a while,
        {" "}<em>episodic</em> for one moment. Old seasonal and episodic memories are
        marked stale rather than deleted, so &ldquo;this was true once&rdquo; is never
        lost.
      </P>

      <H>Recall is judged, not dumped</H>
      <P>
        When a memory is relevant, the assistant follows its links outward — but with
        a rising bar: the first hop is cheap, each hop further out needs a better
        reason, and it stops when the trail stops helping. A rich thread can run deep;
        a cold one is dropped early. You get useful serendipity without a flood of
        loosely-related detail.
      </P>

      <H>Using it well in your AI of choice</H>
      <P>
        Three steps, once per AI you connect:
      </P>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-neutral-400">
        <li>
          Turn on the toggle here, then connect your AI to Ledgr over MCP — the
          endpoint and steps are in <span className="text-neutral-300">Build → AI &amp; MCP</span>.
        </li>
        <li>
          Paste the short instruction below into your AI&rsquo;s custom-instructions /
          system-prompt slot (for Claude Code that&rsquo;s <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">~/.claude/CLAUDE.md</code>;
          for claude.ai or another provider, its personal-instructions box). This is
          the one manual step — connecting the tools doesn&rsquo;t force an assistant
          to <em>use</em> them each session, so this note tells it to.
        </li>
        <li>
          Then just talk. Say &ldquo;remember that&hellip;&rdquo; and it files a memory;
          it recalls on its own when something&rsquo;s relevant. Tip: prefer letting it
          <em> link</em> a memory to a person or project over restating what Ledgr
          already holds — the links are where the value compounds.
        </li>
      </ol>

      <P>
        <strong className="text-neutral-200">The instruction to paste</strong> (also in{" "}
        <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">docs/ai-memory.md</code>):
      </P>
      <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-300 whitespace-pre-wrap">
        {MEMORY_INSTRUCTION_STANZA}
      </pre>

      <P>
        Because these are ordinary Ledgr items, your memories ride the OneDrive export
        and the weekly backup, and any MCP-speaking AI can read them. Switch AI vendors
        later and you re-paste the note above into the new one — the memory itself never
        moved.
      </P>
    </div>
  );
}
