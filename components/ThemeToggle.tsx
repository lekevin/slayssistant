"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const initial =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  return (
    <button
      onClick={toggle}
      aria-label="Toggle dark mode"
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: "var(--text-muted)",
        borderRadius: 999,
        width: "2.25rem",
        height: "2.25rem",
        cursor: "pointer",
        fontSize: "1rem",
        lineHeight: 1,
      }}
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
