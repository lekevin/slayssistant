"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import TracePanel, { type Trace } from "./TracePanel";

/**
 * Self-contained chat widget. No CSS framework dependency, so it drops into any
 * site as one component plus the /api/chat route.
 *
 * The prototype this replaces did a single fetch and awaited the whole response.
 * That cannot work here: the answering model reasons for several seconds before
 * the first prose token, citations arrive as their own delta events after the
 * text they annotate, and the retrieval trace is ready long before either. So
 * this consumes SSE and renders each stage as it lands — which also makes the
 * wait legible instead of looking like a hang.
 */

export interface Citation {
  citedText: string;
  chunkId: string | null;
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  title: string;
  docType: string;
  source: "corpus" | "web";
  url?: string;
  label: string;
}

/**
 * One chip per source, not one per citation.
 *
 * The model routinely quotes the same section two or three times in an answer,
 * and each `citations_delta` arrives as its own event — so an answer that
 * leaned on "Remove, Upgrade, Transform" twice rendered the identical chip
 * twice. On the one feature this project justifies itself with, that reads as
 * a bug even though the underlying citations are all real.
 *
 * The quoted spans are kept rather than discarded: they differ even when the
 * label does not, and they are the part the API is actually authoritative
 * about. They collect into the chip's tooltip so nothing is lost.
 */
export function dedupeCitations(cs: Citation[]): Array<Citation & { quotes: string[] }> {
  const byLabel = new Map<string, Citation & { quotes: string[] }>();
  for (const c of cs) {
    const key = `${c.source}|${c.url ?? ""}|${c.label}`;
    const seen = byLabel.get(key);
    if (seen) {
      if (c.citedText && !seen.quotes.includes(c.citedText)) seen.quotes.push(c.citedText);
    } else {
      byLabel.set(key, { ...c, quotes: c.citedText ? [c.citedText] : [] });
    }
  }
  return [...byLabel.values()];
}

