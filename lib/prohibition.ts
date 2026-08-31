/**
 * Question-shape detection, and the reason it exists.
 *
 * The architecture doc names this as failure mode #2 and then never solves it:
 * rulebooks are written in the affirmative. They say what you MAY do and almost
 * never enumerate what you may not. So a "no" is an inference from absence — and
 * absence is exactly what retrieval cannot hand you.
 *
 * The doc's fallback design makes this worse rather than better. It gates web
 * search on the reranker's score, withholding the tool when the top passage
 * scores well. But consider: "Can I play a Trap during my opponent's turn?"
 * against a rulebook that never discusses off-turn Traps. Retrieval returns the
 * Traps section. A cross-encoder scores it as highly relevant, correctly — it IS
 * about Traps. The gate reads that as healthy evidence and withholds the search,
 * handing the model a passage that is on-topic and silent, at which point it can
 * only guess. The gate fires backwards on precisely the question class the
 * architecture was designed around.
 *
 * The distinction the score cannot express is relevance versus SUFFICIENCY. No
 * similarity score says "this passage is about your question and does not settle
 * it." So we stop asking it to. Prohibition-shaped questions instead get:
 *
 *   1. section-complete retrieval — absence is only assertable over a whole
 *      section, never over a 400-token fragment, and
 *   2. web search attached unconditionally, whatever the scores look like.
 *
 * A regex is a blunt instrument, and a router LLM call would classify better.
 * But that call costs ~2.4s on every question, and this heuristic is tuned to
 * over-trigger: a false positive costs one extra section of context and an
 * available-but-probably-unused tool, while a false negative is a confidently
 * fabricated permission. Those are not symmetric, so the threshold sits well
 * toward recall.
 */

export type QuestionShape = "prohibition" | "lookup" | "how_to_play";

const PROHIBITION_PATTERNS: RegExp[] = [
  /\bcan\s+(?:i|you|we|they|a\s+player|my\s+\w+|the\s+\w+)\b/i,
  /\b(?:am|are|is)\s+(?:i|you|we|they|it|a\s+player)\s+(?:allowed|permitted|able)\b/i,
  /\bis\s+it\s+(?:legal|allowed|permitted|okay|ok|valid)\b/i,
  /\bcould\s+(?:i|you|we|a\s+player)\b/i,
  /\bmay\s+(?:i|you|we|they|a\s+player)\b/i,
  /\b(?:do|does|did)\s+(?:i|you|we|they|a\s+player)\s+(?:have\s+to|need\s+to|get\s+to)\b/i,
  /\b(?:anything|something|any\s+rule|any\s+way)\s+(?:that\s+)?(?:stop|prevent|forbid|block|prohibit)/i,
  /\bwhat\s+(?:stops|prevents|forbids)\b/i,
  /\bam\s+i\s+(?:supposed|meant)\s+to\b/i,
  /\bhave\s+to\b.*\?/i,
  /\bwithout\s+\w+ing\b.*\?/i,
  /\b(?:illegal|disallowed|forbidden|banned)\b/i,
  /\bstack(?:s|ed|ing)?\s+with\b/i,
  /\bat\s+the\s+same\s+time\b/i,
  /\b(?:instead\s+of|rather\s+than)\b.*\?/i,
  // Timing questions are legality questions wearing different clothes: "on
  // someone else's turn" is asking whether an action is permitted then, and the
  // rulebook almost never states the prohibition explicitly.
  /\b(?:someone\s+else|another\s+player|an?\s*opponent|opponent)(?:'s|s')\s+turn\b/i,
  /\b(?:during|on|outside\s+of)\s+(?:my|your|their|his|her|the)\s+\w*\s*turn\b/i,
  /\bout\s+of\s+turn\b/i,
  /\bbefore\s+(?:i|you|we|they)\s+\w+/i,
  /\bafter\s+(?:i|you|we|they)(?:'ve|\s+have)?\s+already\b/i,
];

const HOW_TO_PLAY_PATTERNS: RegExp[] = [
  /\bhow\s+(?:do\s+(?:i|you|we)\s+)?play\b/i,
  /\bhow\s+does\s+(?:this|the)\s+game\s+work\b/i,
  /\bhow\s+do\s+(?:i|you|we)\s+(?:start|begin|set\s*up)\b/i,
  /\b(?:teach|explain)\s+(?:me\s+)?(?:the\s+)?(?:game|rules|basics)\b/i,
  /\bwhat(?:'s|\s+is)\s+the\s+(?:goal|objective|point)\b/i,
  /\bfirst\s+time\s+(?:playing|player)\b/i,
];

export function classifyShape(question: string): QuestionShape {
  const q = question.trim();
  // Order matters: "how do I play a Trap on someone else's turn?" is a
  // prohibition question wearing how-to-play clothing, and the prohibition
  // reading is the one whose failure mode is dangerous.
  if (PROHIBITION_PATTERNS.some((re) => re.test(q))) return "prohibition";
  if (HOW_TO_PLAY_PATTERNS.some((re) => re.test(q))) return "how_to_play";
  return "lookup";
}

export function isProhibition(question: string): boolean {
  return classifyShape(question) === "prohibition";
}

/**
 * Extract probable game-entity names — capitalized multi-word runs and quoted
 * spans — so the answer prompt can call them out explicitly. Cheap, and it makes
 * multi-entity questions ("does Barricade stack with Entrench?") legible to the
 * model even when retrieval only surfaced one of the two.
 */
export function extractEntities(question: string): string[] {
  const found = new Set<string>();

  for (const m of question.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g)) {
    const v = (m[1] ?? m[2])?.trim();
    if (v) found.add(v);
  }
  // Capitalized runs, ignoring the sentence-initial word which is capitalized
  // for grammatical reasons rather than because it names anything.
  const words = question.split(/\s+/);
  let run: string[] = [];
  words.forEach((w, i) => {
    const bare = w.replace(/[^A-Za-z'-]/g, "");
    const isCap = /^[A-Z][a-z'-]+$/.test(bare) && !(i === 0);
    if (isCap) {
      run.push(bare);
    } else {
      if (run.length) found.add(run.join(" "));
      run = [];
    }
  });
  if (run.length) found.add(run.join(" "));

  return [...found].filter((s) => s.length > 1);
}
