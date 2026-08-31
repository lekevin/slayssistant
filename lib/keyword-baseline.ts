/**
 * The prototype's original retrieval, preserved verbatim as an evaluation
 * baseline.
 *
 * This is keyword overlap weighted by inverse document frequency - no
 * embeddings, no vector store, about sixty lines. It is row 0.5 of the ablation
 * table, and it is there because beating a strawman proves nothing. If the full
 * hybrid pipeline cannot clear this on the golden set, that is the finding, and
 * it is worth more than a chart showing dense-only retrieval losing to itself.
 *
 * Do not "improve" this file. Its value is that it is exactly what shipped
 * before, so the comparison is honest.
 */
export type CorpusChunk = { id: string; text: string };

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "can",
  "i", "you", "he", "she", "it", "we", "they", "to", "of", "in", "on", "at",
  "for", "and", "or", "if", "then", "than", "that", "this", "these", "those",
  "my", "your", "what", "when", "how", "why", "with", "as", "be", "have",
  "has", "had", "not", "no", "yes", "there", "their", "its", "who", "which",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Very lightweight keyword-overlap retrieval — no embeddings/vector DB
 * dependency. Good enough for a single rulebook-sized corpus. Swap this out
 * for real embeddings later if the corpus grows (e.g. multiple games).
 *
 * Terms are weighted by inverse document frequency so a distinctive word
 * (a card name like "uppercut", which appears in ~1 chunk) outweighs a
 * generic word that happens to appear in hundreds of chunks (like "card" or
 * "attack") — without this, a query like "what does Uppercut do" ties with
 * dozens of unrelated rulebook chunks that also mention "card", and the
 * actual Uppercut chunk can get crowded out of the top N by array order.
 */
export function retrieveRelevantChunks(
  query: string,
  chunks: CorpusChunk[],
  topN = 6,
  maxChars = 9000
): CorpusChunk[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return chunks.slice(0, topN);
  }

  const chunkTermSets = chunks.map((chunk) => new Set(tokenize(chunk.text)));

  const docFreq = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let df = 0;
    for (const termSet of chunkTermSets) {
      if (termSet.has(term)) df++;
    }
    docFreq.set(term, df);
  }
  const idf = (term: string) => {
    const df = docFreq.get(term) ?? 0;
    return Math.log((chunks.length + 1) / (df + 1)) + 1; // always positive, higher for rarer terms
  };

  const scored = chunks.map((chunk, i) => {
    const termSet = chunkTermSets[i];
    let score = 0;
    for (const t of queryTerms) {
      if (termSet.has(t)) score += idf(t);
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: CorpusChunk[] = [];
  let budget = maxChars;
  for (const { chunk, score } of scored) {
    if (picked.length >= topN) break;
    if (score === 0 && picked.length > 0) break; // stop once relevance drops to zero
    if (chunk.text.length > budget) continue;
    picked.push(chunk);
    budget -= chunk.text.length;
  }

  // Guarantee at least a couple of chunks so the model has *something* even
  // for oddly-phrased questions with little keyword overlap.
  if (picked.length === 0) {
    return chunks.slice(0, Math.min(2, chunks.length));
  }
  return picked;
}
