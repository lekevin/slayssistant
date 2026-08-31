"use client";

import { useState } from "react";

/**
 * "Why this answer" — the retrieval trace for the question just asked.
 *
 * This is the part of the project worth showing someone. An answer with a
 * citation is table stakes; a published benchmark table is a table of numbers on
 * a website, and a skeptical reader knows that is exactly what a candidate would
 * fabricate. What cannot be faked is a working instrument. Every number here is
 * produced by the request you just made.
 *
 * The row worth looking at is the rank delta: a chunk that placed 9th on
 * embedding similarity and 1st after fusion is the whole argument for hybrid
 * retrieval, made concrete on a question the reader chose.
 */

export interface Trace {
  shape: string;
  entities: string[];
  retrieved: Array<{
    id: string;
    title: string;
    sectionPath: string[];
    docType: string;
    page: number | null;
    score: number;
    ranks: { dense?: number; sparse?: number };
    tokens: number;
  }>;
  dense: Array<{ id: string; rank: number; score: number }>;
  sparse: Array<{ id: string; rank: number; score: number }>;
  fused: Array<{ id: string; rank: number; score: number }>;
  expandedFrom?: string[];
  documents: Array<{ title: string; chunks: number }>;
  timings: Record<string, number>;
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

function Delta({ from, to }: { from?: number; to: number }) {
  if (from == null) {
    return (
      <span style={{ color: "#A85C00", fontFamily: mono, fontSize: ".7rem" }} title="not returned by the dense arm">
        new
      </span>
    );
  }
  const d = from - to;
  if (d === 0) return <span style={{ color: "#8a8a8a", fontFamily: mono, fontSize: ".7rem" }}>—</span>;
  return (
    <span
      style={{ color: d > 0 ? "#0B6B70" : "#A33232", fontFamily: mono, fontSize: ".7rem" }}
      title={`dense rank ${from} → fused rank ${to}`}
    >
      {d > 0 ? `▲${d}` : `▼${-d}`}
    </span>
  );
}

export default function TracePanel({ trace }: { trace: Trace }) {
  const [open, setOpen] = useState(false);

  const denseRank = new Map(trace.dense.map((d) => [d.id, d.rank]));
  const sparseRank = new Map(trace.sparse.map((s) => [s.id, s.rank]));
  const expanded = new Set(trace.expandedFrom ?? []);
  const totalMs = Object.values(trace.timings).reduce((a, b) => a + b, 0);

  return (
    <div style={{ marginTop: ".6rem", borderTop: "1px solid #E4EBEB", paddingTop: ".5rem" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: mono,
          fontSize: ".7rem",
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: "#5D6E71",
        }}
      >
        {open ? "▾" : "▸"} why this answer · {trace.retrieved.length} sections · {totalMs}ms retrieval
      </button>

      {open && (
        <div style={{ marginTop: ".75rem", fontSize: ".8125rem" }}>
          <div style={{ marginBottom: ".6rem", color: "#5D6E71", fontFamily: mono, fontSize: ".72rem" }}>
            shape=<strong style={{ color: "#0B6B70" }}>{trace.shape}</strong>
            {trace.entities.length > 0 && <> · entities: {trace.entities.join(", ")}</>}
            {trace.expandedFrom && (
              <>
                {" "}
                · <span style={{ color: "#A85C00" }}>section-complete expansion</span>
              </>
            )}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: ".75rem" }}>
              <thead>
                <tr>
                  {["#", "dense", "bm25", "Δ", "section", "page", "rrf"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: ".3rem .5rem",
                        borderBottom: "1px solid #D3DEDE",
                        fontFamily: mono,
                        fontSize: ".65rem",
                        letterSpacing: ".08em",
                        textTransform: "uppercase",
                        color: "#5D6E71",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trace.retrieved.map((r, i) => {
                  const dr = denseRank.get(r.id);
                  const sr = sparseRank.get(r.id);
                  const wasExpanded = trace.expandedFrom && !expanded.has(r.id);
                  return (
                    <tr key={r.id} style={{ opacity: wasExpanded ? 0.55 : 1 }}>
                      <td style={{ padding: ".3rem .5rem", fontFamily: mono, color: "#5D6E71" }}>{i + 1}</td>
                      <td style={{ padding: ".3rem .5rem", fontFamily: mono }}>{dr ?? "·"}</td>
                      <td style={{ padding: ".3rem .5rem", fontFamily: mono }}>{sr ?? "·"}</td>
                      <td style={{ padding: ".3rem .5rem" }}>
                        <Delta from={dr} to={i + 1} />
                      </td>
                      <td style={{ padding: ".3rem .5rem", maxWidth: "22rem" }}>
                        {r.sectionPath.join(" › ")}
                        {wasExpanded && (
                          <span style={{ color: "#A85C00", fontFamily: mono, fontSize: ".65rem" }}>
                            {" "}
                            +sibling
                          </span>
                        )}
                      </td>
                      <td style={{ padding: ".3rem .5rem", fontFamily: mono, color: "#5D6E71" }}>
                        {r.page ?? (r.docType === "cards" ? "card" : "·")}
                      </td>
                      <td style={{ padding: ".3rem .5rem", fontFamily: mono, color: "#5D6E71" }}>
                        {r.score.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: ".6rem", fontFamily: mono, fontSize: ".68rem", color: "#8a8a8a" }}>
            {Object.entries(trace.timings)
              .map(([k, v]) => `${k} ${v}ms`)
              .join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}
