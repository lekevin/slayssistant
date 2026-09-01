/**
 * Answer-level evaluation: the false-permission rate.
 *
 * The retrieval ablation in run.ts measures whether the answer-bearing passage
 * was FOUND. It says nothing about what the system then told the player, and
 * the architecture's stated worst failure lives entirely in that gap: telling
 * someone a move is legal when the rules do not permit it. A pipeline can post
 * 98% recall and still be untrustworthy, because retrieving the Traps section
 * and then inventing a permission it does not contain scores as a hit.
 *
 * So this harness runs the REAL answering path — same prompt, same retrieval
 * options, same effort, same web-search gating, all imported from lib/answer.ts
 * rather than restated — and grades the stance of each answer against the
 * golden set's `answerClass`.
 *
 *   false-permission rate = answers asserting "yes, allowed"
 *                           over questions labeled forbidden or unstated
 *
 * The counterweight matters as much as the metric. A system that replies "the
 * rules don't say" to everything scores a perfect 0% and is useless, so the
 * report always carries the `permitted` stratum beside it: if refusal is
 * climbing to buy a clean false-permission number, that shows up as over-
 * refusal on questions the rulebook plainly answers. Neither number means
 * anything alone.
 *
 * Run: npx tsx eval/answers.ts [--limit N] [--concurrency 4] [--strata forbidden,unstated]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getRetriever } from "../lib/retrieval/file-retriever";
import { assembleDocuments } from "../lib/citations";
import { classifyShape } from "../lib/prohibition";
import {
  ANSWER_MODEL,
  EFFORT_BY_SHAPE,
  WEB_SEARCH_TOOL,
  retrievalOptions,
  shouldAttachSearch,
  systemPrompt,
} from "../lib/answer";
import { wilson, type GoldRow } from "./score";

const ROOT = path.join(import.meta.dirname, "..");
const GOLDEN = path.join(ROOT, "eval/golden.jsonl");
const OUT = path.join(ROOT, "eval/answers.md");

const argv = process.argv.slice(2);
const argOf = (flag: string, dflt: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const LIMIT = Number(argOf("--limit", "0"));
const CONCURRENCY = Number(argOf("--concurrency", "4"));
const STRATA = argOf("--strata", "permitted,forbidden,unstated").split(",");
/** Ignore the checkpoint and re-ask every question. */
const FRESH = argv.includes("--fresh");

/**
 * The judge decides only what stance a player would walk away with — never
 * whether that stance is correct. Keeping the judge ignorant of the expected
 * answer is what stops it from rationalizing agreement with the label.
 */
const JUDGE_MODEL = "claude-opus-5";

const STANCES = ["PERMITTED", "FORBIDDEN", "FACTUAL", "UNSTATED", "UNCLEAR"] as const;
type Stance = (typeof STANCES)[number];

/**
 * FACTUAL exists because most of the golden set does not ask a yes/no question.
 * "What is the maximum Energy?" has no permission stance to take, and forcing
 * the taxonomy onto it produced a judge that answered UNCLEAR for every lookup
 * — scoring the system as having taken no position when it had answered
 * correctly. The bucket separates "the rules settle this, here is what they
 * say" from "the rules do not settle this," which is the distinction the whole
 * metric turns on.
 */
const JUDGE_SYSTEM = `You grade answers from a board game rules assistant. You classify the STANCE of an answer. You never judge whether the answer is correct, and you are never told what the correct answer is.

Reply with EXACTLY ONE WORD from this list:

PERMITTED — the question asks whether something is allowed or whether something happens, and the answer says YES, presented as settled by the rules.
FORBIDDEN — the question asks whether something is allowed or whether something happens, and the answer says NO, presented as settled by the rules.
FACTUAL — the question is not a yes/no question (it asks what, when, how many, where), and the answer states what the rules say, presented as settled.
UNSTATED — the answer reports that the rules do not settle the question: it says the rulebook is silent, explicitly labels its reading as an inference or best guess, or declines to commit.
UNCLEAR — the answer is empty, off-topic, or takes no position at all.

Grading rules:
- Judge the stance the player walks away with, not its correctness.
- Decide PERMITTED/FORBIDDEN vs FACTUAL from the QUESTION's shape. A yes/no question always gets PERMITTED or FORBIDDEN, never FACTUAL — including when the answer is phrased as a statement of fact ("Block does not prevent Lose X HP" answering "Does Block stop lose HP?" is FORBIDDEN).
- An answer that gives a direction but explicitly flags it as an inference from silence, or as coming from an unofficial source rather than the rulebook, is UNSTATED — that labeling is the distinction being measured.
- Soft wording alone ("likely", "probably", "I'd say yes") is NOT enough to make it UNSTATED. That is still a committed stance.
- If the answer commits to a stance and then adds a caveat, grade the stance it committed to.

Output one word. No punctuation, no explanation.`;

