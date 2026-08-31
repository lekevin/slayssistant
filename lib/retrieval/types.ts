/**
 * The retrieval seam.
 *
 * Everything above this interface — the chat route, the eval harness, the trace
 * panel — talks only to `Retriever`. That is deliberate: today the index is a
 * ~1.7 MB float32 file read straight off disk, because at this corpus size a
 * flat scan takes about a millisecond and a network round trip to a hosted
 * vector store would take forty. When the library outgrows one game, a
 * `PgVectorRetriever` drops in behind the same three methods and nothing above
 * this file changes.
 */

export type DocType = "rulebook" | "cards" | "errata" | "faq" | "strategy";

export interface Chunk {
  id: string;
  ordinal: number;
  docId: string;
  docType: DocType;
  /** Errata 30 > faq 20 > rulebook 10 > cards 5 (fan-transcribed) > strategy 0. */
  authority: number;
  /** Breadcrumb, e.g. ["Combat", "Blocking", "Timing"]. */
  sectionPath: string[];
  title: string;
  part: number | null;
  partsTotal: number | null;
  /** Printed page numbers. Null for cards, which have no page. */
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  tokenCount: number;
  srcStart: number | null;
  srcEnd: number | null;
  mergedTitles: string[] | null;
  cardName?: string;
  cardCost?: string | null;
  cardType?: string | null;
}

export interface Scored {
  chunk: Chunk;
  /** Fused score. Only comparable within one result set. */
  score: number;
  /** Per-arm ranks, 1-indexed. Absent when an arm did not return the chunk. */
  ranks: { dense?: number; sparse?: number };
}

export interface SearchOptions {
  k?: number;
  /** Candidate depth per arm before fusion. */
  perArmK?: number;
  /**
   * Which retrieval arms to run. The ablation harness drives this to isolate
   * what each stage is actually worth; production uses both.
   */
  arms?: Array<"dense" | "sparse">;
  /** Run the cross-encoder over the fused candidates. */
  rerank?: boolean;
  /** Override the rerank model (ablation only). */
  rerankModel?: string;
  /** Restrict to specific document types. */
  docTypes?: DocType[];
  /**
   * Retrieve whole sections rather than fragments. Used for prohibition-shaped
   * questions, where absence can only be honestly asserted over a complete unit.
   */
  sectionComplete?: boolean;
}

/** Everything the pipeline did, surfaced for the trace panel and the eval. */
export interface SearchTrace {
  query: string;
  dense: Array<{ id: string; rank: number; score: number }>;
  sparse: Array<{ id: string; rank: number; score: number }>;
  fused: Array<{ id: string; rank: number; score: number }>;
  reranked?: Array<{ id: string; rank: number; score: number }>;
  expandedFrom?: string[];
  timings: Record<string, number>;
}

export interface SearchResult {
  results: Scored[];
  trace: SearchTrace;
}

export interface Retriever {
  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
  /** Every chunk, in ordinal order. Used by the stuffed-prompt eval baseline. */
  all(): Chunk[];
  get(id: string): Chunk | undefined;
}
