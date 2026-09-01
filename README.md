# Rules Lawyer

A board game rules assistant. Ask whether you can actually do that, and get an answer grounded in the
game's own rulebook with the page attached — or an honest "the rules don't say," which is the answer more
often than a rules bot usually admits.

Built on *Slay the Spire: The Board Game*: the official rulebook plus a 382-entry card compendium.

---

## Why there is no vector database

The whole corpus is about 23,000 tokens. That number drives most of the architecture, and it is worth
stating plainly because it is the first thing a reader should interrogate.

At 472 chunks, the index is a 1.84 MB float32 file. A flat cosine scan over it takes about a millisecond —
roughly forty times faster than the network round trip to a hosted vector store would be, before that store
has done any work. So the index is a file, committed to the repo and loaded once per cold start.

That is not a shortcut around the hard part. Every retrieval technique the project exists to exercise is
still here: dense embeddings, BM25, reciprocal rank fusion, structural chunking, page-accurate citations,
and an evaluation harness that measures whether any of it helps. What is absent is the operational
surface — migrations, connection pooling, HNSW tuning, and a free tier that pauses after seven days of
inactivity and needs a human to click Restore, which is a bad property for a link someone opens three weeks
after you send it.

Retrieval sits behind a one-method interface (`lib/retrieval/types.ts`). When the library outgrows one
game, a `PgVectorRetriever` drops in and nothing upstream changes. The interesting question is not whether
to use a vector database; it is at what corpus size one starts paying for itself. This project is built to
answer that with a number rather than a preference.

**The honest baseline.** At 23K tokens the entire corpus fits in a prompt-cached prefix, which costs about
a penny per question and has perfect recall by construction. Any retrieval pipeline here has to beat that,
not just beat dense-only retrieval. That comparison is row 0 of the ablation table.

---

## Pipeline

**Ingestion** (`npm run ingest`, offline, run once)

```
rulebook.pdf ──▶ parse ──▶ chunk ──▶ embed ──▶ data/index/
                Opus 5   headings   voyage-4    (committed)
                vision
```

- **Parse with the model, not a text extractor.** Rulebooks are two-column layouts with sidebars,
  callout boxes, tables and iconography. `pdf-parse` flattens those into scrambled reading order — the
  previous prototype's corpus opens with `"Components3 Setup4-5 Your Area6"`, a table of contents welded
  into a chunk — and you inherit that damage in every answer forever. Claude reads the page as a page and
  emits markdown with the heading hierarchy and printed page numbers preserved.
- **The parse output is a committed artifact.** Vision parsing is non-deterministic, so re-running it
  would invalidate every page reference and every golden-set label. Run it once, hand-fix the few headings
  it gets wrong, commit `data/parsed/rulebook.md`.
- **Chunk on the document's own structure.** Rulebooks arrive pre-chunked by their authors; that is what
  the numbered sections are. Undersized leaf sections merge *upward into their parent* — never sideways
  into a sibling, which would file the text under a heading it does not belong to, and that heading is
  what appears in the citation. A section with subsections never merges at all.
- **Cards are never split.** Half a card is worse than no card.
- **Everything is cached by content hash**, because the project's central activity is re-running ingestion
  with different settings, and paying for unchanged chunks every time would discourage exactly the
  experimentation this is for.

**Query** (per question)

```
question ──▶ shape ──▶ dense ┐
             (regex)   bm25  ├─▶ RRF ──▶ documents ──▶ Opus 5 ──▶ answer
                             ┘                         citations   + page chips
                                                       web_search
```

---

## Three decisions worth explaining

### 1. Citations resolve to pages we compute, not pages the API returns

`page_location` citations — the ones carrying real `start_page_number` fields — are only emitted for
`document` blocks whose source is an actual PDF. This app sends assembled markdown, so every citation
comes back as `char_location`: character offsets, no page fields. Reading
`citation.page_location.start_page_number` off one yields `undefined`, and the chip renders
"Rulebook p.undefined" on the single feature that justifies the project.

We do not need the API to tell us the page. We assembled the string, so we know which chunk occupies which
character range, and every chunk carries its printed page range from ingestion. `document_index` selects
the span map, a binary search on `start_char_index` finds the chunk, and the page comes from our own data.
The API supplies the verbatim `cited_text`, which is the part it is actually authoritative about.

### 2. The fallback is gated on question shape, not retrieval score

The intuitive design attaches web search when retrieval scores look weak. That fires backwards on the
questions that need it most.

