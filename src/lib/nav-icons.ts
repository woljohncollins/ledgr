// The nav icon library (slice: nav customization, ADR-056). A configurable nav
// slot stores an icon by key; this is the key -> SVG-path-set lookup that
// replaces the hardcoded switch(slot) NavShell used to carry. Paths are
// hand-rolled 24x24 stroke glyphs (no icon-library dependency, Principle 5),
// drawn with the same stroke conventions the rest of the chrome uses.
//
// Both the real nav (NavShell) and the Build-surface preview/picker read this,
// so an unknown or hand-edited icon key always renders *something* (falls back
// to the generic list glyph) rather than a blank or a crash.
import { AI_ICONS } from "@/lib/ai-icons";

export const NAV_ICONS = {
  // Navigation
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>',
  inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M4.5 6.5h15L21 13v6H3v-6l1.5-6.5Z"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  dashboard:
    '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  views: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/>',
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  items: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 3.5"/>',
  starred: '<path d="M12 2l2.9 6.3 6.9.8-5 4.8 1.2 6.9-6-3.3-6 3.3 1.2-6.9-5-4.8 6.9-.8z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1.5"/><path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/>',
  // Content types
  notes: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9"/><path d="M14 3v5h5"/><path d="M14 3l5 5"/><path d="M16 16l2 2 4-4"/>',
  document: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/>',
  meetings: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  links: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  // Box + outbound arrow — "opens the link out"; the outbound-resource glyph the
  // Links widget uses (Tyler, 2026-07-01), distinct from the `links` chain.
  "external-link": '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  people: '<circle cx="9" cy="7" r="4"/><path d="M2 21c0-4 3.1-7 7-7h4c3.9 0 7 3 7 7"/><circle cx="17" cy="9" r="3"/><path d="M20 21c0-2.7-1.5-5-4-6"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>',
  song: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  sermon: '<path d="M12 2v6"/><path d="M5.5 7.5A6.5 6.5 0 0 0 12 20a6.5 6.5 0 0 0 6.5-12.5"/><path d="M9 22h6"/>',
  paper: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8 12h8M8 15h5M8 18h3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  // A document with a checkmarked award badge — the Project type glyph.
  project:
    '<path d="M13 22 H6 a2 2 0 0 1 -2 -2 V7 L9 2 H18 a2 2 0 0 1 2 2 V11"/><path d="M9 2 V7 H4"/><path d="M7.5 11 H12"/><path d="M7.5 14 H11"/><circle cx="17" cy="15" r="4.2"/><path d="M15.2 15 l1.3 1.3 l2.4 -2.9"/><path d="M15.4 18.3 V22 l1.6 -1.3 l1.6 1.3 V18.3"/>',
  // Organization
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5l2-3h6a2 2 0 0 1 2 2z"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  collection: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M6 10V8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  board: '<rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="15" rx="1.5"/>',
  // Equalizer-style sliders — the item canvas "Properties" panel glyph.
  properties: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  // Connected nodes — the "Linked here" backlinks/connections panel glyph.
  affiliate: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M10.6 7.1 6.4 16.9M13.4 7.1 17.6 16.9M7.5 19h9"/>',
  // Tools
  tools: '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.6 4.2l-5.1 5.1a1.5 1.5 0 0 0 2.1 2.1l5.1-5.1a3.5 3.5 0 0 0 4.2-4.6l-2 2-1.7-1.7 2-2Z"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  // Misc
  changelog: '<circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  trophy:
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  // Import/download — an arrow dropping down onto a baseline (the "bring data in"
  // glyph for Build → Import & Migration).
  download: '<path d="M12 3v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/>',
  // Mindmap — a central hub node branching out to spoke nodes (the Mindmap type
  // glyph; distinct from `affiliate`'s peer triangle and the action-menu network).
  mindmap:
    '<circle cx="4.5" cy="12" r="2.5"/><circle cx="18.5" cy="5" r="2"/><circle cx="18.5" cy="12" r="2"/><circle cx="18.5" cy="19" r="2"/><path d="M7 11 16.6 5.7M7 12h9.5M7 13 16.6 18.3"/>',
  // Education set (Tyler, 2026-07-01) — recreated in the house style from a
  // reference sheet: ID card, certificate, assignment, geometry, globe,
  // textbook, backpack.
  "id-card":
    '<rect x="3" y="4" width="18" height="13" rx="2"/><circle cx="8" cy="9.5" r="2"/><path d="M5 15c0-1.9 1.3-3.2 3-3.2s3 1.3 3 3.2"/><path d="M14 9.5h4M14 13h4"/><path d="M6 20.5h12"/>',
  certificate:
    '<rect x="3" y="3" width="18" height="11" rx="1.5"/><path d="M12 7.5h6M12 10.5h6"/><circle cx="8" cy="8.5" r="2.6"/><path d="M6.1 10.6 5.6 20l2.4-1.6 2.4 1.6-.5-9.4"/>',
  assignment:
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 11h5M8 14h3"/><path d="M18.7 12.3 12.2 18.8l-2.4.6.6-2.4 6.5-6.5a1.3 1.3 0 0 1 1.8 1.8z"/>',
  geometry:
    '<path d="M9 5v14h11z"/><path d="M11.2 19v-2.2H9"/><path d="M4.5 6v3.5M4.5 14.5V18"/><path d="M3 7.5 4.5 6 6 7.5M3 16.5 4.5 18 6 16.5"/><path d="M3.4 10.8 5.6 13.2M5.6 10.8 3.4 13.2"/>',
  globe:
    '<circle cx="12" cy="9" r="5.5"/><ellipse cx="12" cy="9" rx="2.4" ry="5.5"/><path d="M6.5 9h11"/><path d="M12 14.5V18"/><path d="M8.5 20.5c0-1.3 1.6-2 3.5-2s3.5.7 3.5 2z"/>',
  textbook:
    '<rect x="4" y="3" width="16" height="13" rx="1.5"/><path d="M8 3v13"/><path d="M5.5 16v2.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  backpack:
    '<path d="M9.5 5.5a2.5 2.5 0 0 1 5 0"/><rect x="5" y="5.5" width="14" height="15.5" rx="4.5"/><path d="M8 21v-5.5a4 4 0 0 1 8 0V21"/><path d="M9.5 14.5h5"/><path d="M5 11c-1.4.3-2 1.2-2 2.6s.6 2.3 2 2.6M19 11c1.4.3 2 1.2 2 2.6s-.6 2.3-2 2.6"/>',
  // Line-art set (Tyler, 2026-07-01) — recreated in the house style from
  // reference images: edit-doc, document-check, folder-open, image, flag-goal,
  // hierarchy, roadmap (a journey with a checkpoint — good for milestones),
  // badge-check, graduation-cap.
  "edit-doc":
    '<path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/><path d="M8 9h6M8 12h4M8 15h3"/><path d="M19 11.5 12.5 18l-2.5.6.6-2.5 6.5-6.5a1.3 1.3 0 0 1 1.9 1.9z"/>',
  "document-check":
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="12" cy="12.5" r="3.2"/><path d="M10.7 12.6l1 1 1.7-2"/>',
  "folder-open":
    '<path d="M4 20a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2"/><path d="M2 20l3-8h18l-3 8z"/>',
  image:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.7"/><path d="M4.5 18l4-5 3 3.5 3.5-4.5 4.5 6"/>',
  "flag-goal":
    '<path d="M6 21V4"/><path d="M6 5h11l-2.5 3.5L17 12H6"/>',
  hierarchy:
    '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/><rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v6.5"/><path d="M6 17v-3.5h12v3.5"/>',
  roadmap:
    '<circle cx="6" cy="5.5" r="2.3"/><path d="M4.8 5.5l.9.9 1.5-1.8"/><path d="M8.3 5.5H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h4.2"/><path d="M12.5 17.5 14.5 19.5 12.5 21.5"/>',
  "badge-check":
    '<circle cx="12" cy="9.5" r="6"/><path d="M9.3 9.5l2 2 3.4-4"/><path d="M8.5 14.8 7 21l5-2.6 5 2.6-1.5-6.2"/>',
  "graduation-cap":
    '<path d="M2 9 12 5l10 4-10 4z"/><path d="M6 11.4V16c0 1.4 2.7 2.8 6 2.8s6-1.4 6-2.8v-4.6"/><path d="M22 9v5.5"/><path d="M22 15.5a1 1 0 0 0-1 1v1.5"/>',
  // Everyday-subject set (Tyler, 2026-08-14) — drawn in the house style to cover
  // the common things a user makes a *type* for, so a new type rarely needs a
  // one-off glyph. Grouped below as Places & Business / Communication /
  // Media & Tech / Life, plus the status marks folded into Tools and Misc.
  //
  // Places & business
  organization:
    '<path d="M3 21V6.5A1.5 1.5 0 0 1 4.5 5h8A1.5 1.5 0 0 1 14 6.5V21"/><path d="M14 11h5.5A1.5 1.5 0 0 1 21 12.5V21"/><path d="M2 21h20"/><path d="M5.5 8.5h1.5M10 8.5h1.5M5.5 12.5h1.5M10 12.5h1.5M16.7 14.5h1.6M16.7 18h1.6"/><path d="M6.8 21v-4.5h3.4V21"/>',
  church:
    '<path d="M12 2v4M10.3 3.7h3.4"/><path d="M6 12.5 12 7l6 5.5"/><path d="M6 12.5V21M18 12.5V21"/><path d="M4 21h16"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  place:
    '<path d="M12 21.5s7-6.7 7-11.5a7 7 0 1 0-14 0c0 4.8 7 11.5 7 11.5z"/><circle cx="12" cy="10" r="2.6"/>',
  briefcase:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3 12h7v2h4v-2h7"/>',
  money:
    '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M5.5 12h.01M18.5 12h.01"/>',
  receipt: '<path d="M6 3h12v18l-3-1.7-3 1.7-3-1.7-3 1.7z"/><path d="M9 8h6M9 12h6M9 15.5h3"/>',
  chart:
    '<rect x="3" y="12" width="4.5" height="9" rx="1.5"/><rect x="9.75" y="7" width="4.5" height="14" rx="1.5"/><rect x="16.5" y="3" width="4.5" height="18" rx="1.5"/>',
  cart: '<circle cx="9.5" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.6 12.1h11.6L21.5 7H6.2"/>',
  package:
    '<path d="M21 8.5 12 3.5 3 8.5v7l9 5 9-5z"/><path d="m3 8.5 9 5 9-5"/><path d="M12 13.5v7"/><path d="m7.5 6 9 5"/>',
  // Communication
  email: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  phone:
    '<path d="M6.5 3h-2A1.5 1.5 0 0 0 3 4.6C3 13 11 21 19.4 21a1.5 1.5 0 0 0 1.6-1.5v-2a1.5 1.5 0 0 0-1.3-1.5l-2.6-.4a1.5 1.5 0 0 0-1.4.6l-1 1.3a13 13 0 0 1-5.2-5.2l1.3-1a1.5 1.5 0 0 0 .6-1.4l-.4-2.6A1.5 1.5 0 0 0 6.5 3z"/>',
  chat:
    '<path d="M4 4h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4.5 3.5V16H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>',
  megaphone:
    '<path d="M3 10.5a2 2 0 0 1 2-2h2.5L16 4v16l-8.5-4.5H5a2 2 0 0 1-2-2z"/><path d="M19 9.5a4 4 0 0 1 0 5"/><path d="M7.5 15.5V19a2 2 0 0 0 3.4 1.4"/>',
  quote:
    '<path d="M8 6.5C5.4 8 4 10.3 4 13.2c0 2.5 1.5 4.3 3.6 4.3 1.8 0 3.1-1.3 3.1-3.1 0-1.7-1.2-3-2.9-3-.4 0-.7 0-1 .2.2-1.4 1-2.5 2.4-3.4z"/><path d="M18 6.5c-2.6 1.5-4 3.8-4 6.7 0 2.5 1.5 4.3 3.6 4.3 1.8 0 3.1-1.3 3.1-3.1 0-1.7-1.2-3-2.9-3-.4 0-.7 0-1 .2.2-1.4 1-2.5 2.4-3.4z"/>',
  // Media & tech
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 13.5 6 3.5V7l-6 3.5z"/>',
  camera:
    '<path d="M4 8h2.8l1.5-2.5h7.4L17.2 8H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><circle cx="12" cy="14" r="3.5"/>',
  mic:
    '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/><path d="M8.5 21.5h7"/>',
  laptop: '<rect x="4" y="4.5" width="16" height="11" rx="1.5"/><path d="M2.5 18.5h19"/>',
  code: '<path d="m8 8-5 4 5 4"/><path d="m16 8 5 4-5 4"/><path d="m13.5 4.5-3 15"/>',
  database:
    '<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>',
  // Life
  car:
    '<path d="M4 12.5 6.3 7.2A2 2 0 0 1 8.1 6h7.8a2 2 0 0 1 1.8 1.2l2.3 5.3"/><path d="M2.5 12.5h19v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z"/><circle cx="7" cy="17.5" r="2.2"/><circle cx="17" cy="17.5" r="2.2"/>',
  plane:
    '<path d="M12 2.5c.9 0 1.6.8 1.6 1.8v5.4l7.4 4.3v2.3l-7.4-2.3V18l2.3 1.7v1.7L12 20.4l-3.9 1V19.7l2.3-1.7v-4l-7.4 2.3V14l7.4-4.3V4.3c0-1 .7-1.8 1.6-1.8z"/>',
  gift:
    '<rect x="2.5" y="8.5" width="19" height="4" rx="1"/><path d="M4.5 12.5V20a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-7.5"/><path d="M12 8.5v13"/><path d="M12 8.5S10.5 3 7.8 3a2.75 2.75 0 0 0 0 5.5H12z"/><path d="M12 8.5S13.5 3 16.2 3a2.75 2.75 0 0 1 0 5.5H12z"/>',
  utensils:
    '<path d="M5.5 3v4.5a3 3 0 0 0 6 0V3"/><path d="M8.5 3v4.5"/><path d="M8.5 10.5V21"/><path d="M18 3c1.6 2.1 2.2 4.5 2.2 7.2 0 2-.9 3.4-2.2 4.2z"/><path d="M18 14.4V21"/>',
  dumbbell: '<path d="M3.5 9v6M6.5 7v10M17.5 7v10M20.5 9v6"/><path d="M6.5 12h11"/>',
  leaf: '<path d="M11 20c-4 0-7-3-7-7 0-6 5-8.5 16-8.5C20 14.5 15 20 11 20z"/><path d="M4.5 20.5 12.5 12.5"/>',
  paw:
    '<ellipse cx="6" cy="10.5" rx="2" ry="2.6"/><ellipse cx="10.2" cy="7" rx="2" ry="2.7"/><ellipse cx="14.8" cy="7" rx="2" ry="2.7"/><ellipse cx="19" cy="10.5" rx="2" ry="2.6"/><path d="M12 13c2.7 0 5 2.1 5 4.5 0 1.9-1.4 3.1-3.2 3.1-.9 0-1.4-.4-1.8-.4s-.9.4-1.8.4C8.4 20.6 7 19.4 7 17.5 7 15.1 9.3 13 12 13z"/>',
  cross: '<path d="M9.5 2h5v4.5h5v4h-5V22h-5V10.5h-5v-4h5z"/>',
  // Status marks + small objects
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  checklist:
    '<path d="m3 6 1.6 1.6L7.5 4.5"/><path d="m3 12.5 1.6 1.6L7.5 11"/><path d="m3 19 1.6 1.6L7.5 17.5"/><path d="M11 6h10M11 12.5h10M11 19h10"/>',
  key: '<circle cx="7.5" cy="16.5" r="4"/><path d="m10.3 13.7 8.2-8.2"/><path d="m15.8 8.2 2.2 2.2"/><path d="m18.5 5.5 2.5 2.5"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><path d="M12 14.5v3"/>',
  shield: '<path d="M12 2.5 4.5 5.5v6c0 4.7 3.1 8.4 7.5 10 4.4-1.6 7.5-5.3 7.5-10v-6z"/>',
  lightbulb:
    '<path d="M12 2.5a6.5 6.5 0 0 0-3.6 11.9c.6.4 1 1.1 1 1.8v.8h5.2v-.8c0-.7.4-1.4 1-1.8A6.5 6.5 0 0 0 12 2.5z"/><path d="M9.4 18.5h5.2"/><path d="M10.4 21h3.2"/>',
  pin: '<path d="M9 2.5h6v2h-1v5l3 3.5v1.5H7v-1.5l3-3.5v-5H9z"/><path d="M12 14.5V21.5"/>',
  paperclip:
    '<path d="M20 11.5 11.3 20.2a5.3 5.3 0 0 1-7.5-7.5l8.7-8.7a3.5 3.5 0 0 1 5 5l-8.7 8.7a1.8 1.8 0 0 1-2.5-2.5l8-8"/>',
  alert:
    '<path d="M10.3 3.8 2.5 17.5a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9.5V14"/><path d="M12 17.3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>',
  sparkle:
    '<path d="M11 2.5 12.9 7.6 18 9.5l-5.1 1.9L11 16.5 9.1 11.4 4 9.5l5.1-1.9z"/><path d="m18 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  // Second everyday pass (Tyler, 2026-08-14) — the gaps left after the set
  // above: agreements, facilities, upkeep, recurrence, weather, health, audio,
  // family, and scripture. A `handshake` was attempted and dropped: no version
  // of two clasped hands stayed legible at 24px in a 1.8 stroke, and `contract`
  // + `store` cover the vendor/partner sense well enough.
  contract:
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 12h8"/><path d="M8 17c1.2-2 2-2 2.6-.6.5 1.2 1.2 1.4 2-.4.7-1.6 1.6-1.6 2.4 0 .4.8 1 1 1.7.5"/>',
  invoice:
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 11.5v7"/><path d="M13.8 12.8h-2.6a1.4 1.4 0 0 0 0 2.8h1.6a1.4 1.4 0 0 1 0 2.8h-2.6"/>',
  store:
    '<path d="M3.5 9.5V19a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5"/><path d="M2.5 9.5 4.2 4.5h15.6l1.7 5a2.6 2.6 0 0 1-4.8 1.4 2.6 2.6 0 0 1-4.7 0 2.6 2.6 0 0 1-4.7 0 2.6 2.6 0 0 1-4.8-1.4z"/><path d="M9.5 20.5v-5.5h5v5.5"/>',
  door: '<path d="M4 21h16"/><path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21"/><circle cx="14.5" cy="12.5" r="1"/>',
  floorplan:
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M10 3v18"/><path d="M10 11h11"/><path d="M3 15h7"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  repeat:
    '<path d="M3.5 10.5A8 8 0 0 1 18 7.5l2.5 2.5"/><path d="M20.5 4.5v5.5H15"/><path d="M20.5 13.5A8 8 0 0 1 6 16.5L3.5 14"/><path d="M3.5 19.5V14H9"/>',
  sun:
    '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>',
  cloud: '<path d="M7 19a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.4 1.6A4 4 0 0 1 17.5 19z"/>',
  plant:
    '<path d="M6 11h12l-1 8.5a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8z"/><path d="M12 11V6.5"/><path d="M12 8.5c0-2.8 2.2-5 5-5 0 2.8-2.2 5-5 5z"/><path d="M12 11C9.2 11 7 8.8 7 6c2.8 0 5 2.2 5 5z"/>',
  pill: '<path d="M10.5 3.5 3.5 10.5a5 5 0 0 0 7 7l7-7a5 5 0 0 0-7-7z"/><path d="m7 7 7 7"/>',
  headphones:
    '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 14.5h2a1.5 1.5 0 0 1 1.5 1.5v2.5A1.5 1.5 0 0 1 6 20h-.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 14.5h-2a1.5 1.5 0 0 0-1.5 1.5v2.5A1.5 1.5 0 0 0 18 20h.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  broadcast:
    '<circle cx="12" cy="12" r="2.2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 15.5a5 5 0 0 0 0-7"/><path d="M5.8 5.8a9 9 0 0 0 0 12.4M18.2 18.2a9 9 0 0 0 0-12.4"/>',
  playlist:
    '<path d="M3 6h11M3 11h11M3 16h6"/><path d="M16 19V8l5-1.2V17"/><circle cx="14.2" cy="19" r="1.8"/><circle cx="19.2" cy="17" r="1.8"/>',
  family:
    '<circle cx="6.5" cy="6" r="2.8"/><circle cx="17.5" cy="6" r="2.8"/><circle cx="12" cy="13.5" r="2.2"/><path d="M2 20v-1.5a4 4 0 0 1 4-4h1"/><path d="M22 20v-1.5a4 4 0 0 0-4-4h-1"/><path d="M8.5 21.5v-1.5a3.5 3.5 0 0 1 7 0v1.5"/>',
  "open-book":
    '<path d="M12 7.5C10.3 6 8 5.2 4 5.2V18c4 0 6.3.8 8 2.3 1.7-1.5 4-2.3 8-2.3V5.2c-4 0-6.3.8-8 2.3z"/><path d="M12 7.5v12.8"/>',
  scripture:
    '<path d="M12 8.2C10.3 6.7 8 5.9 4 5.9v11.6c4 0 6.3.8 8 2.3 1.7-1.5 4-2.3 8-2.3V5.9c-4 0-6.3.8-8 2.3z"/><path d="M12 8.2V19.8"/><path d="M12 2.2v3.7M10.4 3.6h3.2"/>',
} as const;