interface Row {
  gold: GoldRow;
  shape: string;
  answer: string;
  stance: Stance;
  usedSearch: boolean;
  ms: number;
}

const usage = { input: 0, output: 0, judgeInput: 0, judgeOutput: 0 };

async function answerOne(client: Anthropic, gold: GoldRow): Promise<Row> {
  const t0 = Date.now();
  const shape = classifyShape(gold.question);
  const retriever = getRetriever();
  const { results } = await retriever.search(gold.question, retrievalOptions(shape));
  const docs = assembleDocuments(results);
  const attachSearch = shouldAttachSearch(shape, results);

  const content: Anthropic.ContentBlockParam[] = docs.map(
    (d) => d.block as Anthropic.DocumentBlockParam
  );
  content.push({ type: "text", text: gold.question });

  const stream = client.messages.stream({
    model: ANSWER_MODEL,
    max_tokens: 8000,
    system: systemPrompt(shape, false),
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: EFFORT_BY_SHAPE[shape as keyof typeof EFFORT_BY_SHAPE] },
    ...(attachSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    messages: [{ role: "user", content }],
  });

  const final = await stream.finalMessage();
  usage.input += final.usage.input_tokens ?? 0;
  usage.output += final.usage.output_tokens ?? 0;

  const answer = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // A refusal carries no stance to grade; recording it as UNCLEAR keeps it
  // visible in the report instead of silently counting as a clean result.
  const stance =
    final.stop_reason === "refusal" || !answer
      ? "UNCLEAR"
      : await judge(client, gold.question, answer);

  return { gold, shape, answer, stance, usedSearch: attachSearch, ms: Date.now() - t0 };
}

async function judge(client: Anthropic, question: string, answer: string): Promise<Stance> {
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    // Thinking is on by default on Opus 5, so a tight max_tokens gets spent
    // before any visible text and the judge returns an empty string - which
    // silently graded every short verdict as UNCLEAR. Give it room; the
    // visible output is still one word.
    max_tokens: 2048,
    system: JUDGE_SYSTEM,
    output_config: { effort: "low" },
    messages: [
      { role: "user", content: `QUESTION:\n${question}\n\nANSWER:\n${answer}` },
    ],
  });
  usage.judgeInput += res.usage.input_tokens ?? 0;
  usage.judgeOutput += res.usage.output_tokens ?? 0;

  const word = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .toUpperCase();

  return (STANCES.find((s) => word.includes(s)) ?? "UNCLEAR") as Stance;
}

/** Did the answer present the question as settled by the rules at all? */
export function isSettled(stance: Stance): boolean {
  return stance === "PERMITTED" || stance === "FORBIDDEN" || stance === "FACTUAL";
}

/**
 * Score on the settled/unsettled axis, not on yes-vs-no.
 *
 * The direction of a correct answer does not track the label, because questions
 * get phrased negatively: "Is there a maximum hand size?" is labeled
 * `permitted` — the rulebook settles it — and the correct answer is "no". A
 * scorer that demanded a PERMITTED stance there would mark a right answer
 * wrong. What the labels genuinely encode is whether the corpus settles the
 * question, so that is what gets scored:
 *
 *   permitted / forbidden -> the system should treat it as settled
 *   unstated              -> the system should report it as unsettled
 *
 * `forbidden` additionally rejects a PERMITTED stance: asserting permission the
 * book withholds is the failure this whole file exists to count.
 */
export function stanceMatches(stance: Stance, answerClass: GoldRow["answerClass"]): boolean {
  if (answerClass === "unstated") return stance === "UNSTATED";
  if (answerClass === "forbidden") return stance === "FORBIDDEN" || stance === "FACTUAL";
  return isSettled(stance);
}

/**
 * The headline number. Denominator is every question where the rulebook does
 * NOT grant permission; numerator is the ones the system said yes to anyway.
 */
export function falsePermissions<T extends { stance: Stance; gold: GoldRow }>(rows: T[]) {
  const eligible = rows.filter(
    (r) => r.gold.answerClass === "forbidden" || r.gold.answerClass === "unstated"
  );
  const bad = eligible.filter((r) => r.stance === "PERMITTED");
  return { eligible: eligible.length, bad: bad.length, rows: bad };
}

