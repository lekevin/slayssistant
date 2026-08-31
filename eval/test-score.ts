/**
 * Tests for the eval scorer.
 *
 * These matter more than they look. Every number this project publishes passes
 * through this file, and a scorer that is quietly too lenient produces a
 * beautiful ablation table that means nothing. The failure is invisible: recall
 * goes up, the chart looks good, and the retrieval never improved.
 *
 * Run: npx tsx eval/test-score.ts
 */
import assert from "node:assert/strict";
import {
  normalize,
  orderedCoverage,
  chunkHits,
  scoreRetrieval,
  recallAt,
  mrr,
  wilson,
  mcnemar,
  holm,
  discordant,
  minDetectableEffect,
  type GoldRow,
  type RetrievedChunk,
} from "./score";

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

const gold = (over: Partial<GoldRow> = {}): GoldRow => ({
  id: "q1",
  question: "How long does Block last?",
  docSha: "abc123",
  page: 7,
  span: "Block is lost at the start of your next turn.",
  answerClass: "permitted",
  ...over,
});

const chunk = (content: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: "c1",
  content,
  pageStart: 7,
  pageEnd: 7,
  ...over,
});

// ---------------------------------------------------------------- normalize

console.log("\nnormalize");

test("survives the punctuation a PDF parse actually emits", () => {
  // Curly quotes, en/em dashes and non-breaking spaces are invisible on screen
  // and fatal to an exact comparison.
  const a = normalize("Block is lost — at the ‘start’ of your next turn.");
  const b = normalize("Block is lost - at the 'start' of your next turn.");
  assert.equal(a, b, `\n  ${a}\n  ${b}`);
});

test("rejoins words hyphenated across a line break", () => {
  assert.ok(
    normalize("re-\nshuffle the deck").includes("reshuffle"),
    normalize("re-\nshuffle the deck")
  );
});

test("strips soft hyphens and collapses whitespace", () => {
  assert.equal(normalize("Ex­haust   the\n\ncard"), "exhaust the card");
});

test("keeps quantities and rule identifiers", () => {
  const n = normalize("Deal 3+ damage per section 4.2");
  assert.ok(n.includes("3+"), n);
  assert.ok(n.includes("4.2"), n);
});

// ---------------------------------------------------------- orderedCoverage

console.log("\nordered coverage");

test("full credit for an exact span", () => {
  assert.equal(orderedCoverage("Block is lost at the start of your next turn.", gold().span), 1);
});

test("full credit when the span sits inside a larger chunk", () => {
  const c = "Blocking. Block reduces damage. Block is lost at the start of your next turn. See p.8.";
  assert.equal(orderedCoverage(c, gold().span), 1);
});

test("requires ORDER, not just shared vocabulary", () => {
  // Same words, scrambled. A bag-of-words scorer would call this a hit.
  const scrambled = "turn next your of start the at lost is Block";
  assert.ok(
    orderedCoverage(scrambled, gold().span) < 0.8,
    `scrambled scored ${orderedCoverage(scrambled, gold().span)}`
  );
});

test("partial credit degrades smoothly", () => {
  const half = "Block is lost at the beginning of somebody's following round.";
  const cov = orderedCoverage(half, gold().span);
  assert.ok(cov > 0.4 && cov < 0.9, `got ${cov}`);
});

test("an unrelated chunk scores near zero", () => {
  const cov = orderedCoverage("Each player begins their turn with 3 Energy.", gold().span);
  assert.ok(cov < 0.5, `got ${cov}`);
});

// -------------------------------------------------------------- chunkHits

console.log("\nchunk hits");

test("hits regardless of where the chunker drew its boundaries", () => {
  // The whole point of span labels: three different chunkings, same verdict.
  for (const c of [
    "Block is lost at the start of your next turn.",
    "## Combat > Blocking\n\nBlock reduces incoming damage. Block is lost at the start of your next turn.",
    "Block is lost at the start of your next turn unless a card says otherwise. Timing follows.",
  ]) {
    assert.ok(chunkHits(chunk(c), gold()), `missed: ${c.slice(0, 40)}`);
  }
});

test("does not hit a topically similar chunk that lacks the clause", () => {
  const c = "Block reduces incoming damage. Blocking happens during combat on your turn.";
  assert.ok(!chunkHits(chunk(c), gold()), "false positive on a merely on-topic chunk");
});

