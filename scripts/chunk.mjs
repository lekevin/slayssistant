#!/usr/bin/env node
/**
 * Stage 2 of ingestion: parsed markdown -> retrievable chunks.
 *
 * Rulebooks arrive pre-chunked by their authors - that is what the numbered
 * sections ARE. So we split on the document's own heading hierarchy rather than
 * on a fixed window, merge sections too small to stand alone into their
 * preceding sibling, and split oversized ones on paragraph boundaries. Every
 * chunk carries the full breadcrumb (Combat > Blocking > Timing) and the real
 * printed page range, which is what makes citations resolvable.
 *
 * Cards are ingested separately and are never split: a card is an atomic unit
 * of meaning, and half a card is worse than no card.
 *
 * Usage: npm run chunk
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.join(import.meta.dirname, "..");
const MD = path.join(ROOT, "data/parsed/rulebook.md");
const CARDS = path.join(ROOT, "data/cards-compendium.md");
const OUT = path.join(ROOT, "data/index/chunks.json");

// Chunk size targets, in tokens. Small enough to embed precisely; the answering
// path widens back out by sending whole sections.
const MIN_TOKENS = 120;
const MAX_TOKENS = 600;

// Authority ladder. Errata supersedes the FAQ, which supersedes the rulebook,
// which supersedes a fan transcription. The cards compendium is fan-made and
// carries literal "[Innate?]" uncertainty markers in its own data, so it sits
// BELOW the rulebook and must never be allowed to overrule it.
const AUTHORITY = { errata: 30, faq: 20, rulebook: 10, cards: 5, strategy: 0 };

const estTokens = (s) => Math.ceil(s.length / 4);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Map any character offset in the markdown back to its printed page number. */
function buildPageIndex(md) {
  const marks = [];
  const re = /<!--\s*page:\s*(\d+)(\s+inferred)?\s*-->/g;
  let m;
  while ((m = re.exec(md))) marks.push({ offset: m.index, page: Number(m[1]), inferred: !!m[2] });
  return {
    marks,
    pageAt(offset) {
      if (!marks.length) return null;
      let lo = 0, hi = marks.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].offset <= offset) { best = marks[mid].page; lo = mid + 1; }
        else hi = mid - 1;
      }
      // An offset before the first marker belongs to the first page.
      return best ?? marks[0].page;
    },
  };
}

/**
 * Walk the markdown's heading structure, returning one node per heading with
 * the text it owns directly (everything up to the next heading of any level).
 */
