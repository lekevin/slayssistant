/**
 * BM25 over the corpus.
 *
 * Dense embeddings blur exactly the tokens this domain depends on: card names,
 * "3+", "Chapter 4", "Exhaust". Keyword search nails those and fails at
 * paraphrase, which is the complementary failure — hence both arms.
 *
 * Two deliberate departures from a stock text index:
 *
 * 1. NO STEMMING. A Porter/Snowball stemmer maps "Exhausted" and "Exhausting"
 *    onto "exhaust", which sounds helpful until you notice that in this game
 *    Exhaust is a specific keyword with a specific rule, and conflating it with
 *    ordinary English usage is precisely the error the retriever must not make.
 *    Game jargon is not English morphology.
 *
 * 2. NUMBERS AND PUNCTUATION SURVIVE tokenization. "4.2", "3+", "2x" are rule
 *    identifiers and quantities. A tokenizer that splits on every non-letter
 *    turns "section 4.2" into "section", "4", "2" and loses the reference.
 */

const K1 = 1.5;
const B = 0.75;

// Only words that carry no discriminating power anywhere in a rulebook. Kept
// deliberately short: "may", "must", "cannot", "not" and "each" are load-bearing
// in rules text and must never be dropped.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "these", "those",
  "as", "by", "with", "from", "i", "you", "he", "she", "they", "we",
]);

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Keep internal dots, plus and hyphen so "4.2", "3+", "re-shuffle" survive.
      .split(/[^a-z0-9.+-]+/)
      // Trailing '.' and '-' are punctuation; a trailing '+' is not - "3+"
      // means "three or more" and stripping it collapses a quantity into a
      // different one.
      .map((t) => t.replace(/^[.+-]+/, "").replace(/[.-]+$/, ""))
      .filter((t) => t.length > 0 && !STOPWORDS.has(t))
  );
}

export interface Bm25Index {
  score(query: string, k: number): Array<{ index: number; score: number }>;
}

export function buildBm25(documents: string[]): Bm25Index {
  const docs = documents.map(tokenize);
  const n = docs.length;
  const lengths = docs.map((d) => d.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / (n || 1);

  // term -> postings list of [docIndex, termFrequency]
  const postings = new Map<string, Array<[number, number]>>();
  docs.forEach((tokens, i) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, freq] of tf) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push([i, freq]);
    }
  });

  return {
    score(query, k) {
      const terms = [...new Set(tokenize(query))];
      const scores = new Map<number, number>();

      for (const term of terms) {
        const list = postings.get(term);
        if (!list) continue;
        // BM25 IDF with the +0.5 smoothing; floored at a small positive value so
        // a term appearing in most documents contributes ~nothing rather than
        // subtracting from the score of documents that legitimately contain it.
        const df = list.length;
        const idf = Math.max(Math.log((n - df + 0.5) / (df + 0.5) + 1), 1e-6);

        for (const [i, freq] of list) {
          const norm = 1 - B + (B * lengths[i]) / (avgLen || 1);
          const contribution = (idf * (freq * (K1 + 1))) / (freq + K1 * norm);
          scores.set(i, (scores.get(i) ?? 0) + contribution);
        }
      }

      return [...scores.entries()]
        .map(([index, score]) => ({ index, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}