interface Message {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  citations?: Citation[];
  trace?: Trace;
  stages?: Array<{ stage: string; at: number }>;
  webResults?: Array<{ url?: string; title?: string }>;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface Props {
  gameName?: string;
  suggestedQuestions?: string[];
  apiPath?: string;
  infoPath?: string;
}

interface IndexInfo {
  ready: boolean;
  chunks?: number;
  byDocType?: Record<string, number>;
  embedModel?: string;
  error?: string;
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * The system prompt asks for "a short structured breakdown" when a question has
 * parts, so the model writes markdown lead-ins — "**Play phase:** Players can
 * play cards...". Rendered raw, those asterisks are visible in the bubble and
 * read as a bug.
 *
 * This handles the two inline marks the model actually emits, and returns React
 * nodes rather than HTML: model output never reaches dangerouslySetInnerHTML,
 * so a rulebook quote containing angle brackets stays inert.
 *
 * Unmatched markers deliberately stay literal. Mid-stream, "**Play pha" is not
 * yet bold and reads as text until its closing marker arrives — the same way
 * every streaming markdown chat behaves.
 */
function renderInline(text: string): ReactNode[] {
  const pattern = /\*\*([^\n]+?)\*\*|`([^`\n]+?)`/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={m.index}>{m[1]}</strong>);
    } else {
      out.push(
        <code
          key={m.index}
          style={{ fontFamily: mono, fontSize: ".875em", color: "var(--accent-soft)" }}
        >
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Shrink-and-dull on press, matching the host site's link idiom. Inlined here
// rather than pulled from a stylesheet so the widget still drops into any page
// as one component plus the API route.
const RCW_STYLES = `
.rcw-press { transition: transform .5s ease, opacity .5s ease, border-color .5s ease; }
.rcw-press:hover:not(:disabled) { transform: scale(.95); opacity: .7; }
.rcw-press:active:not(:disabled) { transform: scale(.92); opacity: .55; }
@media (prefers-reduced-motion: reduce) {
  .rcw-press { transition: opacity .2s ease; }
  .rcw-press:hover:not(:disabled), .rcw-press:active:not(:disabled) { transform: none; }
}
`;

const STAGE_LABELS: Record<string, string> = {
  routing: "reading the question",
  retrieving: "searching the rulebook",
  answering: "reasoning",
  web_search: "searching the web",
  first_token: "answering",
};

export default function RulesChatWidget({
  gameName = "this game",
  suggestedQuestions = [],
  apiPath = "/api/chat",
  infoPath = "/api/rulebook-info",
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [info, setInfo] = useState<IndexInfo | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetch(infoPath)
      .then((r) => r.json())
      .then((d) => live && setInfo(d))
      .catch(() => live && setInfo({ ready: false, error: "unavailable" }));
    return () => {
      live = false;
    };
  }, [infoPath]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, stage]);

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || busy) return;

    setInput("");
    setBusy(true);
    setStage("routing");

    const history: Message[] = [...messages, { role: "user", content: question }];
    setMessages([...history, { role: "assistant", content: "" }]);

    const update = (patch: Partial<Message> | ((m: Message) => Partial<Message>)) =>
      setMessages((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        const p = typeof patch === "function" ? patch(next[i]) : patch;
        next[i] = { ...next[i], ...p };
        return next;
      });

    try {
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        update({ error: msg.error ?? `HTTP ${res.status}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!evLine || !dataLine) continue;

          const event = evLine.slice(7).trim();
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          switch (event) {
            case "stage":
              setStage(data.stage as string);
              update((m) => ({
                stages: [...(m.stages ?? []), { stage: data.stage as string, at: data.at as number }],
              }));
              break;
            case "trace":
              update({ trace: data as unknown as Trace });
              break;
            case "thinking":
              update((m) => ({ thinking: (m.thinking ?? "") + (data.text as string) }));
              break;
            case "text":
              update((m) => ({ content: m.content + (data.text as string) }));
              break;
            case "citation":
              update((m) => ({ citations: [...(m.citations ?? []), data as unknown as Citation] }));
              break;
            case "web_results":
              update({ webResults: data.results as Array<{ url?: string; title?: string }> });
              break;
            case "web_error":
              update((m) => ({
                content: m.content + `\n\n_(web search unavailable: ${data.error})_`,
              }));
              break;
            case "error":
              update({ error: data.error as string });
              break;
            case "done":
              update({ usage: data.usage as Message["usage"] });
              break;
          }
        }
      }
    } catch (err) {
      update({ error: err instanceof Error ? err.message : "Connection failed." });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        color: "var(--text)",
      }}
    >
      <style>{RCW_STYLES}</style>

      <div
        style={{
          padding: ".6rem .9rem",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--surface-alt)",
          fontFamily: mono,
          fontSize: ".7rem",
          letterSpacing: ".06em",
          color: "var(--text-muted)",
          display: "flex",
          justifyContent: "space-between",
          gap: ".75rem",
        }}
      >
        <span>{gameName}</span>
        <span>
          {info?.ready
            ? `${info.byDocType?.rulebook ?? 0} sections + ${info.byDocType?.cards ?? 0} cards`
            : info
              ? "index not built"
              : ""}
        </span>
      </div>

      <div ref={listRef} style={{ maxHeight: "30rem", overflowY: "auto", padding: "1rem" }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--text-muted)", lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              Ask a rules question. Answers are grounded in the rulebook and cite the page; when the
              rules are silent, it says so instead of guessing.
            </p>
            {suggestedQuestions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem", marginTop: ".9rem" }}>
                {suggestedQuestions.map((q) => (
                  <button
                    key={q}
                    className="rcw-press"
                    onClick={() => send(q)}
                    style={{
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      borderRadius: 999,
                      padding: ".3rem .7rem",
                      fontSize: ".8125rem",
                      cursor: "pointer",
                      color: "var(--accent-soft)",
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: "1.1rem" }}>
            {m.role === "user" ? (
              <div style={{ fontWeight: 600 }}>{m.content}</div>
            ) : (
              <div>
                {m.thinking && (
                  <details style={{ marginBottom: ".5rem" }} open={busy && i === messages.length - 1}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontFamily: mono,
                        fontSize: ".7rem",
                        letterSpacing: ".08em",
                        textTransform: "uppercase",
                        color: "var(--text-muted)",
                      }}
                    >
                      reasoning
                    </summary>
                    <div
                      style={{
                        color: "var(--text-muted)",
                        fontSize: ".8125rem",
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                        borderLeft: "2px solid var(--border-subtle)",
                        paddingLeft: ".7rem",
                        marginTop: ".4rem",
                      }}
                    >
                      {renderInline(m.thinking)}
                    </div>
                  </details>
                )}

                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{renderInline(m.content)}</div>

                {m.error && (
                  <div style={{ color: "var(--danger)", fontSize: ".875rem", marginTop: ".4rem" }}>
                    {m.error}
                  </div>
                )}

                {!!m.citations?.length && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: ".35rem", marginTop: ".6rem" }}>
                    {dedupeCitations(m.citations).map((c, k) => (
                      <span
                        key={k}
                        title={c.quotes.join("\n\n---\n\n")}
                        style={{
                          fontFamily: mono,
                          fontSize: ".68rem",
                          padding: ".18rem .5rem",
                          borderRadius: 4,
                          background: c.source === "web" ? "var(--citation-web-bg)" : "var(--citation-corpus-bg)",
                          color: c.source === "web" ? "var(--warning)" : "var(--citation-corpus-text)",
                          border: `1px solid ${c.source === "web" ? "var(--citation-web-border)" : "var(--citation-corpus-border)"}`,
                        }}
                      >
                        {c.source === "web" && c.url ? (
                          <a href={c.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                            {c.label}
                          </a>
                        ) : (
                          c.label
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {m.trace && <TracePanel trace={m.trace} />}
              </div>
            )}
          </div>
        ))}

        {busy && stage && (
          <div style={{ fontFamily: mono, fontSize: ".72rem", color: "var(--text-muted)" }}>
            {STAGE_LABELS[stage] ?? stage}
            <span style={{ opacity: 0.5 }}>…</span>
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border-subtle)", padding: ".7rem .9rem" }}>
        <div style={{ display: "flex", gap: ".5rem" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={busy ? "Thinking…" : "Can I play a Trap on someone else's turn?"}
            disabled={busy}
            style={{
              flex: 1,
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: ".5rem .7rem",
              fontSize: ".9375rem",
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            className="rcw-press"
            onClick={() => send()}
            disabled={busy || !input.trim()}
            style={{
              border: "none",
              borderRadius: 6,
              padding: ".5rem 1rem",
              background: busy || !input.trim() ? "var(--disabled-bg)" : "var(--accent)",
              color: busy || !input.trim() ? "var(--text-faint)" : "var(--accent-contrast)",
              cursor: busy || !input.trim() ? "default" : "pointer",
              fontSize: ".9375rem",
            }}
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
