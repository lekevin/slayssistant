import fs from "node:fs";
import path from "node:path";

// Static literals so the bundler can trace them; a path built from a variable
// makes Turbopack assume the whole source tree is readable at runtime.
const MANIFEST_PATH = path.join(process.cwd(), "data", "index", "manifest.json");
const PARSE_META_PATH = path.join(process.cwd(), "data", "parsed", "rulebook.meta.json");

/**
 * What the deployed index actually contains. The widget header reads this
 * rather than hardcoding counts, so the UI cannot quietly drift from the index
 * after a re-ingest — and `docSha` makes it possible to tell which parse of the
 * rulebook produced a given answer, which matters when a golden-set label
 * disagrees with what the bot said.
 */
export async function GET() {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    let parsedAt: string | null = null;
    try {
      parsedAt = JSON.parse(fs.readFileSync(PARSE_META_PATH, "utf-8")).parsedAt ?? null;
    } catch {
      // The parse metadata is optional; the index is what matters.
    }
    return Response.json({
      ready: true,
      chunks: manifest.count,
      byDocType: manifest.byDocType ?? {},
      embedModel: manifest.model,
      dims: manifest.dims,
      docSha: manifest.docSha ? String(manifest.docSha).slice(0, 12) : null,
      embeddedAt: manifest.embeddedAt ?? null,
      parsedAt,
    });
  } catch {
    return Response.json(
      { ready: false, error: "Index not built. Run: npm run ingest" },
      { status: 503 }
    );
  }
}
