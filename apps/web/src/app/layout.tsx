import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Codebase audit",
  description:
    "Analyse a git repository for AI-generated code, security holes, and architecture problems.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <div className="masthead">
            <h1>
              <a href="/" style={{ textDecoration: "none", color: "inherit" }}>
                Codebase audit
              </a>
            </h1>
            <span>static analysis, no AI required</span>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