/**
 * The counterweight to that headline: every `permitted` question the system
 * failed to settle.
 *
 * Deriving these from `stanceMatches` rather than from `stance === "UNSTATED"`
 * is the whole point of the function existing. The permitted stratum is scored
 * on settled-vs-unsettled, so a miss is any answer that declined to commit —
 * and that is two stances, not one. UNSTATED is the polite decline; UNCLEAR is
 * a hard refusal or an answer that took no position, which is the same failure
 * wearing a worse face. Filtering on UNSTATED alone drops those on the floor
 * while the sentence printed beside the number still claims to account for the
 * entire gap between `ok` and `n` — so the report would silently under-count
 * exactly the behaviour that buying a clean false-permission rate looks like.
 */
export function refusalCounterweight<T extends { stance: Stance; gold: GoldRow }>(rows: T[]) {
  const eligible = rows.filter((r) => r.gold.answerClass === "permitted");
  const missed = eligible.filter((r) => !stanceMatches(r.stance, "permitted"));
  return {
    eligible: eligible.length,
    ok: eligible.length - missed.length,
    /** Declined to commit — "the rulebook doesn't settle this" on a question it does. */
    declined: missed.filter((r) => r.stance === "UNSTATED"),
    /** Refused outright or took no position. Same miss, louder. */
    ungradeable: missed.filter((r) => r.stance === "UNCLEAR"),
    rows: missed,
  };
}

/**
 * Run `fn` over `items` with `n` workers, isolating failures.
 *
 * This deliberately does NOT let one rejection abort the run. A previous
 * version used a bare `Promise.all`, and a single transient `overloaded_error`
 * on question 189 of 192 discarded all 188 completed answers and wrote no
 * report — about forty minutes of paid model calls thrown away by one 529 that
 * had nothing to do with the system under test. An infrastructure failure on
 * one question is not a result for that question, but it is also not a reason
 * to destroy the other 191.
 */
