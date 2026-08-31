/**
 * Unit tests for the retrieval math and the citation bridge.
 *
 * These check the parts where a silent wrong answer is possible: a BM25
 * implementation with a sign error still returns plausibly-ordered results, and
 * a citation resolver that is off by one chunk still renders a page number —
 * just the wrong one. Both failures look fine in a demo.
 *
 * Run: npx tsx eval/test-retrieval.ts
 */
import assert from "node:assert/strict";
import { buildBm25, tokenize } from "../lib/retrieval/bm25";
import { fuse } from "../lib/retrieval/rrf";
import { assembleDocuments, resolveCitation, citationLabel } from "../lib/citations";
import { classifyShape, extractEntities } from "../lib/prohibition";
import type { Chunk, Scored } from "../lib/retrieval/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
}

// ---------------------------------------------------------------- tokenizer

console.log("\ntokenizer");

test("keeps rule identifiers and quantities intact", () => {
  const t = tokenize("See section 4.2 for 3+ damage and 2x multipliers");
  assert.ok(t.includes("4.2"), `expected "4.2" in ${JSON.stringify(t)}`);
  assert.ok(t.includes("3+"), `expected "3+" in ${JSON.stringify(t)}`);
  assert.ok(t.includes("2x"), `expected "2x" in ${JSON.stringify(t)}`);
});

test("does not stem game keywords together", () => {
  // "Exhaust" is a specific keyword. A stemmer would collapse these; we must not.
  const a = tokenize("Exhaust this card");
  const b = tokenize("Exhausted cards return");
  assert.ok(a.includes("exhaust"));
  assert.ok(b.includes("exhausted"));
  assert.ok(!b.includes("exhaust"), "exhausted must not be stemmed to exhaust");
});

test("keeps rules-critical modal words", () => {
  const t = tokenize("A player may not draw and cannot discard");
  for (const w of ["may", "not", "cannot"]) {
    assert.ok(t.includes(w), `dropped rules-critical word "${w}"`);
  }
});

// --------------------------------------------------------------------- bm25

console.log("\nbm25");

const DOCS = [
  "Block reduces incoming damage and is lost at the start of your next turn", // 0
  "Energy is spent to play cards each turn", // 1
  "When a card is Exhausted remove it from play for the rest of combat", // 2
  "Block cards may only be played during your own turn", // 3
  "Enemies act after every player has taken a turn", // 4
];
const bm25 = buildBm25(DOCS);

test("ranks the document containing the rare term first", () => {
  const r = bm25.score("Exhausted", 5);
  assert.equal(r[0].index, 2, `got doc ${r[0].index}`);
});

test("a term in every document contributes near-nothing", () => {
  // "turn" appears in 4 of 5 docs; it must not dominate a distinctive term.
  const rare = bm25.score("Energy", 5);
  assert.equal(rare[0].index, 1);
  const common = bm25.score("turn", 5);
  assert.ok(
    common[0].score < rare[0].score,
    `common term scored ${common[0].score} >= rare ${rare[0].score}`
  );
});

test("returns nothing for a term absent from the corpus", () => {
  assert.equal(bm25.score("teleport", 5).length, 0);
});

test("scores are non-negative", () => {
  for (const q of ["turn", "Block", "card play combat"]) {
    for (const r of bm25.score(q, 10)) {
      assert.ok(r.score >= 0, `negative score ${r.score} for "${q}"`);
    }
  }
});

test("prefers the doc matching both query terms", () => {
  const r = bm25.score("Block turn", 5);
  assert.ok([0, 3].includes(r[0].index), `got doc ${r[0].index}`);
});

// ---------------------------------------------------------------------- rrf

console.log("\nrrf");

test("agreement across arms beats a single strong arm", () => {
  const f = fuse([
    { name: "dense", ids: ["a", "b", "c"] },
    { name: "sparse", ids: ["b", "a", "d"] },
  ]);
  // b: 1/62 + 1/61 ; a: 1/61 + 1/62 -> identical, both above c and d.
  assert.deepEqual(new Set(f.slice(0, 2).map((x) => x.id)), new Set(["a", "b"]));
  assert.ok(f[2].score < f[1].score);
});

