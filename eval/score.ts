/**
 * Scoring a retrieval run, and the statistics for reporting it honestly.
 *
 * The central design decision: gold labels are VERBATIM TEXT SPANS, never chunk
 * ids. The architecture doc proposed tagging each question with "the chunk that
 * should be retrieved," which cannot work. Chunk ids are derived from content,
 * so re-chunking regenerates them — and re-chunking is precisely what the
 * ablation varies. Worse, the parse itself is a vision call and therefore
 * non-deterministic, so even re-running an unchanged pipeline would break every
 * label. A golden set that self-destructs on the experiment it exists to measure
 * is not an eval, it is a trap.
 *
 * Labeling by verbatim span instead makes the set chunking-invariant,
 * embedding-invariant and re-parse-tolerant: a retrieved chunk hits if it
 * CONTAINS the answer-bearing sentence, however the chunker happened to draw its
 * boundaries this time. The same normalizer then does double duty verifying that
 * a model's `cited_text` actually appears in the source, which is a string check
 * rather than a judgment call and needs no LLM judge at all.
 */

export interface GoldRow {
  id: string;
  question: string;
  /** Content hash of the frozen parsed markdown these labels were written against. */
  docSha: string;
  /** Printed page the answer lives on. Used as a fallback when a span straddles chunks. */
  page: number | null;
  /** Verbatim answer-bearing sentence, copied out of the source. */
  span: string;
  /**
   * What the correct answer actually is. Without a `forbidden`/`unstated`
   * stratum the eval cannot penalize the system's most damaging error — telling
   * a player a move is legal when the rules do not permit it.
   */
  answerClass: "permitted" | "forbidden" | "unstated";
  /** True when the seeded corpus genuinely cannot settle it; recall is undefined. */
  unanswerableByCorpus?: boolean;
  notes?: string;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

/**
 * Aggressive normalization. PDF text carries soft hyphens, ligatures, curly
 * quotes and non-breaking spaces that are invisible on screen and fatal to an
 * exact-match comparison.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/­/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/[^a-z0-9'".+\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (s: string) => normalize(s).split(" ").filter(Boolean);

/**
 * What fraction of the span's tokens appear in the chunk, in order. Tolerates
 * the transcription drift between two vision parses of the same page without
 * accepting a chunk that merely shares vocabulary.
 */
export function orderedCoverage(chunkText: string, span: string): number {
  const target = words(span);
  if (!target.length) return 0;
  const source = words(chunkText);
  let i = 0;
  for (const tok of source) {
    if (tok === target[i]) i++;
    if (i === target.length) break;
  }
  return i / target.length;
}

export const COVERAGE_THRESHOLD = 0.8;

export function chunkHits(chunk: RetrievedChunk, gold: GoldRow): boolean {
  if (normalize(chunk.content).includes(normalize(gold.span))) return true;
  if (orderedCoverage(chunk.content, gold.span) >= COVERAGE_THRESHOLD) return true;
  // Last resort: the span straddles a chunk boundary. Page overlap is a weaker
  // signal, so it only counts when the span is at least partly present.
  if (
    gold.page != null &&
    chunk.pageStart != null &&
    gold.page >= chunk.pageStart &&
    gold.page <= (chunk.pageEnd ?? chunk.pageStart) &&
    orderedCoverage(chunk.content, gold.span) >= 0.5
  ) {
    return true;
  }
  return false;
}

export interface RetrievalScore {
  hit: boolean;
  /** 1-indexed rank of the first hitting chunk, or null. */
  rank: number | null;
}

export function scoreRetrieval(retrieved: RetrievedChunk[], gold: GoldRow): RetrievalScore {
  for (let i = 0; i < retrieved.length; i++) {
    if (chunkHits(retrieved[i], gold)) return { hit: true, rank: i + 1 };
  }
  return { hit: false, rank: null };
}

export function recallAt(scores: RetrievalScore[], k: number): number {
  const eligible = scores.length;
  if (!eligible) return 0;
  return scores.filter((s) => s.rank != null && s.rank <= k).length / eligible;
}

export function mrr(scores: RetrievalScore[]): number {
  if (!scores.length) return 0;
  return scores.reduce((a, s) => a + (s.rank ? 1 / s.rank : 0), 0) / scores.length;
}

// ------------------------------------------------------------- statistics

/**
 * Wilson score interval. A bare point estimate on n=50 is misleading: 35/50 =
 * 0.70 carries a 95% interval of roughly [0.56, 0.81], which is as wide as the
 * effects the ablation is trying to claim. Publish the interval or the number
 * means nothing.
 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

function logChoose(n: number, k: number): number {
  let r = 0;
  for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
  return r;
}

/**
 * Two-sided exact McNemar test on the discordant pairs.
 *
 * Paired binary outcomes on the same questions demand a paired test. The
 * difference matters: at n=50, an arm that wins 8 and loses 1 (p=.039) and one
 * that wins 12 and loses 5 (p=.14) both report the same +14-point headline and
 * support opposite conclusions.
 */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/** Holm-Bonferroni. A five-arm ladder is four comparisons, not one. */
export function holm(pValues: number[]): number[] {
  const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const out = new Array(m).fill(0);
  let running = 0;
  idx.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

/** Paired win/loss counts between two arms on the same questions. */
export function discordant(a: RetrievalScore[], b: RetrievalScore[], k: number) {
  let bWins = 0;
  let aWins = 0;
  for (let i = 0; i < a.length; i++) {
    const ah = a[i].rank != null && a[i].rank! <= k;
    const bh = b[i].rank != null && b[i].rank! <= k;
    if (bh && !ah) bWins++;
    else if (ah && !bh) aWins++;
  }
  return { improved: bWins, regressed: aWins };
}

/**
 * Minimum detectable effect for a paired binary comparison, in percentage
 * points. Report it under the table so a reader can see which differences the
 * sample size can actually resolve.
 */
export function minDetectableEffect(n: number, discordantRate = 0.25, z = 1.96, zPower = 0.84): number {
  if (n === 0) return 1;
  const nDisc = n * discordantRate;
  if (nDisc <= 0) return 1;
  return ((z + zPower) * Math.sqrt(nDisc) * 0.5 * 2) / n;
}