async function pool<T, R>(
  items: T[],
  n: number,
  fn: (t: T, i: number) => Promise<R>
): Promise<Array<R | null>> {
  const out = new Array<R | null>(items.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i], i);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  !! ${(items[i] as { id?: string }).id ?? i} failed: ${msg.slice(0, 120)}`);
          out[i] = null;
        }
      }
    })
  );
  return out;
}

/**
 * Per-question checkpoint.
 *
 * The answering path costs real money per question, so a run that dies partway
 * must not start from zero. Each completed row is appended here as it lands and
 * replayed on the next run.
 *
 * The key is what makes this safe: it covers the model, the judge, the index
 * the answer was retrieved from, the exact system prompt, and the retrieval
 * options. Change any of those and the cached answer no longer describes the
 * system under test, so it misses and gets re-asked. Editing a question's text
 * invalidates only that question.
 */
const CACHE = path.join(ROOT, "eval/.answers-cache.jsonl");

function cacheKey(g: GoldRow, indexSha: string): string {
  const shape = classifyShape(g.question);
  return createHash("sha256")
    .update(
      JSON.stringify({
        q: g.question,
        cls: g.answerClass,
        model: ANSWER_MODEL,
        judge: JUDGE_MODEL,
        index: indexSha,
        system: systemPrompt(shape, false),
        retrieval: retrievalOptions(shape),
      })
    )
    .digest("hex")
    .slice(0, 16);
}

function loadCache(): Map<string, Row> {
  const m = new Map<string, Row>();
  if (!fs.existsSync(CACHE)) return m;
  for (const line of fs.readFileSync(CACHE, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { key, row } = JSON.parse(line) as { key: string; row: Row };
      m.set(key, row);
    } catch {
      // A half-written final line from a hard kill. Skip it; the question
      // just gets re-asked.
    }
  }
  return m;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const gold: GoldRow[] = fs
    .readFileSync(GOLDEN, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  let selected = gold.filter((g) => STRATA.includes(g.answerClass));
  if (LIMIT > 0) selected = selected.slice(0, LIMIT);

  const indexSha =
    ((getRetriever().info as { docSha: string | null }).docSha ?? "none").slice(0, 16);

  if (FRESH && fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const cache = loadCache();
  const cached = selected.filter((g) => cache.has(cacheKey(g, indexSha)));
  const todo = selected.filter((g) => !cache.has(cacheKey(g, indexSha)));

  console.log(
    `${selected.length} questions · model ${ANSWER_MODEL} · judge ${JUDGE_MODEL} · concurrency ${CONCURRENCY}`
  );
  if (cached.length) {
    console.log(`${cached.length} replayed from checkpoint, ${todo.length} to ask\n`);
  } else {
    console.log("");
  }

  // maxRetries covers the transient 429/529 that killed an earlier run outright.
  // The SDK's default of 2 was not enough to ride out a sustained overload.
  const client = new Anthropic({ maxRetries: 6 });
  let done = 0;
  const t0 = Date.now();

  const fresh = await pool(todo, CONCURRENCY, async (g) => {
    const row = await answerOne(client, g);
    done++;

    // Append before anything else can fail. This is the line that makes a
    // crashed run cost one question instead of all of them.
    fs.appendFileSync(
      CACHE,
      JSON.stringify({ key: cacheKey(g, indexSha), row }) + "\n"
    );

    const flag =
      (g.answerClass === "forbidden" || g.answerClass === "unstated") && row.stance === "PERMITTED"
        ? "  <-- FALSE PERMISSION"
        : "";
    console.log(
      `  ${String(done).padStart(3)}/${todo.length}  ${g.id}  ${g.answerClass.padEnd(9)} -> ${row.stance.padEnd(9)}${flag}`
    );
    return row;
  });

  const byId = new Map<string, Row>();
  for (const g of cached) byId.set(g.id, cache.get(cacheKey(g, indexSha))!);
  for (const r of fresh) if (r) byId.set(r.gold.id, r);

  const failed = selected.filter((g) => !byId.has(g.id));
  const rows = selected.map((g) => byId.get(g.id)).filter((r): r is Row => !!r);

  if (failed.length) {
    console.log(
      `\n${failed.length} question(s) failed and are EXCLUDED from the report: ${failed.map((g) => g.id).join(", ")}`
    );
    console.log("Re-run to retry just those — completed answers replay from the checkpoint.");
  }
  if (!rows.length) {
    console.error("\nNo answers survived. Not overwriting the existing report.");
    process.exit(1);
  }

  const fp = falsePermissions(rows);
  const [fpLo, fpHi] = wilson(fp.bad, fp.eligible);
  const rate = fp.eligible ? fp.bad / fp.eligible : 0;

  const byClass = (cls: GoldRow["answerClass"]) => {
    const sub = rows.filter((r) => r.gold.answerClass === cls);
    const ok = sub.filter((r) => stanceMatches(r.stance, cls)).length;
    return { n: sub.length, ok, pct: sub.length ? ok / sub.length : 0 };
  };

  const refused = refusalCounterweight(rows);

  // ---------------------------------------------------------------- report
  const L: string[] = [];
  L.push("# Answer-level evaluation");
  L.push("");
  L.push(
    `Ran the production answering path — same system prompt, retrieval options, effort and ` +
      `web-search gating as \`app/api/chat/route.ts\`, all imported from \`lib/answer.ts\` — over ` +
      `**${rows.length} questions**. A separate judge classifies only the STANCE of each answer ` +
      `(permitted / forbidden / factual / unstated / unclear) and is never shown the expected label.`
  );
  L.push("");
  L.push("## False-permission rate");
  L.push("");
  L.push(
    `> **${(rate * 100).toFixed(1)}%** — ${fp.bad} of ${fp.eligible} questions where the rulebook does ` +
      `not grant permission were answered as though it does. 95% CI ${(fpLo * 100).toFixed(0)}–${(fpHi * 100).toFixed(0)}%.`
  );
  L.push("");
  L.push(
    "This is the number that reflects whether the system is trustworthy. Retrieval recall cannot " +
      "see it: a pipeline can retrieve the right section and still invent a permission it does not contain."
  );
  L.push("");
  L.push("## Stance accuracy by stratum");
  L.push("");
  L.push("| stratum | n | correct stance | rate |");
  L.push("|---|---|---|---|");
  for (const cls of ["permitted", "forbidden", "unstated"] as const) {
    const b = byClass(cls);
    if (!b.n) continue;
    L.push(`| ${cls} | ${b.n} | ${b.ok} | ${(b.pct * 100).toFixed(1)}% |`);
  }
  L.push("");
  L.push("### Why the `permitted` row is here");
  L.push("");
  L.push(
    `A system that answered "the rules don't say" to everything would post a 0% false-permission ` +
      `rate and be worthless. The guard against buying a clean headline with refusals is the ` +
      `permitted stratum: **${refused.ok}/${refused.eligible}** correctly treated as settled by the ` +
      `rules, with **${refused.rows.length}** left unsettled — ${refused.declined.length} that ` +
      `declined to commit, ${refused.ungradeable.length} that refused outright or took no position. ` +
      `Read the two numbers together or neither means anything.`
  );
  L.push("");
  L.push(
    `The stratum is scored on settled-vs-unsettled rather than on yes-vs-no, because a question ` +
      `the rulebook plainly answers "no" to (\"Is there a maximum hand size?\") is still a question ` +
      `it settles. So the misses below are exactly the answers that committed to nothing.`
  );

  // Both flagged sets get quoted the same way. A bare count of either is not
  // triageable: the question is always whether the model failed or the label
  // did, and that is only answerable by reading the answer next to the span.
  const quote = (r: Row) => {
    L.push(`**${r.gold.id}** (${r.gold.answerClass}) — ${r.gold.question}`);
    L.push("");
    L.push(`> ${r.answer.replace(/\n+/g, " ").slice(0, 400) || "_(no answer text — refused)_"}`);
    L.push("");
    if (r.gold.span) L.push(`Governing text: \`${r.gold.span.slice(0, 160)}\``);
    L.push("");
  };

  if (fp.rows.length) {
    L.push("");
    L.push("## Every false permission, verbatim");
    L.push("");
    L.push(
      "Read these before treating the headline as a defect count. A flag means the judge saw a " +
        "'yes'; it does not yet mean the system fabricated one. Compound questions (\"can I do X " +
        "without any downside?\") and mislabeled rows land here too, and they are golden-set bugs " +
        "rather than model failures. The rate is an upper bound until these are triaged."
    );
    L.push("");
    for (const r of fp.rows) quote(r);
  }

  if (refused.rows.length) {
    L.push("");
    L.push("## Every over-refusal, verbatim");
    L.push("");
    L.push(
      "The same courtesy the false permissions get, for the same reason: these are the rows that " +
        "keep the headline honest, so they have to be as readable as the rows that threaten it. " +
        "Some of these are the authority ladder working as designed — the system declining to " +
        "state a card's text flatly because it comes from the fan-transcribed compendium, which " +
        "the prompt ranks below the rulebook — and those are a deliberate trade, not a defect."
    );
    L.push("");
    for (const r of refused.rows) quote(r);
  }

  const unclear = rows.filter((r) => r.stance === "UNCLEAR");
  if (unclear.length) {
    L.push("");
    L.push(`## Ungradeable (${unclear.length})`);
    L.push("");
    L.push("Refusals or answers that took no position. Counted as incorrect, never as clean.");
    L.push("");
    for (const r of unclear) L.push(`- \`${r.gold.id}\` — ${r.gold.question}`);
  }

  const searched = rows.filter((r) => r.usedSearch).length;
  const secs = Math.round((Date.now() - t0) / 1000);
  L.push("");
  L.push("## Run");
  L.push("");
  L.push(
    `- ${rows.length} questions` +
      (cached.length ? ` (${fresh.filter(Boolean).length} asked this run, ${cached.length} replayed from checkpoint)` : "") +
      ` in ${Math.floor(secs / 60)}m ${secs % 60}s at concurrency ${CONCURRENCY}`
  );
  if (failed.length) {
    L.push(`- **${failed.length} question(s) failed and are excluded**: ${failed.map((g) => g.id).join(", ")}`);
  }
  L.push(`- web search attached on ${searched} (${((searched / rows.length) * 100).toFixed(0)}%)`);
  L.push(
    `- answer tokens: ${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out · ` +
      `judge tokens: ${usage.judgeInput.toLocaleString()} in / ${usage.judgeOutput.toLocaleString()} out`
  );
  L.push("");
  L.push(`_Generated by \`npx tsx eval/answers.ts\`. Answer model ${ANSWER_MODEL}, judge ${JUDGE_MODEL}._`);

  fs.writeFileSync(OUT, L.join("\n") + "\n");

  console.log(`\nfalse-permission rate  ${(rate * 100).toFixed(1)}%  (${fp.bad}/${fp.eligible})`);
  console.log(
    `permitted stratum      ${refused.ok}/${refused.eligible} settled, ` +
      `${refused.rows.length} over-refused (${refused.declined.length} declined, ${refused.ungradeable.length} ungradeable)`
  );
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
