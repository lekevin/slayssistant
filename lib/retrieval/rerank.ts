/**
 * Cross-encoder reranking.
 *
 * Every prior stage scores the query and the passage independently and compares
 * the results. A cross-encoder reads them TOGETHER, which is the only mechanism
 * in the pipeline that can distinguish "this passage mentions Traps" from "this
 * passage governs when Traps may be played." After hybrid retrieval that is
 * where the largest remaining quality gain sits.
 *
 * It is deliberately a separate stage behind its own function rather than
 * folded into the retriever, because it is the component most likely to be
 * swapped (Cohere, Zerank, a local BGE reranker) and because the ablation needs
 * to run with it switched off.
 *
 * One thing it CANNOT do, which matters for this corpus: a relevance score
 * expresses topical fit, not sufficiency. A passage that is squarely about the
 * question and simply silent on it scores high. That is why the web-search
 * fallback is gated on question shape rather than on this number - see
 * lib/prohibition.ts.
 */

const ENDPOINT = "https://api.voyageai.com/v1/rerank";

export interface RerankOptions {
  model?: string;
  topK?: number;
  signal?: AbortSignal;
}

export interface RerankResult {
  /** Index into the documents array as passed in. */
  index: number;
  score: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rerank(
  query: string,
  documents: string[],
  opts: RerankOptions = {},
  attempt = 1
): Promise<RerankResult[]> {
  if (!documents.length) return [];
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set.");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      documents,
      model: opts.model ?? "rerank-2.5-lite",
      top_k: opts.topK ?? documents.length,
    }),
    signal: opts.signal,
  });

  // A Voyage account with no payment method on file is capped at 3 requests per
  // minute, which an ablation sweep hits immediately.
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) {
      throw new Error(`Voyage rerank ${res.status} after 6 attempts: ${(await res.text()).slice(0, 200)}`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    await sleep(retryAfter || Math.min(20000 * attempt, 90000));
    return rerank(query, documents, opts, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Voyage rerank ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data: Array<{ index: number; relevance_score: number }>;
  };
  return json.data
    .map((d) => ({ index: d.index, score: d.relevance_score }))
    .sort((a, b) => b.score - a.score);
}
