import fs from "node:fs";
import path from "node:path";
import { buildBm25, type Bm25Index } from "./bm25";
import { fuse } from "./rrf";
import { embedQuery } from "./embed";
import { rerank as crossEncode } from "./rerank";
import type { Chunk, Retriever, SearchOptions, SearchResult, Scored } from "./types";

/**
 * Retrieval over a committed index file.
 *
 * The whole corpus is ~430 chunks. A flat cosine scan over that is roughly a
 * millisecond — comfortably faster than the 40-80ms round trip to any hosted
 * vector database, and it cannot be paused for inactivity, cannot drift from the
 * code that ships alongside it, and costs nothing. The `Retriever` interface
 * exists so this stops being true gracefully: past a handful of games, swap in a
 * pgvector implementation and nothing upstream changes.
 */

interface Manifest {
  model: string;
  dims: number;
  count: number;
  docSha: string | null;
  byDocType: Record<string, number>;
}

/**
 * Built from string literals so the bundler can statically trace it. A path
 * assembled from a variable makes Turbopack assume the whole source tree might
 * be read at runtime, and it ships all of it.
 */
const INDEX_DIR = path.join(process.cwd(), "data", "index");
const CHUNKS_PATH = path.join(process.cwd(), "data", "index", "chunks.json");
const BIN_PATH = path.join(process.cwd(), "data", "index", "embeddings.bin");
const MANIFEST_PATH = path.join(process.cwd(), "data", "index", "manifest.json");

let cached: FileRetriever | null = null;

export function getRetriever(): FileRetriever {
  if (!cached) cached = new FileRetriever();
  return cached;
}

function read(file: string, label: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch {
    throw new Error(`Missing ${label} in ${INDEX_DIR}. Build the index with: npm run ingest`);
  }
}

export class FileRetriever implements Retriever {
  private chunks: Chunk[];
  private vectors: Float32Array;
  private manifest: Manifest;
  private bm25: Bm25Index;
  private byId: Map<string, Chunk>;

  constructor() {
    this.chunks = JSON.parse(read(CHUNKS_PATH, "chunks.json").toString("utf-8"));
    this.manifest = JSON.parse(read(MANIFEST_PATH, "manifest.json").toString("utf-8"));

    const buf = read(BIN_PATH, "embeddings.bin");
    const expected = this.chunks.length * this.manifest.dims * 4;
    if (buf.length !== expected) {
      throw new Error(
        `embeddings.bin is ${buf.length} bytes but chunks.json implies ${expected} ` +
          `(${this.chunks.length} chunks x ${this.manifest.dims} dims). Re-run: npm run embed`
      );
    }
    // Copy rather than aliasing the Buffer's pool, whose byteOffset may not be
    // 4-byte aligned for a Float32Array view.
    this.vectors = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );

