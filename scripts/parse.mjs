#!/usr/bin/env node
/**
 * Stage 1 of ingestion: turn a rulebook PDF into structured markdown.
 *
 * Rulebooks are two-column layouts full of sidebars, callout boxes, tables and
 * iconography. Text extractors (pdf-parse and friends) flatten those into
 * scrambled reading order and you inherit the damage forever — the previous
 * prototype's corpus opens with "Components3 Setup4-5 Your Area6", a table of
 * contents welded into a single chunk. So we send the PDF to Claude as a
 * `document` block and let it read the page as a page.
 *
 * The output is a COMMITTED ARTIFACT (data/parsed/rulebook.md). Run this once,
 * hand-fix the handful of headings it gets wrong, and commit the result. Vision
 * parsing is non-deterministic, so re-running it invalidates every downstream
 * page reference and every golden-set label. Re-parse only when the PDF itself
 * changes.
 *
 * Usage: npm run parse [-- --pages 1-12] [--in path.pdf] [--out path.md]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.join(import.meta.dirname, "..");
const MODEL = process.env.PARSE_MODEL || "claude-opus-5";

// The API caps a request at 32 MB and base64 inflates by ~4/3, so a PDF over
// ~23 MB cannot be sent whole regardless of page count.
const MAX_PDF_BYTES = 23 * 1024 * 1024;

function parseArgs(argv) {
  const out = { in: null, out: null, pages: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") out.in = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--pages") out.pages = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const inPath = args.in || path.join(ROOT, "data/source/rulebook.pdf");
const outPath = args.out || path.join(ROOT, "data/parsed/rulebook.md");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and fill it in.");
  process.exit(1);
}
if (!fs.existsSync(inPath)) {
  console.error(`No PDF at ${inPath}. Put your rulebook there, or pass --in <path>.`);
  process.exit(1);
}

const pdf = fs.readFileSync(inPath);
if (pdf.length > MAX_PDF_BYTES) {
  console.error(
    `${inPath} is ${(pdf.length / 1024 / 1024).toFixed(1)} MB. Base64 inflates that past the API's 32 MB\n` +
      `request limit. Compress it (Preview > Export as PDF > Reduce File Size, or ghostscript) and retry.`
  );
  process.exit(1);
}

const docSha = crypto.createHash("sha256").update(pdf).digest("hex");

const SYSTEM = `You convert board game rulebooks into faithful structured markdown for a retrieval system.

Rules you must follow exactly:

1. PRESERVE READING ORDER. These are multi-column layouts. Read each column fully before moving to the
   next. Never interleave text across columns.

2. MARK EVERY PAGE BOUNDARY. Before the content of each page, emit exactly:
   <!-- page: N -->
   where N is the page number PRINTED ON THE PAGE. If a page has no printed number, use its ordinal
   position in the PDF and mark it: <!-- page: N inferred -->
   This marker is load-bearing — citations are resolved back to these numbers.

3. PRESERVE THE HEADING HIERARCHY using #/##/###. The rulebook's own section structure is the chunking
   strategy; do not invent, merge, or re-level headings. If a numbered scheme exists ("4.2 Blocking"),
   keep the number in the heading text.

4. TRANSCRIBE VERBATIM. This text gets quoted back to players as a ruling. Do not summarize, paraphrase,
   modernize wording, or fix perceived errors. Reproduce the exact words.

5. TABLES become markdown tables. Never flatten a table into prose — a rules table is often the entire
   answer to a question.

6. SIDEBARS, CALLOUTS AND EXAMPLE BOXES become blockquotes (>) with their heading preserved, so they stay
   attached to their section rather than dissolving into surrounding body text.

7. ICONOGRAPHY becomes bracketed text: [Energy], [Block 2], [Vulnerable]. Be consistent across the whole
   document. If an icon's meaning is genuinely unclear, write [icon: brief description] rather than
   guessing at a game term.

8. DIAGRAMS AND ILLUSTRATIONS: emit a short italic description on its own line, e.g.
   *[Diagram: combat row layout, showing the three enemy slots relative to the player area.]*
   A diagram that carries rules information must be described in enough detail to answer a question about
   it, because the retrieval system will never see the image.

9. SKIP pure decoration: cover art, credits, marketing copy for companion apps, and the table of contents.
   The TOC is navigation, not rules, and it poisons retrieval.

Output only the markdown. No preamble, no commentary, no code fences around the whole document.`;

const userText = args.pages
  ? `Convert pages ${args.pages} of this rulebook to markdown, following every rule in your instructions.`
  : `Convert this entire rulebook to markdown, following every rule in your instructions. Work through it page by page from the first page to the last; do not stop early or abbreviate the later pages.`;

console.log(`Parsing ${path.basename(inPath)} (${(pdf.length / 1024 / 1024).toFixed(1)} MB) with ${MODEL}...`);
console.log(`  doc_sha ${docSha.slice(0, 16)}`);
console.log("  This takes several minutes and costs roughly $0.30-0.80. Streaming:\n");

const anthropic = new Anthropic();

const stream = anthropic.messages.stream({
  model: MODEL,
  max_tokens: 64000,
  // Transcription is not a reasoning task. The API default is `high`, which on a
  // 24-page document buys a long silent thinking phase and no better reading -
  // the hard part is following a two-column layout, not deciding anything.
  output_config: { effort: "low" },
  // Without display:"summarized", thinking blocks stream with empty text and a
  // long run is indistinguishable from a hang.
  thinking: { type: "adaptive", display: "summarized" },
  system: SYSTEM,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
        },
        { type: "text", text: userText },
      ],
    },
  ],
});

// Progress has to distinguish thinking from writing from stalled, or a slow run
// looks identical to a hung one.
let chars = 0;
let thinkChars = 0;
let pagesSeen = 0;
let lastEvent = Date.now();

const tick = setInterval(() => {
  const quiet = Math.round((Date.now() - lastEvent) / 1000);
  process.stdout.write(
    `\r  page ${pagesSeen}/24 · ${chars.toLocaleString()} ch markdown · ` +
      `${thinkChars.toLocaleString()} ch thinking${quiet > 8 ? ` · quiet ${quiet}s` : ""}          `
  );
}, 2000);

stream.on("thinking", (t) => {
  thinkChars += t.length;
  lastEvent = Date.now();
});
stream.on("text", (t) => {
  chars += t.length;
  lastEvent = Date.now();
  let i = -1;
  while ((i = t.indexOf("<!-- page:", i + 1)) !== -1) pagesSeen++;
});

const msg = await stream.finalMessage();
clearInterval(tick);
process.stdout.write("\n");

const markdown = msg.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("")
  .trim();

if (!markdown) {
  console.error("\nModel returned no text. stop_reason:", msg.stop_reason);
  process.exit(1);
}
if (msg.stop_reason === "max_tokens") {
  console.warn("\n\nWARNING: hit max_tokens — the tail of the rulebook is missing.");
  console.warn("Re-run in halves with --pages 1-12 and --pages 13-24, then concatenate.");
}

const pages = [...markdown.matchAll(/<!--\s*page:\s*(\d+)/g)].map((m) => Number(m[1]));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, markdown + "\n");

const meta = {
  docSha,
  sourceFile: path.relative(ROOT, inPath),
  model: MODEL,
  parsedAt: new Date().toISOString(),
  chars: markdown.length,
  pageMarkers: pages.length,
  pageRange: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
  usage: msg.usage,
};
fs.writeFileSync(outPath.replace(/\.md$/, ".meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`\n\nWrote ${outPath}`);
console.log(`  ${markdown.length.toLocaleString()} chars, ${pages.length} page markers` +
  (meta.pageRange ? ` (pages ${meta.pageRange[0]}-${meta.pageRange[1]})` : ""));
console.log(`  in ${msg.usage.input_tokens.toLocaleString()} tok, out ${msg.usage.output_tokens.toLocaleString()} tok`);
if (!pages.length) {
  console.warn("\n  WARNING: no <!-- page: N --> markers found. Citations cannot resolve page numbers.");
  console.warn("  Check the output and re-run; the chunker needs these.");
}
console.log("\nNext: read data/parsed/rulebook.md, fix any headings it got wrong, and COMMIT it.");
console.log("Then: npm run chunk");
