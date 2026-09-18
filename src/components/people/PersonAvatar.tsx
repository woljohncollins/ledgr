// A person's avatar circle (Tyler, 2026-08-18 — ADR-202 addendum 3): the face
// from the person type's built-in Image property when it has one, else the
// caller's chosen fallback — initials (project cards' people row, where the
// lettered circles predate this) or the person glyph (chips and other compact
// spots). Client component only for the onError fallback: a dead image URL
// degrades to the fallback instead of a broken-image icon.
"use client";

import { useState } from "react";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "")).toUpperCase();
}

export default function PersonAvatar({
  src,
  name,
  size = 24,
  fallback = "icon",
  className = "",
}: {
  src: string | null;
  name: string;
  size?: number; // px
  fallback?: "initials" | "icon";
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const label = name || "Untitled";
  if (src && !broken) {
    return (
      // Plain <img>, not next/image: the URL is owner-supplied and can point at
      // any host, which next/image would refuse without a domains allowlist.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={label}
        title={label}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full border border-neutral-900 object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  if (fallback === "initials") {
    return (
      <span
        title={label}
        className={`flex shrink-0 items-center justify-center rounded-full border border-neutral-900 bg-neutral-700 font-medium text-neutral-200 ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      >
        {initials(label)}
      </span>
    );
  }
  return (
    <span
      title={label}
      className={`flex shrink-0 items-center justify-center rounded-full text-neutral-500 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ width: Math.round(size * 0.75), height: Math.round(size * 0.75) }}
      >
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </svg>
    </span>
  );
}
