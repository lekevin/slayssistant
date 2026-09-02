# Slayssistant

A board game rules assistant. Ask whether you can actually do that, and get an answer grounded in the
game's own rulebook with the page attached — or an honest "the rules don't say," which is the answer more
often than a rules bot usually admits.

Built on *Slay the Spire: The Board Game*: the official rulebook plus a 382-entry card compendium.

**[How the thing actually works](https://claude.ai/code/artifact/810afed8-4dd8-49f4-b4d7-3e3d459aba31)** —
the illustrated architecture write-up, with the retrieval ladder drawn out and the ablation charted at both
sample sizes. Its source is `architecture.html` in this repo; edit that file and redeploy to the same URL
rather than publishing a second copy.

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

## Two decisions worth explaining

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

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test` and `build` on every push — all keyless, since the
unit tests use `eval/fixtures/mini-rulebook.md` and both API routes are dynamic. The retrieval ablation runs
as a second job when `VOYAGE_API_KEY` is present and skips cleanly when it is not; it is the only check that
exercises the shipped `embeddings.bin` rather than a fixture. `eval:answers` stays manual because it spends
money.

## Embedding it elsewhere

`components/RulesChatWidget.tsx` is self-contained — no CSS framework, no state library. Copy it, plus
`app/api/chat/route.ts`, `lib/`, and `data/index/`, into any Next.js App Router project. The widget needs
only `/api/chat` to exist on the same origin.

Color comes from CSS custom properties the host defines — `--bg`, `--surface`, `--surface-alt`, `--border`,
`--border-subtle`, `--text`, `--text-muted`, `--text-faint`, `--accent`, `--accent-soft`,
`--accent-contrast`, `--danger`, `--warning`, `--disabled-bg`, and the four `--citation-*` tokens.
`app/globals.css` is a working set to copy. Hover and press styles ride along in a `<style>` tag the
component renders itself, so embedding it still costs one component plus the route.

## Look and feel

The page is styled to sit inside the portfolio at [lekevin.com](https://lekevin.com) rather than read as a
separate product: Montserrat, the site's `#020c0b` ground, red-600 accents, zinc rules, and its interaction
idiom — anything clickable shrinks to 95% and dulls on hover, inline text links warm to red-500.

**One theme, not two.** The light palette and its toggle are gone. A theme switch is a standing maintenance
surface — every token needs two values that both have to stay legible, and every new color has to be chosen
twice — which is a poor trade for a page with one job and one context. Removing it also retired the
pre-paint theme script in `layout.tsx`, so there is no flash-of-wrong-theme left to solve.

**Two reds, deliberately.** `--accent` (red-600) is the brand red, used for fills, the title and the small
mono labels, matching how the portfolio uses it. `--accent-soft` (red-400) exists because red-600 only
manages about 3.4:1 against `--surface`, which is not enough for 13px interactive text; citation chips carry
`--citation-corpus-text` for the same reason. Web-source chips stay amber: distinguishing a rulebook
citation from a web one at a glance is the product's whole claim, and that is worth keeping one non-red hue.

**Answers render inline markdown.** The system prompt asks for a structured breakdown when a question has
parts, so the model writes `**Play phase:**` lead-ins, and raw asterisks in a chat bubble read as a bug.
`renderInline()` converts `**bold**` and `` `code` `` into React nodes rather than going through
`dangerouslySetInnerHTML` — the text quotes rulebook content, so it never becomes markup. Unmatched markers
stay literal, which is the right behavior mid-stream: a half-arrived `**Play pha` reads as text until its
closing marker lands.

## Limits worth knowing

- Rate limiting is per-instance and approximate. It is a speed bump against a script, not a quota; swap in
  Upstash or Vercel KV to enforce it properly.
- Effort is `low` for lookups and `medium` for legality questions. The API default is `high`, which
  measures around 44s to first token on Opus 5 versus roughly 4s at `low` — worth knowing before treating
  the default as free.
- **The compendium crowds the rulebook, and the fix is only half-measured.** The corpus is 382 card
  chunks against 90 rulebook sections, so a card-flavored query ("can I upgrade a Curse?") fills the
  top-k with cards that mention the word and never surfaces the section that governs it. Measured on the
  production path: questions the pipeline misses averaged **48.8%** card chunks in their top-k against
  **35.7%** on questions it hits. Worse, it silently disabled the prohibition safeguard — section-complete
  expansion seeded from the top hit overall and filters cards out of the sibling scan, so whenever a card
  won the top slot the expansion added *nothing*, on exactly the questions it exists to serve.
  `rulebookFloor` (`lib/retrieval/types.ts`) now guarantees 4 rulebook chunks for prohibition questions
  and 2 otherwise, and the expansion seeds from the top *rulebook* hit. That fixed the no-op — three
  probed prohibition questions went from +0 to +4 expanded chunks — and cut crowding on misses to 37.7%.
  **It did not change span recall: 15 misses before, 15 after.** Getting rules into the window is not the
  same as getting the right rule, and whether the extra context improves answers is an answer-level
  question this repo has not paid to measure. Kept because the no-op was a genuine defect and recall did
  not regress, not because it is proven to help.
- **The ablation does not measure the production path.** `eval/run.ts` drives each arm with explicit
  options (`{ k, arms }`) to isolate what dense, BM25 and reranking are individually worth. Production
  additionally sets `sectionComplete` and `rulebookFloor`, and no row in `eval/results.md` includes them.
  A change to either is invisible to `npm run eval` — that is why the numbers above come from a separate
  production-path sweep. A sixth "as shipped" arm would close this.
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
harder — questions phrased the way players actually ask, weighted toward `forbidden` and `unstated`
traps — separated them, and growing it to 188 scorable questions finally resolved the top of the ladder:

| arm | recall@8 | MRR | win/loss | Holm p |
|---|---|---|---|---|
| 0 · stuffed prompt | 100.0% | — | — | — |
| 0.5 · keyword + IDF | 84.6% | 0.557 | — | — |
| 1 · dense only | 88.8% | 0.660 | +23 / −15 | 0.512 |
| 2 · + BM25 & RRF | 89.9% | 0.720 | +8 / −6 | 0.791 |
| 3 · + rerank | **95.7%** | **0.831** | +15 / −4 | **0.058** |

The full stack leads the naive baseline by 11.3 points rather than the 0.3 it appeared to lead by. Nothing
in the pipeline changed between any of these tables — only the measurement got honest, and then got bigger.

**Sample size was the whole story.** At n=114 the minimum detectable effect was 13.1 points and the best
Holm-adjusted p was 0.539, so the honest summary was *directional, not established*. At n=188 the MDE is
10.2 points and the rerank step wins 15 and loses 4 against hybrid retrieval — McNemar p = **0.019**,
Holm-adjusted **0.058**. That is a real result: reranking is doing something, and it is the only arm in the
ladder that clears its own noise floor. The Holm adjustment leaves it a hair outside the conventional
threshold, which is the correct amount of hedging for four comparisons on one dataset, not a reason to
round it down to nothing. The two middle rungs — dense over keyword, and BM25 fusion over dense — remain
unresolved, and 5-point resolution would need about 470 questions.

Note the recall numbers *fell* when the set grew (rerank 98.2% → 96.3% → 95.7%). Nothing regressed; the
187 → 188 step added `g188`, a deliberate regression probe (see below), and the earlier 114 → 187 growth
was weighted 40 `unstated` and 26 `forbidden`. A recall number is a property of the question set as much
as the pipeline, which is the same lesson the FAQ-seeded set taught the first time.

**The eval caught a bug that retrieval scores alone could not.** One question missed on every arm —
including the stuffed-prompt baseline, which receives the entire corpus by construction. That signature
means the fault is upstream of retrieval, and it was: the chunker's definition-list branch emitted one
chunk per `**Term** —` line and silently discarded everything else in the section, so the
"Weak vs Vulnerable" rule (a blockquote) and the `Energy (Max 6)` entry (a 63-character term against a
60-character cap) never reached the index at all. The Energy limit is restated on page 7 and survived by
luck; the Weak/Vulnerable interaction appears nowhere else and was simply unanswerable. `g090` stays in
the set as a regression guard.

**Not every miss is a chunking bug.** `g188` ("Do Defect Orbs stack with Vulnerable?") was reported live
in production and is not fixed. The rulebook never states the answer (no) in one place — it requires
chaining three separate spans: Vulnerable only doubles damage from a "hit" (page 24), the Defect's Orb
text never uses the word "hit" (page 16), and the one FAQ that touches Orb math calls it "a Dark Orb's
damage" rather than a hit (page 18). Top-k chunk retrieval was never built to chain facts across sections
like that, and neither is the answering prompt. Kept in the set as an honest regression probe rather than
quietly dropped.

## What the answers actually do

`npm run eval:answers` runs the real answering path — same prompt, retrieval, effort and search gating,
imported from `lib/answer.ts` rather than restated — then has a separate judge classify each answer's
stance without ever seeing the expected label. Numbers in `eval/answers.md`.

**The numbers below are stale.** They were measured against a 119-question golden set; the set has since
grown to 193 (73 added earlier, plus one regression probe, and three label fixes). `eval/answers.md` carries the full caveat and the
corrected false-permission denominator. Re-run `npm run eval:answers` to refresh — it costs real money
(~$14 at current sizes), which is why it isn't run on every change.

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

## License

MIT, for the code and the evaluation harness — see `LICENSE`. It does not extend to the game content the
pipeline reads: the rulebook transcription and the card compendium are the publisher's, included to
demonstrate and measure the retrieval pipeline and not licensed onward. Point a fork at a rulebook you have
the right to use; nothing here is specific to this game.