test("computes the documented reciprocal", () => {
  const f = fuse([{ name: "only", ids: ["x"] }]);
  assert.ok(Math.abs(f[0].score - 1 / 61) < 1e-12, `got ${f[0].score}`);
});

test("records per-arm ranks for the trace", () => {
  const f = fuse([
    { name: "dense", ids: ["a", "b"] },
    { name: "sparse", ids: ["b"] },
  ]);
  const b = f.find((x) => x.id === "b")!;
  assert.equal(b.ranks.dense, 2);
  assert.equal(b.ranks.sparse, 1);
  const a = f.find((x) => x.id === "a")!;
  assert.equal(a.ranks.sparse, undefined);
});

// ---------------------------------------------------------------- citations

console.log("\ncitations");

function chunk(over: Partial<Chunk>): Chunk {
  return {
    id: "c1",
    ordinal: 0,
    docId: "rulebook",
    docType: "rulebook",
    authority: 10,
    sectionPath: ["Combat", "Blocking"],
    title: "Blocking",
    part: null,
    partsTotal: null,
    pageStart: 7,
    pageEnd: 7,
    content: "Block reduces incoming damage.",
    tokenCount: 8,
    srcStart: null,
    srcEnd: null,
    mergedTitles: null,
    ...over,
  };
}
const scored = (c: Chunk): Scored => ({ chunk: c, score: 0.1, ranks: {} });

test("groups sibling chunks into one document, in document order", () => {
  const docs = assembleDocuments([
    scored(chunk({ id: "b", ordinal: 2, title: "Timing", sectionPath: ["Combat", "Timing"], content: "Second." })),
    scored(chunk({ id: "a", ordinal: 1, content: "First." })),
  ]);
  assert.equal(docs.length, 1, "siblings under Combat should share one document");
  assert.deepEqual(docs[0].spans.map((s) => s.chunkId), ["a", "b"]);
  assert.ok(docs[0].block.source.data.indexOf("First.") < docs[0].block.source.data.indexOf("Second."));
});

test("a char_location resolves to the right chunk's printed page", () => {
  const docs = assembleDocuments([
    scored(chunk({ id: "a", ordinal: 1, pageStart: 7, content: "Block reduces incoming damage." })),
    scored(
      chunk({
        id: "b",
        ordinal: 2,
        pageStart: 9,
        title: "Timing",
        sectionPath: ["Combat", "Timing"],
        content: "Block cards may only be played on your own turn.",
      })
    ),
  ]);
  const data = docs[0].block.source.data;
  const offset = data.indexOf("Block cards may only");
  assert.ok(offset > 0, "second chunk not found in assembled text");

  const res = resolveCitation(
    { type: "char_location", document_index: 0, start_char_index: offset, end_char_index: offset + 10, cited_text: "Block card" },
    docs
  )!;
  assert.equal(res.chunkId, "b", "resolved to the wrong chunk");
  assert.equal(res.page, 9, `expected page 9, got ${res.page}`);
});

test("an offset inside the first chunk does not bleed into the second", () => {
  const docs = assembleDocuments([
    scored(chunk({ id: "a", ordinal: 1, pageStart: 7, content: "Block reduces incoming damage." })),
    scored(chunk({ id: "b", ordinal: 2, pageStart: 9, title: "T", sectionPath: ["Combat", "T"], content: "Other text here." })),
  ]);
  const data = docs[0].block.source.data;
  const offset = data.indexOf("Block reduces");
  const res = resolveCitation(
    { type: "char_location", document_index: 0, start_char_index: offset, end_char_index: offset + 5, cited_text: "Block" },
    docs
  )!;
  assert.equal(res.chunkId, "a");
  assert.equal(res.page, 7);
});

test("renders a real page number, never p.undefined", () => {
  const docs = assembleDocuments([scored(chunk({ pageStart: 7, pageEnd: 8 }))]);
  const data = docs[0].block.source.data;
  // Search past the synthesized heading, which also contains "Block(ing)".
  const offset = data.indexOf("Block reduces");
  const res = resolveCitation(
    { type: "char_location", document_index: 0, start_char_index: offset, end_char_index: offset + 5, cited_text: "Block" },
    docs
  )!;
  const label = citationLabel(res);
  assert.ok(!label.includes("undefined"), label);
  assert.ok(label.includes("pp.7-8"), label);
});

