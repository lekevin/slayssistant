import Anthropic from "@anthropic-ai/sdk";
import { getRetriever } from "@/lib/retrieval/file-retriever";
import { assembleDocuments, resolveCitation, citationLabel } from "@/lib/citations";
import { classifyShape, extractEntities } from "@/lib/prohibition";

// Node is the default runtime in Next 16 (Edge is deprecated), so there is no
// `runtime` export here - but the dependency is real: this route reads the
// committed index off the filesystem at request time.
//
// 300s covers a slow answer with adaptive thinking plus up to three web
// searches. Vercel's Fluid compute allows this on Hobby; without it the cap is
// far lower and a long legality answer would be cut off mid-stream.
export const maxDuration = 300;

const ANSWER_MODEL = process.env.ANSWER_MODEL || "claude-opus-5";
const GAME_NAME = process.env.GAME_NAME || "Slay the Spire: The Board Game";

/**
 * Effort is the largest single lever on both latency and cost, and the default
 * is `high` — which measures around 44s to first token on Opus 5, versus ~4s at
 * `low`. Since the user is staring at the screen the whole time, we spend depth
 * only where the question class actually needs it: adjudicating whether
 * something is permitted is genuine reasoning, looking up what a card does is
 * not.
 */
const EFFORT_BY_SHAPE = {
  prohibition: "medium",
  lookup: "low",
  how_to_play: "low",
} as const;

/**
 * Scoped to sources that actually adjudicate rules. Without `allowed_domains`
 * the model will happily cite a strategy blog or a storefront listing, which
 * reads as authoritative in a citation chip and is not. `max_uses` caps the one
 * genuinely unbounded path in the request.
 *
 * DO NOT ADD reddit.com. Reddit blocks Anthropic's crawler, and an inaccessible
 * domain in this list does not degrade gracefully - the API rejects the whole
 * request with a 400, so every question that attaches this tool fails outright.
 * Verify a new domain before adding it: send a throwaway message on a model that
 * supports this tool type with `allowed_domains: ["<domain>"]` and check it does
 * not 400. (Confirmed reachable: boardgamegeek.com, contentiongames.com,
 * slaythespire.fandom.com, slaythespire.wiki.gg, gamefound.com.)
 */
const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20260209 = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3,
  allowed_domains: [
    "boardgamegeek.com",
    "contentiongames.com",
    "slaythespire.fandom.com",
    "slaythespire.wiki.gg",
  ],
};

// A visitor with a script can otherwise spend real money. This is per-instance
// and therefore approximate — serverless gives each cold start its own map.
// It is a speed bump, not a quota; swap in Upstash or Vercel KV to enforce.
const RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 20 };
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT.max;
}

type ChatMessage = { role: "user" | "assistant"; content: string };
type Attachment = { filename: string; mediaType: string; data: string };

