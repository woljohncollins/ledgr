"use client";

// A one-line search box for the top of a page (2026-09-20). It does no
// searching itself: Enter hands the words to the full search page
// (/search?q=...), which already owns the query, filters, and saved searches.
// Sits under the title on every saved view and dashboard, so a search is one
// tap from the notes list and from home without reaching for the rail icon.
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SearchBar({
  placeholder = "Search notes…",
  className = "",
}: {
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");

  const go = () => {
    const words = q.trim();
    if (!words) return;
    router.push(`/search?q=${encodeURIComponent(words)}`);
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
      className={className}
    >
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label="Search"
        enterKeyHint="search"
        className="w-full rounded-lg border border-line bg-surface-1 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
      />
    </form>
  );
}