export type NavIconKey = keyof typeof NAV_ICONS;

// The fallback icon for an unknown/missing key (a generic list glyph). Kept as a
// named constant so callers and tests agree on the fallback.
export const NAV_ICON_FALLBACK: NavIconKey = "items";

// Categorized icon keys for the Build-surface picker (labeled rows). The order
// here is the order the picker shows; every key in NAV_ICONS appears once.
export const NAV_ICON_GROUPS: { label: string; keys: NavIconKey[] }[] = [
  { label: "Navigation", keys: ["home", "inbox", "tasks", "search", "dashboard", "views", "navigation", "items", "recent", "starred", "archive"] },
  { label: "Content", keys: ["notes", "document", "edit-doc", "document-check", "meetings", "links", "external-link", "image", "people", "person", "song", "sermon", "paper", "book", "open-book", "scripture", "bookmark", "project", "mindmap"] },
  { label: "Organization", keys: ["folder", "folder-open", "tag", "collection", "filter", "layers", "grid", "table", "board", "hierarchy", "properties", "affiliate"] },
  { label: "Places & Business", keys: ["organization", "church", "store", "place", "door", "floorplan", "briefcase", "money", "receipt", "invoice", "contract", "chart", "cart", "package"] },
  { label: "Communication", keys: ["email", "phone", "chat", "megaphone", "quote"] },
  { label: "Media & Tech", keys: ["video", "camera", "mic", "headphones", "broadcast", "playlist", "laptop", "code", "database"] },
  { label: "Life", keys: ["car", "plane", "gift", "utensils", "dumbbell", "leaf", "plant", "paw", "family", "pill", "sun", "cloud", "cross"] },
  { label: "Education", keys: ["id-card", "certificate", "assignment", "geometry", "globe", "textbook", "backpack", "graduation-cap"] },
  { label: "Tools", keys: ["tools", "bolt", "flag", "flag-goal", "roadmap", "badge-check", "bell", "download", "gear", "repeat", "key", "lock", "shield", "lightbulb", "pin", "paperclip"] },
  { label: "Misc", keys: ["changelog", "calendar", "compass", "target", "heart", "trophy", "check", "checklist", "alert", "info", "sparkle"] },
];