Ask "can I play a Trap during my opponent's turn?" of a rulebook that never discusses off-turn Traps.
Retrieval returns the Traps section. A reranker scores it as highly relevant — correctly, it *is* about
Traps. A score-based gate reads that as healthy evidence and withholds the search, handing the model a
passage that is on-topic and silent, at which point it can only guess.

The distinction a similarity score cannot express is relevance versus **sufficiency**. Nothing in a cosine
value says "this passage is about your question and does not settle it." So prohibition-shaped questions
(`lib/prohibition.ts`) instead get complete sections rather than fragments — absence is only assertable
over a whole unit — and web search attached unconditionally.

The classifier is a regex, deliberately tuned to over-trigger. A false positive costs one extra section of
context and an unused tool; a false negative is a confidently fabricated permission that changes how
someone plays their game. Those are not symmetric.

### 3. Uploads are never ingested

Visitors can attach a rulebook, but it is read in the browser and sent inline with the question. Nothing is
written server-side. This is cheaper than ingesting (a cached PDF costs ~$0.10 a turn against ~$10 to
ingest), and at portfolio traffic the break-even is a number of questions no single upload will ever see.

It also produces *better* citations than our own pipeline: a PDF sent whole comes back with real
`page_location`. And it deletes four whole categories of problem — cross-visitor data leakage, ingestion
cost abuse, a purge cron, and hosting strangers' PDFs — rather than mitigating them.

---

## Setup

```bash
npm install
cp .env.local.example .env.local     # add ANTHROPIC_API_KEY and VOYAGE_API_KEY
```

`VOYAGE_API_KEY` is free — the voyage-4 family carries a 200M-token free tier, which covers this project
permanently. (The architecture originally specified `voyage-3.5`; that is now a legacy model with *zero*
free tokens, identically priced to `voyage-4` and worse, so it was strictly dominated.)

Build the index — put your rulebook at `data/source/rulebook.pdf` first:

```bash
npm run parse      # ~$0.30-0.80, several minutes. Then read the markdown and fix stray headings.
npm run chunk      # free
npm run embed      # cents, cached by content hash
npm run dev
```

`npm run ingest` chains all three.

```bash
npm test           # retrieval math + citation resolution + question shape + answer scoring
npm run typecheck
npm run eval       # retrieval ablation      -> eval/results.md   (cheap, ~30s)
npm run eval:answers  # false-permission rate -> eval/answers.md   (runs the real answering path)
```

`eval:answers` calls the model once per question and again to grade the stance, so it costs real
money and takes minutes — `--limit N`, `--strata forbidden,unstated` and `--concurrency N` all
narrow it. `npm run eval` is the cheap one and is safe to run on every change.

## Embedding it elsewhere

`components/RulesChatWidget.tsx` is self-contained — no CSS framework, no state library. Copy it, plus
`app/api/chat/route.ts`, `lib/`, and `data/index/`, into any Next.js App Router project. The widget needs
only `/api/chat` to exist on the same origin.

## Limits worth knowing

- Uploads cap at 3 MB. Vercel rejects request bodies over 4.5 MB at the platform level before the handler
  runs, and base64 inflates by 4/3 — so a higher limit would produce an opaque 413 rather than a useful
  error.
- Rate limiting is per-instance and approximate. It is a speed bump against a script, not a quota; swap in
  Upstash or Vercel KV to enforce it properly.
- Effort is `low` for lookups and `medium` for legality questions. The API default is `high`, which
  measures around 44s to first token on Opus 5 versus roughly 4s at `low` — worth knowing before treating
  the default as free.
- Serving verbatim rulebook text publicly is a reproduction of copyrighted material. Answers quote short
  spans with attribution back to the publisher, which is a defensible posture; seeding from a scraped
  rulebook archive would not be.
- `reddit.com` cannot go in the web-search allowlist: Reddit blocks Anthropic's crawler, and an
  inaccessible domain does not degrade gracefully — the API rejects the entire request with a 400, so
  every question that attaches the tool fails. Verify any new domain before adding it.
- A Voyage account with no payment method on file is capped at 3 requests/minute and 10K tokens/minute,
  two orders of magnitude below standard. Ingestion still completes (the embedder paces itself and
  checkpoints), but budget ~15 minutes. Adding a card lifts the limits and does not forfeit the free
  tokens.

## What the ablation actually found

Numbers in `eval/results.md`, regenerated by `npm run eval`. Three results are worth stating plainly.