function parseSections(md) {
  const lines = md.split("\n");
  const nodes = [];
  const stack = [];
  let offset = 0;

  const headingRe = /^(#{1,6})\s+(.+?)\s*#*$/;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    const h = headingRe.exec(line);
    if (!h) continue;

    const level = h[1].length;
    const title = h[2].trim();

    // Close out the previous node's owned text at this heading's start.
    if (nodes.length) nodes[nodes.length - 1].ownEnd = lineStart;

    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const node = {
      level,
      title,
      path: [...stack.map((s) => s.title), title],
      headingStart: lineStart,
      ownStart: offset, // text begins after the heading line
      ownEnd: md.length,
    };
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

/** Strip page markers and blank noise from a chunk's visible text. */
function clean(s) {
  return s
    .replace(/<!--\s*page:\s*\d+(\s+inferred)?\s*-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitOversized(text, maxTokens) {
  if (estTokens(text) <= maxTokens) return [text];
  const paras = text.split(/\n\s*\n/);
  const parts = [];
  let cur = "";
  for (const p of paras) {
    const candidate = cur ? cur + "\n\n" + p : p;
    if (cur && estTokens(candidate) > maxTokens) {
      parts.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * A glossary is a list of atomic definitions wearing one heading.
 *
 * "Abilities & Keywords" holds 15 unrelated keyword definitions - Block,
 * Ethereal, Exhaust, Retain, Vulnerable... - and structural chunking keeps them
 * together because the terms are bold lines, not headings. That single 573-token
 * chunk then embeds as the AVERAGE of fifteen unrelated meanings, which matches
 * nothing in particular: asked "what does Exhaust do?", retrieval returned seven
 * cards that merely mention exhausting and never surfaced the definition at all.
 * BM25 fails the same way, because length normalization penalizes the long blob
 * against short card texts that use the word prominently.
 *
 * So a definition list gets the treatment cards already get: one chunk per
 * entry, never merged. The same rule that makes a card atomic makes a keyword
 * atomic.
 */
const DEF_LINE = /^\*\*([^*]{2,60})\*\*\s*(?:[-\u2013\u2014]|\s)\s*(.+)$/;

function asDefinitionList(rawSlice) {
  const lines = rawSlice.split("\n");
  const defs = [];
  let contentLines = 0;

  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("<!-- page:")) return;
    contentLines++;
    const m = DEF_LINE.exec(t);
    if (m) defs.push({ term: m[1].trim(), body: t, lineIndex: i });
  });

  // Require both a real list and that the list IS the section, so prose
  // sections that happen to bold a few phrases are left alone.
  if (defs.length < 4 || defs.length / Math.max(contentLines, 1) < 0.6) return null;

  // Offset of each definition line within the slice, for page mapping.
  let offset = 0;
  const offsets = lines.map((l) => {
    const at = offset;
    offset += l.length + 1;
    return at;
  });
  return defs.map((d) => ({ ...d, offset: offsets[d.lineIndex] }));
}

// ---------------------------------------------------------------- rulebook

function chunkRulebook() {
  if (!fs.existsSync(MD)) {
    console.error(`No parsed markdown at ${MD}. Run \`npm run parse\` first.`);
    process.exit(1);
  }
  const md = fs.readFileSync(MD, "utf-8");
  const pages = buildPageIndex(md);
  const nodes = parseSections(md);

  if (!nodes.length) {
    console.error("No headings found in the parsed markdown - the chunker has nothing to split on.");
    process.exit(1);
  }

  // One raw chunk per heading that owns real text. Pure container headings
  // (a "## Combat" whose body is entirely subsections) contribute their title
  // to descendants' breadcrumbs and nothing else.
  const raw = [];
  for (const n of nodes) {
    const rawSlice = md.slice(n.ownStart, n.ownEnd);
    const body = clean(rawSlice);
    if (!body) continue;

    const defs = asDefinitionList(rawSlice);
    if (defs) {
      for (const d of defs) {
        const abs = n.ownStart + d.offset;
        raw.push({
          title: d.term,
          path: [...n.path, d.term],
          parentKey: n.path.join(" > "),
          start: abs,
          end: abs + d.body.length,
          body: d.body,
          atomic: true,
        });
      }
      continue;
    }

    raw.push({
      title: n.title,
      path: n.path,
      parentKey: n.path.slice(0, -1).join(" > "),
      start: n.headingStart,
      end: n.ownEnd,
      body,
    });
  }

  // A section that has subsections must never be merged away: its children's
  // breadcrumbs name it as their parent, and folding its text into a sibling
  // would leave those children pointing at a heading whose body lives somewhere
  // else entirely.
  const pathKeys = raw.map((c) => c.path.join(" > "));
  const hasChildren = (c) => {
    const prefix = c.path.join(" > ") + " > ";
    return pathKeys.some((k) => k.startsWith(prefix));
  };

  // Merge undersized leaf sections UPWARD into their parent, which is the one
  // chunk whose breadcrumb is still truthful for the merged text - a parent is
  // an ancestor of its child, so the path stays correct, just less specific.
  // Merging into a sibling instead would file the text under a heading it does
  // not belong to, and that heading is what gets shown in the citation.
  const merged = [];
  const byPath = new Map();

  for (const c of raw) {
    const key = c.path.join(" > ");
    const parent = byPath.get(c.parentKey);

    if (
      parent &&
      !c.atomic &&
      !parent.atomic &&
      estTokens(c.body) < MIN_TOKENS &&
      !hasChildren(c) &&
      estTokens(parent.body) + estTokens(c.body) <= MAX_TOKENS
    ) {
      parent.body += `\n\n### ${c.title}\n\n${c.body}`;
      parent.end = Math.max(parent.end, c.end);
      parent.mergedTitles = [...(parent.mergedTitles || []), c.title];
      continue;
    }

    const entry = { ...c };
    merged.push(entry);
    byPath.set(key, entry);
  }

  // Split oversized chunks on paragraph boundaries.
  const out = [];
  for (const c of merged) {
    const parts = c.atomic ? [c.body] : splitOversized(c.body, MAX_TOKENS);
    parts.forEach((body, i) => {
      out.push({
        docId: "rulebook",
        docType: "rulebook",
        authority: AUTHORITY.rulebook,
        sectionPath: c.path,
        title: c.title,
        part: parts.length > 1 ? i + 1 : null,
        partsTotal: parts.length > 1 ? parts.length : null,
        pageStart: pages.pageAt(c.start),
        pageEnd: pages.pageAt(c.end - 1),
        content: body,
        tokenCount: estTokens(body),
        srcStart: c.start,
        srcEnd: c.end,
        mergedTitles: c.mergedTitles ?? null,
      });
    });
  }
  return { chunks: out, docSha: sha(md), pageMarkers: pages.marks.length };
}

// ------------------------------------------------------------------- cards

/**
 * The compendium is a hand transcription in a stable shape:
 *   ## IRONCLAD            <- class
 *   ### Common / Uncommon  <- grouping
 *   **Anger** (0) [Attack] - [dmg 1]. Put this card on top of your draw pile.
 * One chunk per entry, never split.
 */
function chunkCards() {
  if (!fs.existsSync(CARDS)) {
    console.warn(`No ${path.relative(ROOT, CARDS)} - skipping cards.`);
    return [];
  }
  const md = fs.readFileSync(CARDS, "utf-8");
  const out = [];
  let group = [];

  for (const line of md.split("\n")) {
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 2) group = [h[2].trim()];
      else group = [group[0] ?? "Cards", h[2].trim()];
      continue;
    }
    const card = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line.trim());
    if (!card) continue;

    const name = card[1].trim();
    const rest = card[2].trim();
    if (!rest) continue;

    // "(1) [Attack] - [dmg 1]." -> cost "1", type "Attack"
    const cost = /^\(([^)]*)\)/.exec(rest)?.[1] ?? null;
    const type = /\[([A-Za-z ]+)\]/.exec(rest)?.[1] ?? null;

    out.push({
      docId: "cards",
      docType: "cards",
      authority: AUTHORITY.cards,
      sectionPath: [...group, name],
      title: name,
      cardName: name,
      cardCost: cost,
      cardType: type,
      part: null,
      partsTotal: null,
      pageStart: null,
      pageEnd: null,
      content: `${name} ${rest}`,
      tokenCount: estTokens(rest),
      srcStart: null,
      srcEnd: null,
      mergedTitles: null,
    });
  }
  return out;
}

