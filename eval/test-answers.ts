/**
 * Tests for the answer-level scorer.
 *
 * The false-permission rate is the number this project would most like to be
 * low, which is exactly why its arithmetic needs pinning down. Two failures
 * would be invisible in the published report: counting an ungradeable answer as
 * clean, and letting `permitted` questions leak into the denominator — both
 * make the headline better without anything improving.
 *
 * Run: npx tsx eval/test-answers.ts
 */
import assert from "node:assert/strict";
import { stanceMatches, isSettled, falsePermissions, refusalCounterweight } from "./answers";
import type { GoldRow } from "./score";

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

const row = (id: string, answerClass: GoldRow["answerClass"]): GoldRow => ({
  id,
  question: `q-${id}`,
  docSha: "test",
  page: 1,
  span: "span",
  answerClass,
});

console.log("\nstance agreement");

test("each stance matches only its own label", () => {
  assert.equal(stanceMatches("PERMITTED", "permitted"), true);
  assert.equal(stanceMatches("FORBIDDEN", "forbidden"), true);
  assert.equal(stanceMatches("UNSTATED", "unstated"), true);
  assert.equal(stanceMatches("PERMITTED", "forbidden"), false);
  assert.equal(stanceMatches("UNSTATED", "permitted"), false);
});

test("a negatively-phrased question still counts as settled", () => {
  // "Is there a maximum hand size?" is labeled permitted - the rulebook
  // settles it - and the correct answer is "no". Scoring on yes-vs-no would
  // mark that right answer wrong.
  assert.equal(stanceMatches("FORBIDDEN", "permitted"), true);
  assert.equal(isSettled("FORBIDDEN"), true);
  assert.equal(isSettled("UNSTATED"), false);
  assert.equal(isSettled("UNCLEAR"), false);
});

test("an ungradeable answer is never counted as correct", () => {
  for (const cls of ["permitted", "forbidden", "unstated"] as const) {
    assert.equal(stanceMatches("UNCLEAR", cls), false, `UNCLEAR must not satisfy ${cls}`);
  }
});

test("a factual answer satisfies permitted but never unstated", () => {
  // Most of the golden set asks what a rule says rather than whether something
  // is allowed. Those belong to the permitted stratum and must not be scored
  // as if the system took no position.
  assert.equal(stanceMatches("FACTUAL", "permitted"), true);
  // Stating a rule the book does not contain is a fabrication, not an answer.
  assert.equal(stanceMatches("FACTUAL", "unstated"), false);
});

test("asserting permission on a forbidden question is never correct", () => {
  assert.equal(stanceMatches("PERMITTED", "forbidden"), false);
  assert.equal(stanceMatches("FORBIDDEN", "forbidden"), true);
});

console.log("\nfalse-permission rate");

test("counts a yes on both forbidden and unstated questions", () => {
  const fp = falsePermissions([
    { stance: "PERMITTED", gold: row("a", "forbidden") },
    { stance: "PERMITTED", gold: row("b", "unstated") },
    { stance: "FORBIDDEN", gold: row("c", "forbidden") },
  ]);
  assert.equal(fp.eligible, 3);
  assert.equal(fp.bad, 2);
});

test("permitted questions stay out of the denominator entirely", () => {
  // A yes on a permitted question is the system working, not a false
  // permission. Letting these into the denominator would dilute the rate
  // toward zero as the golden set grows its easy questions.
  const fp = falsePermissions([
    { stance: "PERMITTED", gold: row("a", "permitted") },
    { stance: "PERMITTED", gold: row("b", "permitted") },
    { stance: "PERMITTED", gold: row("c", "forbidden") },
  ]);
  assert.equal(fp.eligible, 1);
  assert.equal(fp.bad, 1);
});

test("refusing to commit is not a false permission", () => {
  // Saying "the rules don't settle this" on a forbidden question is a weaker
  // answer, but it is not the failure this metric exists to catch.
  const fp = falsePermissions([
    { stance: "UNSTATED", gold: row("a", "forbidden") },
    { stance: "UNCLEAR", gold: row("b", "unstated") },
  ]);
  assert.equal(fp.eligible, 2);
  assert.equal(fp.bad, 0);
});

test("a clean sweep reports zero rather than dividing by zero", () => {
  const fp = falsePermissions([{ stance: "PERMITTED", gold: row("a", "permitted") }]);
  assert.equal(fp.eligible, 0);
  assert.equal(fp.bad, 0);
});

test("the offending rows come back for the report to quote", () => {
  const fp = falsePermissions([
    { stance: "PERMITTED", gold: row("bad", "forbidden") },
    { stance: "FORBIDDEN", gold: row("good", "forbidden") },
  ]);
  assert.deepEqual(fp.rows.map((r) => r.gold.id), ["bad"]);
});

console.log("\nrefusal counterweight");

test("a hard refusal on a permitted question is an over-refusal, not a rounding error", () => {
  // The bug this pins: filtering the counterweight on `stance === "UNSTATED"`
  // counted the polite decline and dropped the outright refusal, while the
  // sentence printed beside the number still claimed to explain the whole gap
  // between correct and n. The two stances are the same miss.
  const cw = refusalCounterweight([
    { stance: "UNSTATED", gold: row("declined", "permitted") },
    { stance: "UNCLEAR", gold: row("refused", "permitted") },
    { stance: "PERMITTED", gold: row("fine", "permitted") },
  ]);
  assert.equal(cw.eligible, 3);
  assert.equal(cw.ok, 1);
  assert.equal(cw.rows.length, 2);
  assert.deepEqual(cw.declined.map((r) => r.gold.id), ["declined"]);
  assert.deepEqual(cw.ungradeable.map((r) => r.gold.id), ["refused"]);
});

test("the counterweight accounts for every permitted miss", () => {
  // The report prints `ok`/`eligible` and then claims the listed rows are the
  // difference. If any miss can escape both buckets that sentence is a lie, so
  // assert the identity directly across all five stances.
  const rows = (["PERMITTED", "FORBIDDEN", "FACTUAL", "UNSTATED", "UNCLEAR"] as const).map((s) => ({
    stance: s,
    gold: row(s.toLowerCase(), "permitted" as const),
  }));
  const cw = refusalCounterweight(rows);
  assert.equal(cw.ok + cw.rows.length, cw.eligible);
  assert.equal(cw.declined.length + cw.ungradeable.length, cw.rows.length);
});

test("other strata never enter the counterweight", () => {
  // An `unstated` question answered UNSTATED is the system working. Counting
  // it as a refusal would make the counterweight grow every time the headline
  // improved, which is backwards.
  const cw = refusalCounterweight([
    { stance: "UNSTATED", gold: row("a", "unstated") },
    { stance: "UNCLEAR", gold: row("b", "forbidden") },
  ]);
  assert.equal(cw.eligible, 0);
  assert.equal(cw.rows.length, 0);
});

test("a negatively-phrased permitted question is not an over-refusal", () => {
  // FORBIDDEN on a permitted-stratum question means the book settled it with a
  // "no". That is a correct answer and must stay out of the refusal count.
  const cw = refusalCounterweight([{ stance: "FORBIDDEN", gold: row("a", "permitted") }]);
  assert.equal(cw.ok, 1);
  assert.equal(cw.rows.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
