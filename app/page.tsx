import RulesChatWidget from "@/components/RulesChatWidget";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * Demo host page. The widget is the deliverable — it is self-contained and
 * drops into the portfolio site as a single component plus /api/chat.
 */
export default function Home() {
  return (
    <main
      style={{
        maxWidth: "56rem",
        margin: "0 auto",
        padding: "3rem 1.25rem 5rem",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        color: "var(--text)",
      }}
    >
      <header
        style={{
          marginBottom: "2rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
        }}
      >
        <div>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: ".75rem",
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "var(--accent)",
              margin: "0 0 .75rem",
            }}
          >
            Retrieval-augmented rules adjudication
          </p>
          <h1 style={{ fontSize: "2.25rem", margin: "0 0 .5rem", letterSpacing: "-.02em" }}>
            Slayssistant
          </h1>
          <p style={{ color: "var(--text-muted)", margin: 0, maxWidth: "44ch", lineHeight: 1.6 }}>
            Ask whether you can actually do that. Answers come from the rulebook with the page
            attached, and say so plainly when the rules are silent.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <RulesChatWidget
        gameName="Slay the Spire: The Board Game"
        suggestedQuestions={[
          "What does Exhaust do?",
          "Can I play a card after I've already attacked this turn?",
          "How does Block carry over between rounds?",
          "Does Barricade stack with Entrench?",
          "How do I play?",
        ]}
      />
    </main>
  );
}
