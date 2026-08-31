/**
 * The ablation harness.
 *
 * This is the part of the project that turns "I built a RAG chatbot" into a
 * claim with evidence behind it. It runs the golden set through every arm of the
 * pipeline and reports what each stage actually bought — including the two
 * baselines that make the comparison honest:
 *
 *   row 0    stuffed   the ENTIRE corpus in one prompt. At ~23K tokens the whole
 *                      game fits, so this has perfect recall by construction and
 *                      costs about a penny a question. Any retrieval pipeline
 *                      here has to beat this, not just beat dense-only search.
 *                      A reader's first question is "your corpus fits in
 *                      context, why did you build retrieval?" — this row is the
 *                      answer, whichever way it comes out.
 *   row 0.5  keyword   the prototype's original IDF scoring, run verbatim.
 *
 * Reporting is paired and interval-based, because the effects being claimed are
 * the same size as the noise at this sample size. A +14-point headline can be
 * significant (8 wins, 1 loss) or meaningless (12 wins, 5 losses); only the
 * paired counts distinguish them.
 *
 * Run: npx tsx eval/run.ts [--k 8] [--arms dense,hybrid,rerank]
 */
import fs from "node:fs";
import path from "node:path";
import { getRetriever } from "../lib/retrieval/file-retriever";
import { retrieveRelevantChunks } from "../lib/keyword-baseline";
import {
  scoreRetrieval,
  recallAt,
  mrr,
  wilson,
  mcnemar,
  holm,
  discordant,
  minDetectableEffect,
  type GoldRow,
  type RetrievalScore,
  type RetrievedChunk,
} from "./score";

const ROOT = path.join(import.meta.dirname, "..");
const GOLDEN = path.join(ROOT, "eval/golden.jsonl");
const OUT = path.join(ROOT, "eval/results.md");