// -------------------------------------------------------------------- main

const { chunks: rulebookChunks, docSha, pageMarkers } = chunkRulebook();
const cardChunks = chunkCards();
const all = [...rulebookChunks, ...cardChunks].map((c, i) => ({
  // Stable, content-derived id. Deliberately NOT a random uuid: golden-set
  // labels and the embedding cache both key off content, and a chunk whose
  // text is unchanged across a re-ingest should keep its identity.
  // Path-qualified: Ironclad's "Strike" and Silent's "Strike" have byte-identical
  // text, so content alone is not a unique key.
  id: `${c.docId}:${sha(c.docId + " " + c.sectionPath.join(" > ") + " " + c.content).slice(0, 12)}`,
  ordinal: i,
  ...c,
}));

const dupes = all.length - new Set(all.map((c) => c.id)).size;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");

const rb = rulebookChunks;
const sizes = rb.map((c) => c.tokenCount).sort((a, b) => a - b);
const pct = (p) => sizes[Math.floor((sizes.length - 1) * p)] ?? 0;
const noPage = rb.filter((c) => c.pageStart == null).length;

console.log(`Wrote ${path.relative(ROOT, OUT)}`);
console.log(`  rulebook  ${rb.length} chunks   tokens p10/p50/p90 = ${pct(0.1)}/${pct(0.5)}/${pct(0.9)}`);
console.log(`  cards     ${cardChunks.length} chunks`);
console.log(`  total     ${all.length} chunks, doc_sha ${docSha.slice(0, 16)}, ${pageMarkers} page markers`);
if (dupes) console.warn(`  WARNING: ${dupes} duplicate chunk ids (identical content) - dedupe upstream.`);
if (noPage) console.warn(`  WARNING: ${noPage} rulebook chunks have no page number; their citations cannot resolve.`);
console.log("\nNext: npm run embed");
