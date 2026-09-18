// A link that knows what a browser will actually do with it (Tyler,
// 2026-08-20). Normal URLs render as a plain new-tab anchor. A `file://` URL
// CANNOT be opened from a web page — every browser blocks the navigation as a
// security rule, so the click silently did nothing — but the link is still
// useful: clicking now copies it to the clipboard (toast says so), ready to
// paste into the address bar or Finder → Go. One shared rule, so every
// surface that renders an item's URL treats local files the same way.
"use client";

import { showToast } from "@/components/ui/ActionToast";

export function isLocalFileUrl(url: string): boolean {
  return /^file:/i.test(url.trim());
}

export default function SmartHref({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  if (!isLocalFileUrl(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      title={`${href}\nClick to copy — browsers can't open local files from a web page`}
      className={`text-left ${className ?? ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(href);
          showToast("Local file link copied — paste it into the address bar");
        } catch {
          showToast("Couldn't copy the link");
        }
      }}
    >
      {children}
    </button>
  );
}
