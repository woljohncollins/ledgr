// Canonical order (1-66) of the Bible book a passage string starts with, so
// sermon notes can sort by book (John, 2026-11-17). Forgiving of the common
// abbreviations he types ("Heb 11", "1 Pet 3:13", "Ps 34", "Matt 5").
const BOOKS: [number, string[]][] = [
  [1, ["genesis", "gen"]], [2, ["exodus", "ex", "exod"]], [3, ["leviticus", "lev"]], [4, ["numbers", "num"]],
  [5, ["deuteronomy", "deut", "dt"]], [6, ["joshua", "josh"]], [7, ["judges", "judg"]], [8, ["ruth"]],
  [9, ["1 samuel", "1 sam"]], [10, ["2 samuel", "2 sam"]], [11, ["1 kings", "1 kgs"]], [12, ["2 kings", "2 kgs"]],
  [13, ["1 chronicles", "1 chron", "1 chr"]], [14, ["2 chronicles", "2 chron", "2 chr"]], [15, ["ezra"]],
  [16, ["nehemiah", "neh"]], [17, ["esther", "esth"]], [18, ["job"]], [19, ["psalms", "psalm", "ps", "psa"]],
  [20, ["proverbs", "prov", "pr"]], [21, ["ecclesiastes", "eccl", "ecc"]], [22, ["song of solomon", "song of songs", "song"]],
  [23, ["isaiah", "isa"]], [24, ["jeremiah", "jer"]], [25, ["lamentations", "lam"]], [26, ["ezekiel", "ezek"]],
  [27, ["daniel", "dan"]], [28, ["hosea", "hos"]], [29, ["joel"]], [30, ["amos"]], [31, ["obadiah", "obad"]],
  [32, ["jonah"]], [33, ["micah", "mic"]], [34, ["nahum", "nah"]], [35, ["habakkuk", "hab"]], [36, ["zephaniah", "zeph"]],
  [37, ["haggai", "hag"]], [38, ["zechariah", "zech"]], [39, ["malachi", "mal"]],
  [40, ["matthew", "matt", "mt"]], [41, ["mark", "mk"]], [42, ["luke", "lk"]], [43, ["john", "jn"]], [44, ["acts"]],
  [45, ["romans", "rom"]], [46, ["1 corinthians", "1 cor"]], [47, ["2 corinthians", "2 cor"]], [48, ["galatians", "gal"]],
  [49, ["ephesians", "eph"]], [50, ["philippians", "phil"]], [51, ["colossians", "col"]],
  [52, ["1 thessalonians", "1 thess", "1 thes"]], [53, ["2 thessalonians", "2 thess", "2 thes"]],
  [54, ["1 timothy", "1 tim"]], [55, ["2 timothy", "2 tim"]], [56, ["titus", "tit"]], [57, ["philemon", "philem", "phlm"]],
  [58, ["hebrews", "heb"]], [59, ["james", "jas"]], [60, ["1 peter", "1 pet", "1 pt"]], [61, ["2 peter", "2 pet", "2 pt"]],
  [62, ["1 john", "1 jn"]], [63, ["2 john", "2 jn"]], [64, ["3 john", "3 jn"]], [65, ["jude"]], [66, ["revelation", "rev"]],
];

export function bibleBookOrder(passage: unknown): number | null {
  if (typeof passage !== "string") return null;
  const p = passage.trim().toLowerCase().replace(/\./g, "").replace(/^(i{1,3})\s+/, (_, r: string) => `${r.length} `).replace(/^(\d)(?=[a-z])/, "$1 ").replace(/\s+/g, " ");
  if (!p) return null;
  let best: { n: number; len: number } | null = null;
  for (const [n, names] of BOOKS) {
    for (const name of names) {
      if (p === name || p.startsWith(name + " ") || p.startsWith(name + ":")) {
        if (!best || name.length > best.len) best = { n, len: name.length };
      }
    }
  }
  return best ? best.n : null;
}
