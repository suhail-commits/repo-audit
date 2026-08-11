"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * The one question the landing page asks.
 *
 * Not which analyzers run — a scan always produces all three, because the
 * indexes are shared and skipping one saves almost nothing. It decides which
 * section the report leads with.
 *
 * The persona question that used to live here has moved into the report, where
 * a switcher already exists. Two pickers in front of a text field is a lot to
 * ask before anyone has seen what the product does, and asking a question the
 * report then re-asks is worse than not asking it.
 */
const FOCUS_CHOICES = [
  {
    value: "authorship",
    label: "Was this vibe coded?",
    hint: "How much of it looks AI-written, and the evidence for that.",
  },
  {
    value: "health",
    label: "Is this code any good?",
    hint: "Duplication, dead code, tests, and how it is put together.",
  },
  {
    value: "security",
    label: "Is this safe?",
    hint: "Exposed keys, unprotected pages, risky code.",
    /*
     * Offered but not selectable. Hiding it would misrepresent the product's
     * shape; letting it be picked would answer "not analysed yet" to the one
     * question the visitor came with.
     */
    unavailable: "not built yet",
  },
] as const;

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
  "Weighing the evidence…",
];

export function StartScanForm() {
  const router = useRouter();
  const [focus, setFocus] = useState<string>("authorship");
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
    body.set("focus", focus);
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
      {/* The question comes before the input: decide what you want to know,
          then say which repository to look at. */}
      <fieldset className="field fieldset-reset">
        <legend>What do you want to check?</legend>
        <p className="hint">
          We run every check either way &mdash; this decides what the report
          leads with.
        </p>
        <div className="choices">
          {FOCUS_CHOICES.map((choice) => {
            const unavailable = "unavailable" in choice;
            return (
              <label
                className={`choice${unavailable ? " choice-unavailable" : ""}`}
                key={choice.value}
              >
                <input
                  type="radio"
                  name="focus"
                  value={choice.value}
                  checked={focus === choice.value}
                  disabled={busy || unavailable}
                  onChange={() => setFocus(choice.value)}
                />
                <strong>{choice.label}</strong>
                <em>{choice.hint}</em>
                {unavailable ? (
                  <span className="choice-badge">{choice.unavailable}</span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>

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
