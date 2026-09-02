import type { CSSProperties } from "react";
import RulesChatWidget from "@/components/RulesChatWidget";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
const red = "var(--accent)";

const ARCHITECTURE_URL = "https://claude.ai/code/artifact/810afed8-4dd8-49f4-b4d7-3e3d459aba31";
const SOURCE_URL = "https://github.com/lekevin/rules-lawyer";
const GAME_URL = "https://a.co/d/03i8obZF";

function ArrowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

/**
 * Demo host page. The widget is the deliverable — it is self-contained and
 * drops into the portfolio site as a single component plus /api/chat.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: "58.5rem", margin: "0 auto", padding: "4.5rem 1.25rem 5rem" }}>
      <p
        style={{
          fontFamily: mono,
          fontSize: ".75rem",
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: red,
          margin: "0 0 1.125rem",
        }}
      >
        Retrieval-augmented rule provider
      </p>

      <div style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: "1.25rem", margin: "0 0 1.5rem" }}>
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(2.75rem, 9vw, 4rem)",
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-.02em",
            color: "rgba(255,255,255,.8)",
          }}
        >
          <span style={{ color: red }}>S</span>layssistant
        </h1>
        <a
          className="press"
          href={ARCHITECTURE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: ".5rem",
            paddingBottom: ".35rem",
            color: "#52525b",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9.25" />
            <path d="M12 11v5.25" />
            <path d="M12 7.75h.01" />
          </svg>
          <span style={{ fontFamily: mono, fontSize: ".6875rem", letterSpacing: ".1em", textTransform: "uppercase" }}>
            Case study
          </span>
        </a>
      </div>

      <p style={{ margin: 0, maxWidth: "62ch", fontSize: "clamp(1.0625rem, 3.5vw, 1.375rem)", lineHeight: 1.55, color: "#a1a1aa" }}>
        Slayssistant searches the official rulebook and card library for the boardgame{" "}
        <a
          className="text-link"
          href={GAME_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: red,
            textDecoration: "underline",
            textDecorationColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
            textUnderlineOffset: "3px",
          }}
        >
          Slay the Spire
        </a>{" "}
        to give you a straight answer.
      </p>

      <div style={{ height: 1, background: "rgba(255,255,255,.5)", margin: "3.5rem 0 0" }} />

      <div style={{ fontSize: "1.875rem", fontWeight: 500, color: "#52525b", margin: "1.25rem 0 1.25rem" }}>
        Try it<span style={{ color: "#fff", fontWeight: 600 }}>.</span>
      </div>

      <RulesChatWidget
        gameName="Slay the Spire: The Board Game"
        suggestedQuestions={[
          "What does Exhaust do?",
          "Can I buy my teammate a potion?",
          "How does Block carry over between rounds?",
          "Does Barricade stack with Entrench?",
          "What does vulnerable do?",
        ]}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "2rem 3rem", padding: "2.5rem 0 3.5rem" }}>
        <div>
          <div style={{ fontSize: "2.5rem", fontWeight: 700, color: "rgba(255,255,255,.8)", lineHeight: 1 }}>
            95.7<span style={{ fontSize: "1.5rem" }}>%</span>
          </div>
          <div style={{ fontFamily: mono, fontSize: ".6875rem", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--accent)", marginTop: ".625rem" }}>
            Retrieval recall@8
          </div>
          <div style={{ fontSize: ".875rem", color: "rgba(255,255,255,.35)", marginTop: ".375rem" }}>
            Measured on a 188-question hand-labelled golden set.
          </div>
        </div>
        <div>
          <div style={{ fontSize: "2.5rem", fontWeight: 700, color: "rgba(255,255,255,.8)", lineHeight: 1 }}>472</div>
          <div style={{ fontFamily: mono, fontSize: ".6875rem", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--accent)", marginTop: ".625rem" }}>
            Indexed passages
          </div>
          <div style={{ fontSize: ".875rem", color: "rgba(255,255,255,.35)", marginTop: ".375rem" }}>
            90 rulebook sections plus all 382 compendium cards.
          </div>
        </div>
        <div>
          <div style={{ fontSize: "2.5rem", fontWeight: 700, color: "rgba(255,255,255,.8)", lineHeight: 1 }}>188</div>
          <div style={{ fontFamily: mono, fontSize: ".6875rem", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--accent)", marginTop: ".625rem" }}>
            Golden-set questions
          </div>
          <div style={{ fontSize: ".875rem", color: "rgba(255,255,255,.35)", marginTop: ".375rem" }}>
            Permitted, forbidden, and unstated cases, hand-labelled.
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,.5)" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "3rem", paddingTop: "1.25rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontFamily: mono, fontSize: ".6875rem", letterSpacing: ".1em", textTransform: "uppercase", color: "#52525b", marginBottom: ".75rem" }}>
            Built with
          </div>
          <div style={{ fontSize: "1rem", color: "rgba(255,255,255,.35)" }}>
            Next.js &middot; TypeScript &middot; Voyage embeddings &middot; server-sent events
          </div>
        </div>
        <div style={{ display: "flex", gap: ".875rem", whiteSpace: "nowrap" }}>
          <a className="press" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" style={btnLink}>
            Source <ArrowIcon />
          </a>
          <a className="press" href={ARCHITECTURE_URL} target="_blank" rel="noopener noreferrer" style={btnLink}>
            Full case study <ArrowIcon />
          </a>
        </div>
      </div>
    </main>
  );
}

const btnLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: ".5rem",
  color: "rgba(255,255,255,.85)",
  border: "1px solid rgba(255,255,255,.22)",
  borderRadius: 8,
  padding: ".6875rem 1.25rem",
  fontSize: ".9375rem",
  fontWeight: 500,
  background: "rgba(255,255,255,.03)",
  textDecoration: "none",
};