test("page overlap alone is not enough", () => {
  // Right page, wrong content. If this passed, recall would measure page
  // coverage rather than retrieval.
  const c = "Each player begins their turn with 3 Energy, and unspent Energy is lost.";
  assert.ok(!chunkHits(chunk(c, { pageStart: 7, pageEnd: 7 }), gold()));
});

// ------------------------------------------------------------------ metrics

console.log("\nmetrics");

const HIT = "Block is lost at the start of your next turn.";
const MISS = "Each player begins their turn with 3 Energy.";

test("finds the rank of the first hitting chunk", () => {
  const s = scoreRetrieval([chunk(MISS), chunk(MISS), chunk(HIT)], gold());
  assert.equal(s.hit, true);
  assert.equal(s.rank, 3);
});

test("reports a miss as rank null", () => {
  const s = scoreRetrieval([chunk(MISS)], gold());
  assert.deepEqual(s, { hit: false, rank: null });
});

test("recall@k respects the cutoff", () => {
  const scores = [{ hit: true, rank: 3 }, { hit: true, rank: 9 }, { hit: false, rank: null }];
  assert.equal(recallAt(scores, 8), 1 / 3);
  assert.equal(recallAt(scores, 10), 2 / 3);
});

test("mrr weights early ranks", () => {
  assert.ok(Math.abs(mrr([{ hit: true, rank: 1 }, { hit: true, rank: 2 }]) - 0.75) < 1e-9);
});

// --------------------------------------------------------------- statistics

console.log("\nstatistics");

test("wilson interval matches the published value for 35/50", () => {
  const [lo, hi] = wilson(35, 50);
  assert.ok(Math.abs(lo - 0.5637) < 0.002, `lo=${lo}`);
  assert.ok(Math.abs(hi - 0.8084) < 0.002, `hi=${hi}`);
});

test("wilson stays inside [0,1] at the extremes", () => {
  for (const [k, n] of [[0, 10], [10, 10], [0, 1]]) {
    const [lo, hi] = wilson(k, n);
    assert.ok(lo >= 0 && hi <= 1, `[${lo}, ${hi}]`);
  }
});

test("mcnemar separates two runs with an identical headline", () => {
  // Both are +14 points at n=50. Only one is significant. This is the entire
  // reason the table reports paired counts rather than a single delta.
  assert.ok(Math.abs(mcnemar(8, 1) - 0.0390625) < 1e-6, `8/1 -> ${mcnemar(8, 1)}`);
  const p = mcnemar(12, 5);
  assert.ok(p > 0.13 && p < 0.15, `12/5 -> ${p}`);
});

test("mcnemar is 1 when nothing is discordant", () => {
  assert.equal(mcnemar(0, 0), 1);
});

test("mcnemar is symmetric", () => {
  assert.ok(Math.abs(mcnemar(3, 9) - mcnemar(9, 3)) < 1e-12);
});

test("holm is monotone and never shrinks a p-value", () => {
  const raw = [0.01, 0.04, 0.03, 0.2];
  const adj = holm(raw);
  raw.forEach((p, i) => assert.ok(adj[i] >= p, `holm shrank ${p} to ${adj[i]}`));
  const sorted = [...adj].sort((a, b) => a - b);
  const bySortedRaw = raw.map((p, i) => ({ p, a: adj[i] })).sort((x, y) => x.p - y.p).map((x) => x.a);
  assert.deepEqual(bySortedRaw, sorted, "adjusted p-values must not cross");
});

test("discordant counts wins and losses at the cutoff", () => {
  const a = [{ hit: true, rank: 1 }, { hit: false, rank: null }, { hit: true, rank: 2 }];
  const b = [{ hit: false, rank: null }, { hit: true, rank: 3 }, { hit: true, rank: 1 }];
  assert.deepEqual(discordant(a, b, 8), { improved: 1, regressed: 1 });
});

test("MDE shows n=50 cannot resolve the effect the doc wanted to publish", () => {
  // The architecture doc's illustration was "+14 points of recall@5" at n=50.
  const mde50 = minDetectableEffect(50) * 100;
  assert.ok(mde50 > 14, `MDE at n=50 is ${mde50.toFixed(1)}pts — expected above the 14pt claim`);
  const mde200 = minDetectableEffect(200) * 100;
  assert.ok(mde200 < mde50, "MDE must fall as n grows");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
