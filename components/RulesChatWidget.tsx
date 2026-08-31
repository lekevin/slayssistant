"use client";

import { useEffect, useRef, useState } from "react";
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

interface Attachment {
  filename: string;
  mediaType: string;
  data: string;
  sizeBytes: number;
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

// Vercel rejects request bodies over 4.5 MB at the platform level, before the
// route handler runs — so a limit above that produces an opaque 413 instead of
// a useful message. Base64 inflates by 4/3, so the real file ceiling is ~3 MB.
const MAX_FILE_BYTES = 3 * 1024 * 1024;

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
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [info, setInfo] = useState<IndexInfo | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
          attachment: attachment
            ? { filename: attachment.filename, mediaType: attachment.mediaType, data: attachment.data }
            : null,
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

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAttachError(null);

    if (file.size > MAX_FILE_BYTES) {
      setAttachError(
        `${(file.size / 1024 / 1024).toFixed(1)} MB is too large — the limit is 3 MB.`
      );
      return;
    }
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const isPdf = ext === "pdf" || file.type === "application/pdf";
    const isText = ["txt", "md", "markdown"].includes(ext) || file.type.startsWith("text/");
    if (!isPdf && !isText) {
      setAttachError(`Unsupported file type ".${ext}". Use a .pdf, .txt or .md.`);
      return;
    }

    // Read in the browser and send inline. Nothing is written to a server, so
    // one visitor's upload can never reach another's — and a PDF sent whole
    // yields real page-number citations, which our own corpus cannot.
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    setAttachment({
      filename: file.name,
      mediaType: isPdf ? "application/pdf" : "text/plain",
      data: btoa(binary),
      sizeBytes: file.size,
    });
  }

  return (
    <div
      style={{
        border: "1px solid #D3DEDE",
        borderRadius: 10,
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        color: "#101819",
      }}
    >
      <div
        style={{
          padding: ".6rem .9rem",
          borderBottom: "1px solid #E4EBEB",
          background: "#F3F6F6",
          fontFamily: mono,
          fontSize: ".7rem",
          letterSpacing: ".06em",
          color: "#5D6E71",
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
          <div style={{ color: "#5D6E71", lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              Ask a rules question. Answers are grounded in the rulebook and cite the page; when the
              rules are silent, it says so instead of guessing.
            </p>
            {suggestedQuestions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem", marginTop: ".9rem" }}>
                {suggestedQuestions.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    style={{
                      border: "1px solid #D3DEDE",
                      background: "#fff",
                      borderRadius: 999,
                      padding: ".3rem .7rem",
                      fontSize: ".8125rem",
                      cursor: "pointer",
                      color: "#0B6B70",
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
                        color: "#5D6E71",
                      }}
                    >
                      reasoning
                    </summary>
                    <div
                      style={{
                        color: "#5D6E71",
                        fontSize: ".8125rem",
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                        borderLeft: "2px solid #E4EBEB",
                        paddingLeft: ".7rem",
                        marginTop: ".4rem",
                      }}
                    >
                      {m.thinking}
                    </div>
                  </details>
                )}

                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{m.content}</div>

                {m.error && (
                  <div style={{ color: "#A33232", fontSize: ".875rem", marginTop: ".4rem" }}>
                    {m.error}
                  </div>
                )}

                {!!m.citations?.length && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: ".35rem", marginTop: ".6rem" }}>
                    {m.citations.map((c, k) => (
                      <span
                        key={k}
                        title={c.citedText}
                        style={{
                          fontFamily: mono,
                          fontSize: ".68rem",
                          padding: ".18rem .5rem",
                          borderRadius: 4,
                          background: c.source === "web" ? "#F8EEDC" : "#E2F0F0",
                          color: c.source === "web" ? "#A85C00" : "#0B6B70",
                          border: `1px solid ${c.source === "web" ? "#E8C98A" : "#BEDCDC"}`,
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
          <div style={{ fontFamily: mono, fontSize: ".72rem", color: "#5D6E71" }}>
            {STAGE_LABELS[stage] ?? stage}
            <span style={{ opacity: 0.5 }}>…</span>
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid #E4EBEB", padding: ".7rem .9rem" }}>
        {attachment && (
          <div
            style={{
              fontSize: ".75rem",
              color: "#5D6E71",
              marginBottom: ".45rem",
              display: "flex",
              alignItems: "center",
              gap: ".5rem",
            }}
          >
            <span style={{ fontFamily: mono }}>
              {attachment.filename} ({(attachment.sizeBytes / 1024).toFixed(0)} KB) — this session only
            </span>
            <button
              onClick={() => setAttachment(null)}
              style={{ border: "none", background: "none", cursor: "pointer", color: "#A33232" }}
            >
              remove
            </button>
          </div>
        )}
        {attachError && (
          <div style={{ fontSize: ".75rem", color: "#A33232", marginBottom: ".45rem" }}>{attachError}</div>
        )}

        <div style={{ display: "flex", gap: ".5rem" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,text/plain,application/pdf"
            onChange={onFile}
            style={{ display: "none" }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            title="Attach a rulebook or errata for this conversation only"
            style={{
              border: "1px solid #D3DEDE",
              background: "#fff",
              borderRadius: 6,
              padding: "0 .6rem",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            📎
          </button>
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
              border: "1px solid #D3DEDE",
              borderRadius: 6,
              padding: ".5rem .7rem",
              fontSize: ".9375rem",
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            onClick={() => send()}
            disabled={busy || !input.trim()}
            style={{
              border: "none",
              borderRadius: 6,
              padding: ".5rem 1rem",
              background: busy || !input.trim() ? "#C7D4D4" : "#0B6B70",
              color: "#fff",
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
