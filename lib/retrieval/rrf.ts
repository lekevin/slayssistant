/**
 * Reciprocal Rank Fusion.
 *
 * Cosine distance and BM25 scores live on incomparable scales, and any
 * normalization you pick to blend them becomes a magic number you re-tune every
 * time the corpus changes. Ranks are already comparable, so fuse on those
 * instead: each arm contributes 1/(K + rank), and a chunk that both arms like
 * outranks one that a single arm loves.
 *
 * K=60 is the value from the original Cormack et al. paper and is not
 * sensitive enough at this corpus size to be worth tuning.
 */

export const RRF_K = 60;

export interface RankedList {
  name: string;
  /** Ordered best-first. */
  ids: string[];
  /** Raw per-arm scores, kept for the trace panel. */
  scores?: Map<string, number>;
}

export interface FusedEntry {
  id: string;
  score: number;
  ranks: Record<string, number>;
}

export function fuse(lists: RankedList[], k = RRF_K): FusedEntry[] {
  const acc = new Map<string, FusedEntry>();

  for (const list of lists) {
    list.ids.forEach((id, i) => {
      const rank = i + 1;
      let entry = acc.get(id);
      if (!entry) acc.set(id, (entry = { id, score: 0, ranks: {} }));
      entry.score += 1 / (k + rank);
      entry.ranks[list.name] = rank;
    });
  }

  return [...acc.values()].sort((a, b) => b.score - a.score);
}