// Whether a string is a known icon key.
export function isNavIcon(key: unknown): key is NavIconKey {
  return typeof key === "string" && key in NAV_ICONS;
}

// --- The licensed AI-agent set: a SEPARATE filled family (src/lib/ai-icons.ts).
// Selected/stored as "ai:<name>" so its keyspace never collides with the stroke
// glyphs above and the renderer knows to fill (not stroke) at the 64px viewBox.
export const AI_ICON_PREFIX = "ai:";

export function isAiIconRef(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.startsWith(AI_ICON_PREFIX) &&
    Object.prototype.hasOwnProperty.call(AI_ICONS, key.slice(AI_ICON_PREFIX.length))
  );
}

// The filled path markup for an "ai:<name>" ref, or null if unknown.
export function aiIconPaths(ref: string): string | null {
  const name = ref.slice(AI_ICON_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(AI_ICONS, name) ? AI_ICONS[name] : null;
}

// Any valid STORED icon reference — a stroke-glyph key OR an "ai:" filled ref.
// Sanitizers use this (instead of isNavIcon alone) so an AI-set selection isn't
// reset to the fallback when a type/nav-slot/dashboard icon is read back.
export function isIconRef(key: unknown): key is string {
  return isNavIcon(key) || isAiIconRef(key);
}

// The path-set for a key, falling back to the generic list glyph for anything
// unknown. The single resolution point both the renderer and the picker use.
export function navIconPaths(key: string): string {
  return isNavIcon(key) ? NAV_ICONS[key] : NAV_ICONS[NAV_ICON_FALLBACK];
}

// Render any icon into a standalone <svg> string (for non-React surfaces such as
// the print/share document, should they ever need a nav glyph). React surfaces
// use the <Icon> component in NavShell, which reads navIconPaths directly.
export function navIconSvg(key: string, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${navIconPaths(key)}</svg>`;
}
