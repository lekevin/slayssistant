#!/usr/bin/env node
/**
 * Stage 3 of ingestion: chunks -> a committed vector index.
 *
 * Model choice: voyage-4. The architecture doc specified voyage-3.5, which is
 * now a LEGACY model carrying zero free tokens - Voyage's 200M free-token tier
 * applies only to the v4 family. voyage-4 is priced identically and scores
 * better, so 3.5 was strictly dominated.
 *
 * What actually gets embedded is not the raw chunk. Rulebook prose is dense with
 * pronouns and implied subjects: "This may only be done once per turn" is nearly
 * useless as an embedding because nothing in it says what "this" is. So we
 * prepend the section breadcrumb, which recovers most of that context for free.
 * (The fuller version of this idea - a model-written situating sentence per
 * chunk - is a later step, and the ablation harness is built to measure whether
 * it is worth the money.)
 *
 * Everything is cached by content hash. The whole project is re-running
 * ingestion with different settings, and re-paying for unchanged chunks would
 * make that loop expensive enough to discourage the experimentation the project
 * exists to do.
 *
 * Usage: npm run embed [-- --force]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.join(import.meta.dirname, "..");
const CHUNKS = path.join(ROOT, "data/index/chunks.json");
const BIN = path.join(ROOT, "data/index/embeddings.bin");
const MANIFEST = path.join(ROOT, "data/index/manifest.json");
const CACHE = path.join(ROOT, "data/index/.embed-cache.json");

const MODEL = process.env.VOYAGE_MODEL || "voyage-4";
const DIMS = Number(process.env.VOYAGE_DIMS || 1024);
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// Voyage caps documents and tokens per request, and separately caps REQUEST
// RATE per account. These defaults suit an account with a payment method on
// file; the free token allowance applies either way.
//
// An account with NO payment method is limited to 3 requests/minute and 10,000
// tokens/minute - two orders of magnitude lower. On that tier, run:
//   VOYAGE_RPM=3 VOYAGE_TPM=9000 npm run embed
// The backoff below recovers either way, but pacing deliberately beats
// discovering the limit through 429s.
const BATCH_SIZE = Number(process.env.VOYAGE_BATCH_SIZE || 64);
const TPM = Number(process.env.VOYAGE_TPM || 300000);
const RPM = Number(process.env.VOYAGE_RPM || 60);
const BATCH_TOKEN_BUDGET = Math.min(Number(process.env.VOYAGE_BATCH_TOKENS || 8000), TPM);
const MIN_REQUEST_GAP_MS = Math.ceil(60000 / RPM);

const force = process.argv.includes("--force");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const estTokens = (s) => Math.ceil(s.length / 4);

if (!process.env.VOYAGE_API_KEY) {
  console.error("VOYAGE_API_KEY is not set. Get one at https://dash.voyageai.com (the v4 family");
  console.error("carries a 200M free-token tier, which covers this project permanently).");
  process.exit(1);
}
if (!fs.existsSync(CHUNKS)) {
  console.error(`No ${path.relative(ROOT, CHUNKS)}. Run \`npm run chunk\` first.`);
  process.exit(1);
}

const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));

/**
 * The string we actually embed. Breadcrumb first so the vector carries the
 * chunk's location in the document, not just its words.
 */
export function embedInput(c) {
  const crumb = c.sectionPath?.length ? c.sectionPath.join(" > ") : c.title;
  return `${crumb}\n\n${c.content}`;
}

const cache = !force && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf-8")) : {};
const cacheKey = (input) => `${MODEL}:${DIMS}:${sha(input)}`;

const inputs = chunks.map(embedInput);
const needed = [];
inputs.forEach((input, i) => {
  if (!cache[cacheKey(input)]) needed.push(i);
});

