/**
 * The answering path's configuration, shared by the route and the evaluation.
 *
 * This lives outside the route for one reason: `eval/answers.ts` measures the
 * false-permission rate, and that number is only meaningful if the eval asks
 * the question the same way production does. A second copy of the system prompt
 * would drift within a week, and the metric would quietly start describing a
 * system nobody ships.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { QuestionShape } from "./prohibition";

export const ANSWER_MODEL = process.env.ANSWER_MODEL || "claude-opus-5";
export const GAME_NAME = process.env.GAME_NAME || "Slay the Spire: The Board Game";

/**
 * Effort is the largest single lever on both latency and cost, and the default
 * is `high` — which measures around 44s to first token on Opus 5, versus ~4s at
 * `low`. Since the user is staring at the screen the whole time, we spend depth
 * only where the question class actually needs it: adjudicating whether
 * something is permitted is genuine reasoning, looking up what a card does is
 * not.
 */
export const EFFORT_BY_SHAPE = {
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
export const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20260209 = {
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

/**
 * Prohibition-shaped questions get complete sections rather than fragments,
 * because absence is only assertable over a whole unit. See lib/prohibition.ts.
 */
export function retrievalOptions(shape: QuestionShape) {
  return {
    k: shape === "prohibition" ? 10 : 8,
    perArmK: 40,
    sectionComplete: shape === "prohibition",
  };
}

/**
 * Attach web search when the corpus plausibly cannot settle it. For
 * prohibition-shaped questions that is unconditional: a relevance score cannot
 * express sufficiency, so it is the wrong signal there.
 */
export function shouldAttachSearch(
  shape: QuestionShape,
  results: Array<{ score: number }>
): boolean {
  const weakEvidence = results.length === 0 || (results[0]?.score ?? 0) < 0.02;
  return shape === "prohibition" || weakEvidence;
}

export function systemPrompt(shape: string, hasAttachment: boolean) {
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
