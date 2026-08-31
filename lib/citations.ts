import type { Scored, Chunk } from "./retrieval/types";

/**
 * Assembling cited documents, and resolving citations back to printed pages.
 *
 * The trap this file exists to avoid: `page_location` citations — the ones with
 * real `start_page_number` fields — are only ever emitted for `document` blocks
 * whose source is an actual PDF. We send assembled markdown, so every citation
 * comes back as `char_location` with character offsets and NO page fields.
 * Reading `citation.page_location.start_page_number` off those yields
 * `undefined`, and the chip renders "Rulebook p.undefined" on the single feature
 * that justifies the whole project.
 *
 * The fix is that we do not need the API to tell us the page. We assembled the
 * string, so we know exactly which chunk occupies which character range in it,
 * and every chunk already carries its printed page range from ingestion. A
 * citation's `document_index` selects the span map; a binary search on
 * `start_char_index` finds the originating chunk; the page comes from our own
 * data. The API supplies the verbatim `cited_text`, which is the part it is
 * actually authoritative about.
 *
 * Chunks are grouped into one document per section rather than one per chunk.
 * That matters for prohibition questions: a model asked whether something is
 * forbidden needs to see a COMPLETE section to say "the rules are silent here"
 * honestly, and a pile of fragments invites it to assume the missing sentence
 * was simply not retrieved.
 */

export interface Span {
  chunkId: string;
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  title: string;
  docType: string;
}

export interface AssembledDocument {
  /** The Anthropic `document` content block. */
  block: {
    type: "document";
    source: { type: "text"; media_type: "text/plain"; data: string };
    title: string;
    context: string;
    citations: { enabled: true };
  };
  spans: Span[];
}

export interface ResolvedCitation {
  citedText: string;
  chunkId: string | null;
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  title: string;
  docType: string;
  /** "corpus" for our own documents, "web" for web_search results. */
  source: "corpus" | "web";
  url?: string;
}

function pageLabel(c: Chunk): string {
  if (c.pageStart == null) return "";
  return c.pageEnd && c.pageEnd !== c.pageStart
    ? ` (pp. ${c.pageStart}-${c.pageEnd})`
    : ` (p. ${c.pageStart})`;
}

/** Group key: everything but the leaf, so siblings of a section travel together. */
function groupKey(c: Chunk): string {
  return c.docType === "cards"
    ? `cards:${c.sectionPath.slice(0, -1).join(" > ")}`
    : c.sectionPath.slice(0, Math.max(1, c.sectionPath.length - 1)).join(" > ");
}

export function assembleDocuments(scored: Scored[]): AssembledDocument[] {
  const groups = new Map<string, Chunk[]>();
  for (const s of scored) {
    const key = groupKey(s.chunk);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(s.chunk);
  }

  const docs: AssembledDocument[] = [];

  for (const [key, chunks] of groups) {
    // Restore document order within the section so the model reads it the way
    // it was written, not in relevance order.
    chunks.sort((a, b) => a.ordinal - b.ordinal);

    const spans: Span[] = [];
    let text = "";

    for (const c of chunks) {
      const heading = `## ${c.sectionPath.join(" > ")}${pageLabel(c)}\n\n`;
      const start = text.length + heading.length;
      const body = c.content.trim();
      text += heading + body + "\n\n";
      spans.push({
        chunkId: c.id,
        start,
        end: start + body.length,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        sectionPath: c.sectionPath,
        title: c.title,
        docType: c.docType,
      });
    }

    const first = chunks[0];
    const pages = chunks
      .map((c) => c.pageStart)
      .filter((p): p is number => p != null);
    const pageRange = pages.length
      ? ` (pp. ${Math.min(...pages)}-${Math.max(...pages)})`
      : "";

    const label =
      first.docType === "cards"
        ? `Card compendium - ${key.replace(/^cards:/, "")}`
        : `Rulebook - ${key || first.title}${pageRange}`;

    docs.push({
      block: {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: text.trim() },
        title: label,
        context:
          first.docType === "cards"
            ? "Fan-transcribed card reference. Lower authority than the rulebook; if it conflicts with rulebook text, the rulebook wins."
            : `Official rulebook, section "${key || first.title}"${pageRange}.`,
        citations: { enabled: true },
      },
      spans,
    });
  }

  return docs;
}

/** Binary-search a character offset to the chunk that owns it. */
function spanAt(spans: Span[], offset: number): Span | null {
  if (!spans.length) return null;
  let lo = 0;
  let hi = spans.length - 1;
  let best: Span | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= offset) {
      best = spans[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // An offset before the first span means the model cited text inside one of
  // the headings we synthesized. That heading describes the first chunk, so
  // attribute it there rather than dropping the citation on the floor.
  return best ?? spans[0];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function resolveCitation(citation: any, docs: AssembledDocument[]): ResolvedCitation | null {
  if (!citation) return null;

  // Web search results carry their own shape and never touch the span maps.
  if (citation.type === "web_search_result_location" || citation.url) {
    return {
      citedText: citation.cited_text ?? "",
      chunkId: null,
      page: null,
      pageEnd: null,
      sectionPath: [],
      title: citation.title ?? citation.url ?? "web",
      docType: "web",
      source: "web",
      url: citation.url,
    };
  }

  const doc = docs[citation.document_index];
  if (!doc) return null;

  // char_location is what text documents produce. page_location would only
  // appear if we had sent a PDF; handle it anyway so an uploaded-PDF citation
  // flows through the same renderer.
  if (citation.type === "page_location") {
    return {
      citedText: citation.cited_text ?? "",
      chunkId: null,
      page: citation.start_page_number ?? null,
      pageEnd: citation.end_page_number ?? null,
      sectionPath: [],
      title: citation.document_title ?? doc.block.title,
      docType: "rulebook",
      source: "corpus",
    };
  }

  const span = spanAt(doc.spans, citation.start_char_index ?? 0);
  if (!span) {
    // A document we did not assemble (an uploaded file) has no span map. The
    // citation is still real - surface it with the API's own attribution rather
    // than dropping it.
    return {
      citedText: citation.cited_text ?? "",
      chunkId: null,
      page: null,
      pageEnd: null,
      sectionPath: [],
      title: citation.document_title ?? doc.block.title,
      docType: "upload",
      source: "corpus",
    };
  }

  return {
    citedText: citation.cited_text ?? "",
    chunkId: span.chunkId,
    page: span.pageStart,
    pageEnd: span.pageEnd,
    sectionPath: span.sectionPath,
    title: span.title,
    docType: span.docType,
    source: "corpus",
  };
}

/** Human-readable chip label: "Rulebook p.7 - Combat > Blocking". */
export function citationLabel(c: ResolvedCitation): string {
  if (c.source === "web") {
    try {
      return new URL(c.url!).hostname.replace(/^www\./, "");
    } catch {
      return c.title || "web";
    }
  }
  const where = c.sectionPath.length ? c.sectionPath.join(" > ") : c.title;
  if (c.docType === "upload") {
    return c.page != null ? `${c.title} p.${c.page}` : c.title;
  }
  if (c.docType === "cards") return `Card - ${where}`;
  if (c.page == null) return where;
  const pages = c.pageEnd && c.pageEnd !== c.page ? `pp.${c.page}-${c.pageEnd}` : `p.${c.page}`;
  return `Rulebook ${pages} - ${where}`;
}