console.log(`${chunks.length} chunks, ${chunks.length - needed.length} cached, ${needed.length} to embed.`);
if (needed.length) {
  console.log(`  model ${MODEL}, ${DIMS} dims, ~${needed.reduce((a, i) => a + estTokens(inputs[i]), 0).toLocaleString()} tokens`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Paces requests against both the per-minute request cap and the per-minute
 * token cap. Backing off only after a 429 wastes the whole minute the limiter
 * is measuring, so we stay under it deliberately instead.
 */
const window = [];
let lastRequestAt = 0;

async function throttle(tokens) {
  for (;;) {
    const now = Date.now();
    while (window.length && now - window[0].at > 60000) window.shift();
    const used = window.reduce((a, w) => a + w.tokens, 0);

    const waitForTokens = used + tokens > TPM && window.length
      ? 60000 - (now - window[0].at) + 250
      : 0;
    const waitForRate = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - now);
    const wait = Math.max(waitForTokens, waitForRate);

    if (wait <= 0) {
      lastRequestAt = Date.now();
      window.push({ at: lastRequestAt, tokens });
      return;
    }
    process.stdout.write(`\r  waiting ${Math.ceil(wait / 1000)}s for rate limit...          `);
    await sleep(Math.min(wait, 5000));
  }
}

async function embedBatch(texts, attempt = 1) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: "document",
      output_dimension: DIMS,
    }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 8) throw new Error(`Voyage ${res.status} after 8 attempts: ${await res.text()}`);
    // Honour Retry-After when the server sends one; otherwise back off past the
    // full rate-limit window, since a shorter wait just burns another attempt.
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    const wait = retryAfter || Math.min(MIN_REQUEST_GAP_MS * attempt, 90000);
    process.stdout.write(`\r  ${res.status}, retrying in ${Math.ceil(wait / 1000)}s (attempt ${attempt})       `);
    await sleep(wait);
    return embedBatch(texts, attempt + 1);
  }
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);

  const json = await res.json();
  // The API does not promise ordering; index is authoritative.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Batch by both count and token budget.
const batches = [];
let cur = [];
let curTokens = 0;
for (const i of needed) {
  const t = estTokens(inputs[i]);
  if (cur.length && (cur.length >= BATCH_SIZE || curTokens + t > BATCH_TOKEN_BUDGET)) {
    batches.push(cur);
    cur = [];
    curTokens = 0;
  }
  cur.push(i);
  curTokens += t;
}
if (cur.length) batches.push(cur);

if (batches.length) {
  const totalTok = needed.reduce((a, i) => a + estTokens(inputs[i]), 0);
  const etaMin = Math.ceil(Math.max(batches.length / RPM, totalTok / TPM));
  console.log(`  ${batches.length} batches at ${RPM} req/min and ${TPM.toLocaleString()} tok/min - about ${etaMin} min.`);
}

let done = 0;
for (const batch of batches) {
  const tokens = batch.reduce((a, i) => a + estTokens(inputs[i]), 0);
  await throttle(tokens);

  const vectors = await embedBatch(batch.map((i) => inputs[i]));
  if (vectors.length !== batch.length) {
    throw new Error(`Voyage returned ${vectors.length} vectors for ${batch.length} inputs.`);
  }
  vectors.forEach((v, k) => {
    if (v.length !== DIMS) throw new Error(`Expected ${DIMS} dims, got ${v.length}.`);
    cache[cacheKey(inputs[batch[k]])] = v;
  });
  done += batch.length;

  // Checkpoint after every batch. A rate limit twenty minutes into a run should
  // cost one batch, not the whole run - re-running then resumes where it
  // stopped, which is the entire point of a content-addressed cache.
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  process.stdout.write(`\r  embedded ${done}/${needed.length}                              `);
}
if (needed.length) process.stdout.write("\n");

// Write a dense float32 matrix, row i == chunks[i]. At this corpus size a flat
// scan is ~1ms, which is faster than a network round trip to a hosted vector
// store would be - so there is no index structure here on purpose.
const buf = Buffer.alloc(chunks.length * DIMS * 4);
let missing = 0;
inputs.forEach((input, i) => {
  const v = cache[cacheKey(input)];
  if (!v) { missing++; return; }
  for (let d = 0; d < DIMS; d++) buf.writeFloatLE(v[d], (i * DIMS + d) * 4);
});
if (missing) throw new Error(`${missing} chunks have no embedding.`);

fs.writeFileSync(BIN, buf);

const parsedMeta = path.join(ROOT, "data/parsed/rulebook.meta.json");
fs.writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      model: MODEL,
      dims: DIMS,
      count: chunks.length,
      byDocType: chunks.reduce((a, c) => ({ ...a, [c.docType]: (a[c.docType] || 0) + 1 }), {}),
      docSha: fs.existsSync(parsedMeta) ? JSON.parse(fs.readFileSync(parsedMeta, "utf-8")).docSha : null,
      embeddedAt: new Date().toISOString(),
      bytes: buf.length,
    },
    null,
    2
  ) + "\n"
);

console.log(`Wrote ${path.relative(ROOT, BIN)} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  ${chunks.length} x ${DIMS} float32`);
console.log(`Wrote ${path.relative(ROOT, MANIFEST)}`);
console.log("\nCommit data/index/ - it is the shipped index. Next: npm run dev");
