#!/usr/bin/env node
/**
 * Structural checks on a parsed rulebook, to run before freezing it.
 *
 * `data/parsed/rulebook.md` is a committed artifact that everything downstream
 * derives from: chunk boundaries, page numbers on every citation, and the
 * `docSha` every golden-set label is written against. Vision parsing is also
 * non-deterministic, so a re-parse is a new artifact whose defects are invisible
 * unless something looks for them - a dropped page or a mis-levelled heading
 * surfaces much later as a citation pointing at the wrong page, which is worse
 * than an obvious failure.
 *
 * These checks are generic. Optionally pass a table of contents to also verify
 * that every section the book claims to have actually made it through, on the
 * page the book says:
 *
 *   npm run verify:parse -- --toc data/parsed/toc.json
 *
 * where toc.json is [["Components", 3], ["Setup", 4], ...]. A printed TOC often
 * labels a two-page spread or merges two sections onto one line, so an entry
 * may carry a third element naming the heading the book actually prints:
 * ["Characters", 16, "The Ironclad"]. Recording that resolution is the point -
 * a check that always emits the same warnings stops being read.
 *
 * Usage: npm run verify:parse
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const mdPath = argOf("--in") || path.join(ROOT, "data/parsed/rulebook.md");
if (!fs.existsSync(mdPath)) {
  console.error(`No parsed markdown at ${mdPath}. Run \`npm run parse\` first.`);
  process.exit(1);
}
const md = fs.readFileSync(mdPath, "utf-8");

let failures = 0;
let warnings = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const warn = (msg) => {
  warnings++;
  console.log(`  warn  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

// ------------------------------------------------------------ page markers

const marks = [...md.matchAll(/<!--\s*page:\s*(\d+)(\s+inferred)?\s*-->/g)].map((m) => ({
  offset: m.index,
  page: Number(m[1]),
  inferred: !!m[2],
}));
const pages = marks.map((m) => m.page);

console.log("\npage markers");
if (!pages.length) {
  fail("no <!-- page: N --> markers - citations cannot resolve a page number");
} else {
  const outOfOrder = pages.filter((p, i) => i > 0 && p <= pages[i - 1]);
  const gaps = [];
  for (let p = pages[0]; p <= pages[pages.length - 1]; p++) {
    if (!pages.includes(p)) gaps.push(p);
  }
  ok(`${pages.length} markers spanning pages ${pages[0]}-${pages[pages.length - 1]}`);
  if (outOfOrder.length) fail(`pages out of order at: ${outOfOrder.join(", ")}`);
  else ok("monotonically increasing");
  if (gaps.length) warn(`no marker for page(s) ${gaps.join(", ")} - content there loses its page`);
  else ok("no gaps");
  const inferred = marks.filter((m) => m.inferred);
  if (inferred.length) warn(`${inferred.length} page number(s) inferred, not printed`);
}

function pageAt(offset) {
  let best = null;
  for (const m of marks) {
    if (m.offset <= offset) best = m.page;
    else break;
  }
  return best ?? (marks[0]?.page ?? null);
}

// ---------------------------------------------------------------- headings

const heads = [...md.matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => ({
  offset: m.index,
  level: m[1].length,
  title: m[2].trim(),
}));

console.log("\nheadings");
if (!heads.length) {
  fail("no headings - the chunker has nothing to split on");
} else {
  ok(`${heads.length} headings`);

  // A jump from h1 straight to h3 means the chunker builds a breadcrumb with a
  // missing ancestor, so the citation reads as if from the wrong section.
  const jumps = heads
    .slice(1)
    .map((h, i) => ({ prev: heads[i], cur: h }))
    .filter(({ prev, cur }) => cur.level - prev.level > 1);
  if (jumps.length) {
    for (const j of jumps) {
      warn(`level jump h${j.prev.level} "${j.prev.title.slice(0, 40)}" -> h${j.cur.level} "${j.cur.title.slice(0, 40)}"`);
    }
  } else ok("no skipped heading levels");

  // Two sections with the same full breadcrumb are indistinguishable in a
  // citation chip and collide in the chunker's parent lookup.
  const stack = [];
  const seen = new Map();
  for (const h of heads) {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
    const key = stack.map((s) => s.title).join(" > ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  if (dupes.length) {
    for (const [k, n] of dupes) warn(`duplicate breadcrumb x${n}: ${k.slice(0, 70)}`);
  } else ok("all breadcrumbs unique");
}

// ------------------------------------------------------------- truncation

console.log("\nintegrity");
if (md.split("**").length % 2 === 0) warn("unbalanced ** - a bold marker is unclosed, suggesting a cut-off line");
else ok("bold markers balanced");

const tail = md.trim().slice(-1);
if (!".!?)\"'>".includes(tail)) {
  warn(`document ends mid-sentence (last char ${JSON.stringify(tail)}) - check for max_tokens truncation`);
} else ok("ends on a complete sentence");

// A parse that stops early usually still looks fine in isolation; comparing the
// last marker against the PDF's page count is what catches it.
const meta = mdPath.replace(/\.md$/, ".meta.json");
if (fs.existsSync(meta)) {
  const m = JSON.parse(fs.readFileSync(meta, "utf-8"));
  ok(`docSha ${String(m.docSha).slice(0, 16)} · ${m.chars?.toLocaleString?.() ?? "?"} chars · parsed ${m.parsedAt}`);
}

// ------------------------------------------------------------------- TOC

const tocPath = argOf("--toc");
if (tocPath && fs.existsSync(tocPath)) {
  console.log("\ntable of contents");
  const toc = JSON.parse(fs.readFileSync(tocPath, "utf-8"));
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const [name, page, actual] of toc) {
    const key = norm(actual ?? name).slice(0, 7);
    // A title can legitimately appear twice - "Act IV" is both a subsection of
    // Unlocks on p20 and its own rules section on p22. Take the candidate
    // nearest the page the TOC claims, so a duplicate name is not reported as a
    // page mismatch.
    const candidates = heads.filter((h) => norm(h.title).startsWith(key));
    const hit = candidates.length
      ? candidates.reduce((best, h) =>
          Math.abs((pageAt(h.offset) ?? 0) - page) < Math.abs((pageAt(best.offset) ?? 0) - page) ? h : best
        )
      : null;
    if (!hit) {
      // The book's TOC often labels a two-page spread or merges two sections
      // onto one line, so a miss is a prompt to look, not proof of loss.
      warn(`"${name}" (p${page}) not found by name - check it wasn't dropped`);
      continue;
    }
    const got = pageAt(hit.offset);
    if (got != null && Math.abs(got - page) > 1) {
      fail(`"${name}" expected p${page}, parsed at p${got}`);
    } else {
      ok(`${name}${actual ? " (as printed: " + actual + ")" : ""} -> "${hit.title.slice(0, 40)}" p${got}`);
    }
  }
}

console.log(
  `\n${failures} failure(s), ${warnings} warning(s).` +
    (failures ? "\nFix these before freezing the parse - everything downstream inherits them.\n" : "\n")
);
process.exit(failures ? 1 : 0);
