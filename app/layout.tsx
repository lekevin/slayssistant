import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Montserrat } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: "Slayssistant",
  description:
    "Ask a board game rules question and get an answer grounded in the game's own rulebook, with a page citation attached.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={montserrat.variable}>
      <body style={{ margin: 0, fontFamily: "var(--font-montserrat), sans-serif" }}>{children}</body>
    </html>
  );
}