**Chunking dominated every retrieval technique.** The keyword glossary originally parsed as one 573-token
chunk holding fifteen unrelated definitions, so its embedding was the average of fifteen meanings and
matched nothing in particular. Asked "what does Exhaust do?", retrieval returned seven cards that merely
mention exhausting and never surfaced the definition. Splitting definition lists one-per-term — the same
rule already applied to cards — moved dense-only recall@8 from **79.4% to 97.1%** on the 34-question set
in use at the time. No retrieval technique in the ablation has moved anything close to that far. The trace
panel is what made it visible.

**The question set decided the conclusion.** The first golden set was seeded largely from the rulebook's
own FAQ, whose distinctive vocabulary is exactly what keyword search is good at. On it, four of five arms
scored 95–100% and the keyword baseline looked competitive with the full pipeline. Rewriting the set
harder — 114 questions phrased the way players actually ask, weighted toward `forbidden` and `unstated`
traps — separated them:

| arm | recall@8 | MRR |
|---|---|---|
| 0 · stuffed prompt | 100.0% | — |
| 0.5 · keyword + IDF | 87.7% | 0.606 |
| 1 · dense only | 92.1% | 0.675 |
| 2 · + BM25 & RRF | 93.9% | 0.728 |
| 3 · + rerank | **98.2%** | **0.865** |

The full stack leads the naive baseline by 10.5 points rather than the 0.3 it appeared to lead by. Nothing
in the pipeline changed between those two tables — only the measurement got honest. It is still not
*resolved*: at n=114 the minimum detectable effect is 13.1 points and the best Holm-adjusted p is 0.539,
so the right summary remains *directional, not established*. Reaching 10-point resolution needs about 190
questions.

**The eval caught a bug that retrieval scores alone could not.** One question missed on every arm —
including the stuffed-prompt baseline, which receives the entire corpus by construction. That signature
means the fault is upstream of retrieval, and it was: the chunker's definition-list branch emitted one
chunk per `**Term** —` line and silently discarded everything else in the section, so the
"Weak vs Vulnerable" rule (a blockquote) and the `Energy (Max 6)` entry (a 63-character term against a
60-character cap) never reached the index at all. The Energy limit is restated on page 7 and survived by
luck; the Weak/Vulnerable interaction appears nowhere else and was simply unanswerable. `g090` stays in
the set as a regression guard.

## What the answers actually do

`npm run eval:answers` runs the real answering path — same prompt, retrieval, effort and search gating,
imported from `lib/answer.ts` rather than restated — over all 119 questions, then has a separate judge
classify each answer's stance without ever seeing the expected label. Numbers in `eval/answers.md`.

**False-permission rate: 5.6%** (4 of 71, 95% CI 2–14%). That is the fraction of questions where the
rulebook does not grant permission and the system answered as though it does. It is the number that
reflects trustworthiness, and retrieval recall cannot see it: a pipeline can retrieve the right section
and still invent a permission the section does not contain.

| stratum | n | treated correctly | rate |
|---|---|---|---|
| permitted | 48 | 43 | 89.6% |
| forbidden | 51 | 45 | 88.2% |
| unstated | 20 | 18 | 90.0% |

**Read 5.6% as an upper bound.** Reading the four flagged answers, only one is a clear fabrication:
asked whether a card reward pick can be swapped after the fact (`g058`, genuinely unstated), the model
answered "yes" and cited the Full Knowledge rule, which governs *looking before* you finalize and says
nothing about undoing a finalized pick. That is the failure this metric exists to catch. Of the other
three, one is a compound question of mine (`g050` asks whether the Watcher can stay in Wrath "without any
downside" — the answer says yes-you-can-stay and then names the downside), and two look like label bugs
rather than model failures: on `g094` the model's reading of "you can't Scry more cards than are in your
draw pile" as *scry fewer* is arguably better than the label. The metric's job is to surface rows worth
reading; triage is still manual.

**The refusal counterweight matters.** A system answering "the rules don't say" to everything would post
0% and be useless, so the permitted stratum is reported beside it: 43/48 correct with 5 over-refusals.
Two of those five are the authority ladder working as designed — asked what a specific card does, the
model declined to state it flatly because that text comes from the fan-transcribed compendium, which the
system prompt ranks below the rulebook.

The one structural gap left is sample size, unchanged from the retrieval table: 71 questions puts the
false-permission confidence interval at 2–14%, wide enough that a real regression would need to be large
before the number moved convincingly.