function systemPrompt(shape: string, hasAttachment: boolean) {
  return `You are a rules adjudicator for the board game "${GAME_NAME}".

You answer the way a trusted rules-lawyer friend does at the table: directly, in a few sentences, citing the
book when the book settles it. No preamble, no restating the question.

SOURCES, IN ORDER OF AUTHORITY
Official errata > official FAQ > the rulebook > the fan-transcribed card compendium. The compendium is a
volunteer transcription of card faces and is sometimes wrong or uncertain — it carries literal "[Innate?]"
markers where the transcriber could not read an icon. Never let it overrule the rulebook; when they
conflict, say so and follow the rulebook.

GROUNDING
Answer from the provided documents whenever they settle the question. Quote the governing clause rather
than paraphrasing it — the quoted span becomes a citation the player can check.

THE HARD CASE, WHICH IS MOST OF WHY YOU EXIST
This rulebook, like all rulebooks, is written in the affirmative: it says what a player MAY do and almost
never enumerates what they may not. So the absence of permission is not the same as a prohibition, and it
is also not the same as permission. When the provided sections are on-topic but do not actually settle the
question, you must say which of these is true:
  - the rules explicitly permit it (quote the clause),
  - the rules explicitly forbid it (quote the clause),
  - the rules are SILENT, and you are reasoning from the structure of adjacent rules — label this clearly
    as an inference and give your best reading, or search the web for an official ruling.
Never present an inference from silence as if it were a printed rule. A confident wrong "yes" is the most
damaging thing you can produce: it changes how someone plays their game.

${
  shape === "prohibition"
    ? `This question asks whether something is ALLOWED. You have been given complete sections rather than
fragments, precisely so you can distinguish "the rules don't mention this" from "the relevant sentence
wasn't retrieved." If the complete section is silent on the specific interaction asked about, say so
plainly and use web_search to look for an official ruling before committing to an answer.`
    : ""
}

WEB SEARCH
When the documents don't settle it, search — publisher FAQ and errata, BoardGameGeek rules forums,
designer rulings. Then label plainly which parts of your answer came from the rulebook and which came
from the web. Never blur the two.
${hasAttachment ? `
UPLOADED FILE
The player has attached their own document for this conversation. It is not part of the official corpus —
treat it as material they brought to the table (homebrew, an expansion insert, printed errata). Say
explicitly when you are drawing on it, and if it conflicts with the official rulebook, point out the
conflict rather than silently picking one.` : ""}

Keep it tight. A few sentences for a simple question; a short structured breakdown only when the question
genuinely has multiple parts.`;
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "Server is missing ANTHROPIC_API_KEY." }, { status: 500 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) {
    return Response.json(
      { error: "Rate limit reached — this is a personal demo on a small budget. Try again in an hour." },
      { status: 429 }
    );
  }

  let body: { messages: ChatMessage[]; attachment?: Attachment | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { messages, attachment } = body;
  if (!messages?.length) return Response.json({ error: "No messages provided." }, { status: 400 });

  const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!question.trim()) return Response.json({ error: "Empty question." }, { status: 400 });

  const shape = classifyShape(question);
  const entities = extractEntities(question);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const t0 = Date.now();
      try {
        // First byte within a few ms, so the UI has something to render long
        // before the model produces a token.
        send("stage", { stage: "routing", shape, entities, at: Date.now() - t0 });

        const retriever = getRetriever();
        send("stage", { stage: "retrieving", at: Date.now() - t0 });

        const { results, trace } = await retriever.search(question, {
          k: shape === "prohibition" ? 10 : 8,
          perArmK: 40,
          sectionComplete: shape === "prohibition",
        });

        const docs = assembleDocuments(results);

        // `document_index` on a citation counts document blocks in the order
        // they appear in the request. The uploaded file is ALSO a document
        // block, so it occupies the index right after the corpus documents -
        // resolving citations against the corpus array alone would silently
        // drop every citation the model makes into the user's own upload.
        // `citable` mirrors the real block order.
        const citable = [...docs];

        send("trace", {
          shape,
          entities,
          retrieved: results.map((r) => ({
            id: r.chunk.id,
            title: r.chunk.title,
            sectionPath: r.chunk.sectionPath,
            docType: r.chunk.docType,
            page: r.chunk.pageStart,
            score: Number(r.score.toFixed(5)),
            ranks: r.ranks,
            tokens: r.chunk.tokenCount,
          })),
          dense: trace.dense,
          sparse: trace.sparse,
          fused: trace.fused,
          expandedFrom: trace.expandedFrom,
          documents: docs.map((d) => ({ title: d.block.title, chunks: d.spans.length })),
          timings: trace.timings,
          at: Date.now() - t0,
        });

        // Attach web search when the corpus plausibly cannot settle it. For
        // prohibition-shaped questions that is unconditional: see lib/prohibition.ts
        // for why a relevance score is the wrong signal there.
        const weakEvidence = results.length === 0 || (results[0]?.score ?? 0) < 0.02;
        const attachSearch = shape === "prohibition" || weakEvidence;

        const content: Anthropic.ContentBlockParam[] = docs.map(
          (d) => d.block as Anthropic.DocumentBlockParam
        );

        if (attachment?.data) {
          const uploadSource: Anthropic.DocumentBlockParam["source"] =
            attachment.mediaType === "application/pdf"
              ? { type: "base64", media_type: "application/pdf", data: attachment.data }
              : {
                  type: "text",
                  media_type: "text/plain",
                  data: Buffer.from(attachment.data, "base64").toString("utf-8"),
                };

          content.push({
            type: "document",
            source: uploadSource,
            title: `Player upload: ${attachment.filename}`,
            context: "Uploaded by the player for this conversation. Not part of the official corpus.",
            citations: { enabled: true },
            // The upload is resent on every turn of the conversation, so cache it:
            // a cache read is a tenth the price of re-reading a 100-page PDF.
            cache_control: { type: "ephemeral" },
          });

          // A PDF upload yields real page_location citations - better provenance
          // than our own pipeline can produce - but only if the resolver can
          // find the document. It has no span map because we did not assemble
          // its text.
          citable.push({
            block: {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "" },
              title: `Your upload: ${attachment.filename}`,
              context: "",
              citations: { enabled: true },
            },
            spans: [],
          });
        }

        content.push({ type: "text", text: question });

        const history = messages.slice(0, -1).map((m) => ({
          role: m.role,
          content: m.content,
        })) as Anthropic.MessageParam[];

        send("stage", { stage: "answering", effort: EFFORT_BY_SHAPE[shape], attachSearch, at: Date.now() - t0 });

        const anthropic = new Anthropic();
        const modelStream = anthropic.messages.stream({
          model: ANSWER_MODEL,
          max_tokens: 8000,
          system: systemPrompt(shape, !!attachment?.data),
          // display:"summarized" is not cosmetic. The default is "omitted",
          // which streams thinking blocks whose text is empty — so the user
          // watches a spinner for the entire reasoning phase with no signal the
          // request is alive. For a rules bot, the reasoning is also the most
          // interesting thing on the page.
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: EFFORT_BY_SHAPE[shape] },
          ...(attachSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
          messages: [...history, { role: "user", content }],
        });

        let firstText = 0;
        let sawThinking = false;

        modelStream.on("streamEvent", (event) => {
          if (event.type === "content_block_start") {
            const b = event.content_block as { type: string; name?: string };
            if (b.type === "server_tool_use" && b.name === "web_search") {
              send("stage", { stage: "web_search", at: Date.now() - t0 });
            }
            if (b.type === "web_search_tool_result") {
              // Server-tool errors arrive as HTTP 200 with an error OBJECT where
              // a success would carry a list, so branch before indexing.
              const c = (event.content_block as { content?: unknown }).content;
              if (Array.isArray(c)) {
                send("web_results", {
                  results: c.slice(0, 5).map((r: { url?: string; title?: string }) => ({
                    url: r.url,
                    title: r.title,
                  })),
                });
              } else {
                send("web_error", { error: (c as { error_code?: string })?.error_code ?? "unknown" });
              }
            }
          }

          if (event.type === "content_block_delta") {
            const d = event.delta as {
              type: string;
              text?: string;
              thinking?: string;
              citation?: unknown;
            };
            if (d.type === "thinking_delta" && d.thinking) {
              sawThinking = true;
              send("thinking", { text: d.thinking });
            }
            if (d.type === "text_delta" && d.text) {
              if (!firstText) {
                firstText = Date.now() - t0;
                send("stage", { stage: "first_token", at: firstText, sawThinking });
              }
              send("text", { text: d.text });
            }
            if (d.type === "citations_delta" && d.citation) {
              const resolved = resolveCitation(d.citation, citable);
              if (resolved) {
                send("citation", { ...resolved, label: citationLabel(resolved) });
              }
            }
          }
        });

        const final = await modelStream.finalMessage();

        send("done", {
          stopReason: final.stop_reason,
          usage: final.usage,
          timings: { ...trace.timings, firstToken: firstText, total: Date.now() - t0 },
        });
      } catch (err) {
        console.error("chat route error", err);
        send("error", { error: err instanceof Error ? err.message : "Something went wrong." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