const argv = process.argv.slice(2);
const argOf = (flag: string, dflt: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const K = Number(argOf("--k", "8"));

interface Arm {
  key: string;
  label: string;
  note: string;
  /**
   * True when the arm does not rank - it hands the model everything. recall@k
   * is then meaningless: the gold span is in the context regardless of k, so
   * scoring it by position would report 0% for an arm with perfect coverage.
   */
  unranked?: boolean;
  run: (q: string) => Promise<RetrievedChunk[]>;
}

async function main() {
  if (!fs.existsSync(GOLDEN)) {
    console.error(`No golden set at ${path.relative(ROOT, GOLDEN)}.`);
    process.exit(1);
  }

  const gold: GoldRow[] = fs
    .readFileSync(GOLDEN, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const retriever = getRetriever();
  const all = retriever.all();

  // Guard against the failure this whole labeling scheme exists to prevent: if
  // the index was rebuilt from a different parse, the spans no longer describe
  // the corpus and every number below would be quietly wrong.
  const manifestSha = (retriever.info as { docSha: string | null }).docSha?.slice(0, 16) ?? null;
  const goldSha = gold[0]?.docSha;
  if (manifestSha && goldSha && manifestSha !== goldSha) {
    console.error(
      `\nGolden set was labeled against parse ${goldSha} but the index was built from ${manifestSha}.\n` +
        `Re-label, or rebuild the index from the parse the labels describe.\n`
    );
    process.exit(1);
  }

  // Recall is undefined where the corpus genuinely cannot answer; those rows
  // are scored only at the answer level.
  const scorable = gold.filter((g) => !g.unanswerableByCorpus && g.span);
  console.log(`${gold.length} golden rows (${scorable.length} scorable for retrieval), k=${K}\n`);

  const ARMS: Arm[] = [
    {
      key: "stuffed",
      label: "0 · stuffed prompt",
      note: "entire corpus in a cached prefix; no retrieval",
      unranked: true,
      run: async () =>
        all.map((c) => ({ id: c.id, content: c.content, pageStart: c.pageStart, pageEnd: c.pageEnd })),
    },
    {
      key: "keyword",
      label: "0.5 · keyword + IDF",
      note: "the prototype's original retrieval, verbatim",
      run: async (q) =>
        retrieveRelevantChunks(
          q,
          all.map((c) => ({ id: c.id, text: `${c.sectionPath.join(" ")} ${c.content}` })),
          K,
          40000
        ).map((r) => {
          const c = retriever.get(r.id)!;
          return { id: c.id, content: c.content, pageStart: c.pageStart, pageEnd: c.pageEnd };
        }),
    },
    {
      key: "dense",
      label: "1 · dense only",
      note: "voyage-4 cosine",
      run: async (q) => toChunks(await retriever.search(q, { k: K, arms: ["dense"] })),
    },
    {
      key: "hybrid",
      label: "2 · + BM25 & RRF",
      note: "dense and sparse fused by reciprocal rank",
      run: async (q) => toChunks(await retriever.search(q, { k: K, arms: ["dense", "sparse"] })),
    },
    {
      key: "rerank",
      label: "3 · + rerank",
      note: "rerank-2.5-lite cross-encoder over the fused candidates",
      run: async (q) =>
        toChunks(await retriever.search(q, { k: K, arms: ["dense", "sparse"], rerank: true })),
    },
  ];

  const only = argOf("--arms", "");
  const arms = only ? ARMS.filter((a) => only.split(",").includes(a.key)) : ARMS;

  const scores = new Map<string, RetrievalScore[]>();

  for (const arm of arms) {
    const rows: RetrievalScore[] = [];
    const t0 = Date.now();
    for (const g of scorable) {
      try {
        const got = await arm.run(g.question);
        const s = scoreRetrieval(got, g);
        // An unranked arm either contains the span or it does not; position is
        // not a property it has.
        rows.push(arm.unranked ? { hit: s.hit, rank: s.hit ? 1 : null } : s);
      } catch (err) {
        // A rate limit is not a retrieval miss. Scoring it as one understates
        // the arm and produces a table that looks fine and is wrong, so stop
        // instead - a partial run is recoverable, a plausible wrong number is
        // not.
        console.error(
          `\n${arm.key} failed on ${g.id}: ${err instanceof Error ? err.message : err}`
        );
        console.error(
          "Aborting rather than scoring an infrastructure failure as a retrieval miss.\n" +
            "Query embeddings already fetched are cached, so re-running resumes."
        );
        process.exit(1);
      }
    }
    scores.set(arm.key, rows);
    const r = recallAt(rows, K);
    console.log(
      `${arm.label.padEnd(22)} recall@${K} ${(r * 100).toFixed(1).padStart(5)}%  ` +
        `mrr ${mrr(rows).toFixed(3)}  ${Math.round((Date.now() - t0) / 1000)}s`
    );
  }

  // --- report ------------------------------------------------------------
  const n = scorable.length;
  const lines: string[] = [];
  lines.push("# Ablation");
  lines.push("");
  lines.push(
    `Golden set: **${n} scorable questions** on *Slay the Spire: The Board Game* ` +
      `(${gold.length} total; ${gold.length - n} unanswerable-by-corpus, scored at the answer level only). ` +
      `Labels are verbatim answer-bearing spans, not chunk ids, so they survive re-chunking and re-parsing.`
  );
  lines.push("");
  lines.push(`| arm | recall@${K} | 95% CI | MRR | vs. previous (win/loss) | McNemar p | Holm p |`);
  lines.push("|---|---|---|---|---|---|---|");

  const pvals: number[] = [];
  const pairs: Array<{ i: number; improved: number; regressed: number }> = [];
  arms.forEach((arm, i) => {
    if (i === 0 || arm.unranked || arms[i - 1].unranked) return;
    const d = discordant(scores.get(arms[i - 1].key)!, scores.get(arm.key)!, K);
    pairs.push({ i, ...d });
    pvals.push(mcnemar(d.improved, d.regressed));
  });
  const adjusted = holm(pvals);

  arms.forEach((arm, i) => {
    const rows = scores.get(arm.key)!;
    const hits = rows.filter((s) => s.rank != null && s.rank <= K).length;
    const [lo, hi] = wilson(hits, n);
    const recallCell = arm.unranked
      ? `${((hits / n) * 100).toFixed(1)}% *(by construction)*`
      : `${((hits / n) * 100).toFixed(1)}%`;
    const pairIdx = pairs.findIndex((p) => p.i === i);
    const cmp =
      pairIdx >= 0
        ? `+${pairs[pairIdx].improved} / −${pairs[pairIdx].regressed}`
        : "—";
    const p = pairIdx >= 0 ? pvals[pairIdx].toFixed(3) : "—";
    const ph = pairIdx >= 0 ? adjusted[pairIdx].toFixed(3) : "—";
    lines.push(
      `| ${arm.label} | ${recallCell} | ${arm.unranked ? "—" : `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`} | ` +
        `${arm.unranked ? "—" : mrr(rows).toFixed(3)} | ${cmp} | ${p} | ${ph} |`
    );
  });

  const mde = minDetectableEffect(n) * 100;
  lines.push("");
  lines.push(
    `**n = ${n}. Differences below roughly ${mde.toFixed(0)} points are not resolvable at this sample size** ` +
      `(paired binary outcome, α = .05, 80% power). Reaching a 10-point resolution needs about 190 questions; ` +
      `5 points needs about 470. Treat every row here as directional until the set grows.`
  );
  lines.push("");
  lines.push("### Why the stuffed-prompt row is here");
  lines.push("");
  lines.push(
    "The whole corpus is ~23K tokens, so it fits in a prompt-cached prefix at about a penny a question " +
      "with perfect recall by construction — its recall@k is 1.0 and is not a measurement. It is in the " +
      "table because it is the honest baseline: retrieval has to justify itself against *that*, not " +
      "against dense-only search. What retrieval buys at this corpus size is latency, cost per question " +
      "at scale, and the ability to grow past one game — not recall. Saying so plainly is worth more " +
      "than a chart that hides it."
  );
  lines.push("");
  lines.push("### Strata");
  lines.push("");
  const strata = gold.reduce<Record<string, number>>((a, g) => {
    a[g.answerClass] = (a[g.answerClass] ?? 0) + 1;
    return a;
  }, {});
  lines.push(
    Object.entries(strata)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join("\n")
  );
  lines.push("");
  lines.push(
    "`forbidden` and `unstated` together are the questions where the rulebook does not grant permission. " +
      "They exist because the architecture's stated worst failure — telling a player a move is legal when " +
      "the rules do not permit it — is invisible to a golden set where every question has a supporting " +
      "passage by construction. The answer-level metric that matters is **false-permission rate**: the " +
      "fraction of these where the system asserted the action was allowed."
  );
  lines.push("");
  lines.push(`_Generated by \`npx tsx eval/run.ts\`. Index: ${manifestSha ?? "unknown"}._`);

  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
  console.log(`MDE at n=${n}: ${mde.toFixed(1)} points`);
}

function toChunks(r: { results: Array<{ chunk: { id: string; content: string; pageStart: number | null; pageEnd: number | null } }> }): RetrievedChunk[] {
  return r.results.map((s) => ({
    id: s.chunk.id,
    content: s.chunk.content,
    pageStart: s.chunk.pageStart,
    pageEnd: s.chunk.pageEnd,
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
