/**
 * Query-side embedding.
 *
 * Voyage distinguishes `input_type: "query"` from `"document"` and embeds them
 * into the same space with different instructions — passing the wrong one costs
 * real retrieval quality, so the ingestion script and this file must stay in
 * agreement about the model and dimensionality. `manifest.json` records what the
 * index was actually built with, and the retriever refuses to run on a mismatch
 * rather than silently returning nonsense.
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/**
 * Distinguishable from a retrieval miss on purpose. An eval that scores a rate
 * limit as "the retriever did not find it" reports a quietly wrong number, and
 * the number is the entire deliverable.
 */
export class RateLimitedError extends Error {
  readonly rateLimited = true;
}

/**
 * Optional disk cache for query embeddings, enabled by setting
 * RL_EMBED_CACHE to a file path. Off in production - a live question is
 * embedded once and never asked again - but the ablation harness reruns the
 * same golden set through every arm, and on a rate-limited account that is the
 * difference between a three-minute eval and a thirty-minute one.
 */
const CACHE_PATH = process.env.RL_EMBED_CACHE;
let diskCache: Record<string, number[]> | null = null;

function loadCache(): Record<string, number[]> {
  if (diskCache) return diskCache;
  if (!CACHE_PATH) return (diskCache = {});
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    diskCache = JSON.parse(require("node:fs").readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    diskCache = {};
  }
  return diskCache!;
}

function saveCache() {
  if (!CACHE_PATH || !diskCache) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").writeFileSync(CACHE_PATH, JSON.stringify(diskCache));
  } catch {
    // A cache that cannot be written is not an error worth failing a run over.
  }
}

export interface EmbedOptions {
  model: string;
  dims: number;
  inputType?: "query" | "document";
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Voyage account with no payment method on file is capped at 3 requests per
 * minute. That is fine for live traffic - one question, one embedding - but an
 * eval sweep or a burst of visitors hits it immediately, and an unhandled 429
 * here surfaces as a retrieval failure rather than as what it is.
 */
export async function embed(
  texts: string[],
  opts: EmbedOptions,
  attempt = 1
): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set.");
  if (!texts.length) return [];

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: texts,
      model: opts.model,
      input_type: opts.inputType ?? "query",
      output_dimension: opts.dims,
    }),
    signal: opts.signal,
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) {
      throw new RateLimitedError(
        `Voyage ${res.status} after 6 attempts: ${(await res.text()).slice(0, 200)}`
      );
    }
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    await sleep(retryAfter || Math.min(21000 * attempt, 90000));
    return embed(texts, opts, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  // Ordering is not promised; index is authoritative.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedQuery(text: string, opts: Omit<EmbedOptions, "inputType">): Promise<number[]> {
  const key = `${opts.model}:${opts.dims}:${text}`;
  const cache = loadCache();
  if (cache[key]) return cache[key];

  const [v] = await embed([text], { ...opts, inputType: "query" });
  if (CACHE_PATH) {
    cache[key] = v;
    saveCache();
  }
  return v;
}