test("web citations bypass the span map entirely", () => {
  const res = resolveCitation(
    { type: "web_search_result_location", url: "https://boardgamegeek.com/thread/1", title: "BGG", cited_text: "ruling" },
    []
  )!;
  assert.equal(res.source, "web");
  assert.equal(citationLabel(res), "boardgamegeek.com");
});

test("an out-of-range document_index returns null rather than throwing", () => {
  assert.equal(resolveCitation({ type: "char_location", document_index: 99, start_char_index: 0 }, []), null);
});

test("a citation into an uploaded document is not dropped", () => {
  // Regression: an uploaded PDF is also a `document` block, so it takes the
  // index after the corpus documents. Resolving against the corpus array alone
  // returned undefined and silently discarded every citation into the user's
  // own file - on the one path that produces real page numbers.
  const docs = assembleDocuments([scored(chunk({}))]);
  const withUpload = [
    ...docs,
    {
      block: {
        type: "document" as const,
        source: { type: "text" as const, media_type: "text/plain" as const, data: "" },
        title: "Your upload: homebrew.pdf",
        context: "",
        citations: { enabled: true as const },
      },
      spans: [],
    },
  ];
  const res = resolveCitation(
    { type: "page_location", document_index: 1, start_page_number: 4, end_page_number: 4, cited_text: "Homebrew rule." },
    withUpload
  );
  assert.ok(res, "citation into the upload was dropped");
  assert.equal(res!.page, 4);
  assert.ok(citationLabel(res!).length > 0);
});

test("an uploaded doc with no span map still yields a labelled citation", () => {
  const withUpload = [
    {
      block: {
        type: "document" as const,
        source: { type: "text" as const, media_type: "text/plain" as const, data: "" },
        title: "Your upload: notes.md",
        context: "",
        citations: { enabled: true as const },
      },
      spans: [],
    },
  ];
  const res = resolveCitation(
    { type: "char_location", document_index: 0, start_char_index: 10, cited_text: "some text" },
    withUpload
  )!;
  assert.ok(res, "dropped a citation into a span-less document");
  assert.ok(!citationLabel(res).includes("undefined"), citationLabel(res));
});

// -------------------------------------------------------------- prohibition

console.log("\nquestion shape");

const PROHIBITION = [
  "Can I play a Trap during my opponent's turn?",
  "Am I allowed to discard before drawing?",
  "Is it legal to attack twice?",
  "Does Barricade stack with Entrench?",
  "Do I have to play a card every turn?",
  "Is there anything that stops me from ending my turn early?",
];
const NOT_PROHIBITION = ["What does Exhaust do?", "How much damage does Bash deal?", "What is Block?"];

test("catches prohibition-shaped questions", () => {
  for (const q of PROHIBITION) {
    assert.equal(classifyShape(q), "prohibition", `missed: ${q}`);
  }
});

test("does not fire on plain lookups", () => {
  for (const q of NOT_PROHIBITION) {
    assert.notEqual(classifyShape(q), "prohibition", `false positive: ${q}`);
  }
});

test("routes how-to-play questions", () => {
  assert.equal(classifyShape("How do I play?"), "how_to_play");
  assert.equal(classifyShape("What's the goal of the game?"), "how_to_play");
});

test("prohibition wins over how-to-play when both match", () => {
  // The dangerous failure is a fabricated permission, so ambiguity resolves
  // toward the reading that gets complete sections and a web search.
  assert.equal(classifyShape("How do I play a Trap on someone else's turn?"), "prohibition");
});

test("extracts card names, ignoring the sentence-initial word", () => {
  const e = extractEntities("Does Barricade stack with Entrench?");
  assert.ok(e.includes("Barricade"), JSON.stringify(e));
  assert.ok(e.includes("Entrench"), JSON.stringify(e));
  assert.ok(!e.includes("Does"), "sentence-initial word should not be an entity");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
