import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "./landing.css";

export const metadata: Metadata = {
  title: "Repo Audit — how much of this codebase did AI write?",
  description:
    "Paste a public GitHub repository and get a score for how much of it was AI-generated, with the evidence behind it. Static analysis only; no model is asked for an opinion.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          {/* The page heading belongs to the page; this is site chrome, so it is
              a link and not an <h1> competing with the hero. */}
          <header className="masthead">
            <span className="mark" aria-hidden="true" />
            <a href="/">Repo Audit</a>
            <span className="tagline">static analysis, no AI required</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