    // BM25 sees breadcrumb + content, matching what was embedded, so both arms
    // are searching the same text.
    this.bm25 = buildBm25(
      this.chunks.map((c) => `${c.sectionPath.join(" ")} ${c.content}`)
    );
    this.byId = new Map(this.chunks.map((c) => [c.id, c]));
  }

  all(): Chunk[] {
    return this.chunks;
  }

  get(id: string): Chunk | undefined {
    return this.byId.get(id);
  }

  get info() {
    return { ...this.manifest, chunks: this.chunks.length };
  }

  private cosine(queryVec: Float32Array, i: number): number {
    const { dims } = this.manifest;
    const base = i * dims;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let d = 0; d < dims; d++) {
      const a = queryVec[d];
      const b = this.vectors[base + d];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const k = opts.k ?? 8;
    const perArmK = opts.perArmK ?? 40;
    const arms = opts.arms ?? ["dense", "sparse"];
    const timings: Record<string, number> = {};

    const allowed = opts.docTypes
      ? new Set(opts.docTypes)
      : null;
    const eligible = allowed
      ? this.chunks.map((c, i) => (allowed.has(c.docType) ? i : -1)).filter((i) => i >= 0)
      : null;

    const indices = eligible ?? this.chunks.map((_, i) => i);
    let t: number;

    // --- dense arm -------------------------------------------------------
    let dense: Array<{ i: number; score: number }> = [];
    if (arms.includes("dense")) {
      t = Date.now();
      const qv = Float32Array.from(
        await embedQuery(query, { model: this.manifest.model, dims: this.manifest.dims })
      );
      timings.embed = Date.now() - t;

      t = Date.now();
      const scoredAll: Array<{ i: number; score: number }> = [];
      for (const i of indices) scoredAll.push({ i, score: this.cosine(qv, i) });
      scoredAll.sort((a, b) => b.score - a.score);
      dense = scoredAll.slice(0, perArmK);
      timings.dense = Date.now() - t;
    }

    // --- sparse arm ------------------------------------------------------
    let sparse: Array<{ index: number; score: number }> = [];
    if (arms.includes("sparse")) {
      t = Date.now();
      const raw = this.bm25.score(query, perArmK * 2);
      sparse = (eligible ? raw.filter((s) => allowed!.has(this.chunks[s.index].docType)) : raw).slice(
        0,
        perArmK
      );
      timings.sparse = Date.now() - t;
    }

    // --- fuse ------------------------------------------------------------
    t = Date.now();
    const lists = [];
    if (arms.includes("dense")) lists.push({ name: "dense", ids: dense.map((d) => this.chunks[d.i].id) });
    if (arms.includes("sparse")) lists.push({ name: "sparse", ids: sparse.map((s) => this.chunks[s.index].id) });
    let fused = fuse(lists);
    timings.fuse = Date.now() - t;

    // --- rerank ----------------------------------------------------------
    // A cross-encoder reads query and passage together, which is the only stage
    // that can tell "mentions Traps" from "governs when Traps may be played".
    let reranked: Array<{ id: string; rank: number; score: number }> | undefined;
    if (opts.rerank && fused.length) {
      t = Date.now();
      const candidates = fused.slice(0, perArmK);
      const texts = candidates.map((f) => {
        const c = this.byId.get(f.id);
        return c ? `${c.sectionPath.join(" > ")}\n${c.content}` : "";
      });
      const order = await crossEncode(query, texts, { model: opts.rerankModel, topK: candidates.length });
      reranked = order.map((r, i) => ({ id: candidates[r.index].id, rank: i + 1, score: Number(r.score.toFixed(4)) }));
      const rankById = new Map(reranked.map((r) => [r.id, r]));
      fused = order.map((r) => {
        const orig = candidates[r.index];
        return { ...orig, score: rankById.get(orig.id)!.score };
      });
      timings.rerank = Date.now() - t;
    }

    let selected = fused.slice(0, k);

    // --- section-complete expansion --------------------------------------
    // For prohibition-shaped questions ("can I...", "am I allowed..."), a
    // fragment cannot support an honest "no": the qualifying sentence may be the
    // one that was chunked away. Absence is only assertable over a complete
    // unit, so widen to every sibling sharing the top hit's section.
    let expandedFrom: string[] | undefined;
    if (opts.sectionComplete && selected.length) {
      const seedPath = this.byId.get(selected[0].id)?.sectionPath ?? [];
      const prefix = seedPath.slice(0, Math.max(1, seedPath.length - 1)).join(" > ");
      const siblings = this.chunks.filter(
        (c) =>
          c.docType !== "cards" &&
          c.sectionPath.slice(0, Math.max(1, c.sectionPath.length - 1)).join(" > ") === prefix
      );
      expandedFrom = selected.map((s) => s.id);
      const have = new Set(selected.map((s) => s.id));
      for (const sib of siblings) {
        if (have.has(sib.id)) continue;
        selected.push({ id: sib.id, score: 0, ranks: {} });
        have.add(sib.id);
      }
      // Keep the assembled context bounded.
      selected = selected.slice(0, Math.max(k, 14));
    }

    const results: Scored[] = [];
    for (const f of selected) {
      const chunk = this.byId.get(f.id);
      if (!chunk) continue;
      results.push({
        chunk,
        score: f.score,
        ranks: { dense: f.ranks.dense, sparse: f.ranks.sparse },
      });
    }

    return {
      results,
      trace: {
        query,
        dense: dense.slice(0, 12).map((d, i) => ({
          id: this.chunks[d.i].id,
          rank: i + 1,
          score: Number(d.score.toFixed(4)),
        })),
        sparse: sparse.slice(0, 12).map((s, i) => ({
          id: this.chunks[s.index].id,
          rank: i + 1,
          score: Number(s.score.toFixed(4)),
        })),
        fused: fused.slice(0, 12).map((f, i) => ({
          id: f.id,
          rank: i + 1,
          score: Number(f.score.toFixed(5)),
        })),
        reranked: reranked?.slice(0, 12),
        expandedFrom,
        timings,
      },
    };
  }
}
