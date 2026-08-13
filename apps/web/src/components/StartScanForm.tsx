"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * The form asks for a repository and nothing else.
 *
 * It used to open with a three-way picker — vibe check, security, or code
 * health. That question was never about which analyzers run: **a scan always
 * produces all three**, because the indexes are shared and skipping one saves
 * almost nothing. It only chose which section the report opened on.
 *
 * So it was a question with no wrong answer, asked before anyone had seen what
 * the product does, whose only effect was to hide two thirds of what we had
 * already worked out. The report now shows all three, and the only thing left
 * to ask is which repository.
 */

/**
 * The scan runs inline, so the request can take several seconds. These describe
 * what is genuinely happening, in the order it happens, so the wait reads as
 * progress rather than a hang.
 */
const STAGES = [
  "Fetching the repository…",
  "Reading the commit history…",
  "Parsing every source file…",
  "Looking for duplicated logic…",
  // Named now that the report leads with all three checks rather than one. A
  // wait that only mentions duplication makes the security section look like
  // something we bolted on after the fact.
  "Checking for exposed keys and open routes…",
  "Weighing the evidence…",
];

export function StartScanForm() {
  const router = useRouter();
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (repo.trim() === "") {
      setError("Paste a GitHub repository to analyse.");
      return;
    }

    setBusy(true);
    setStage(0);
    timer.current = setInterval(
      () => setStage((s) => Math.min(s + 1, STAGES.length - 1)),
      2200,
    );

    const body = new FormData();
    body.set("repo", repo);

    try {
      const response = await fetch("/api/scans", { method: "POST", body });
      const payload = (await response.json()) as { id?: string; error?: string };

      if (!response.ok || !payload.id) {
        setError(payload.error ?? "Could not analyse that repository.");
        setBusy(false);
        return;
      }
      // Stay busy through the navigation so the button cannot be pressed twice
      // while the report page loads.
      router.push(`/scan/${payload.id}`);
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    } finally {
      if (timer.current) clearInterval(timer.current);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="repo">Public GitHub repository</label>
        <p className="hint">
          Paste a URL, or just owner/repo. Public repositories only &mdash; we
          never ask for access to your account.
        </p>
        <input
          id="repo"
          type="text"
          placeholder="vercel/next.js"
          value={repo}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setRepo(e.target.value)}
          disabled={busy}
        />
      </div>

      <button type="submit" disabled={busy}>
        {busy ? "Analysing…" : "Analyse this codebase"}
      </button>

      {busy ? (
        <p className="status-line" aria-live="polite">
          {STAGES[stage]}
        </p>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
