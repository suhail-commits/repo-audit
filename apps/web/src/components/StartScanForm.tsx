"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

const PERSONA_CHOICES = [
  {
    value: "founder",
    label: "I run this product",
    hint: "Plain English, and what each problem could actually cost you.",
  },
  {
    value: "engineer",
    label: "I write the code",
    hint: "File and line numbers, with the fix.",
  },
  {
    value: "acquirer",
    label: "I'm evaluating this codebase",
    hint: "Risk rating and an estimate of the work needed to fix it.",
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
  const [persona, setPersona] = useState<string>("founder");
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
    body.set("persona", persona);
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
        <p className="hint">Paste a URL, or just owner/repo.</p>
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

      <fieldset
        className="field"
        style={{ border: 0, padding: 0, margin: "0 0 1.5rem" }}
      >
        <legend style={{ fontWeight: 600, fontSize: "0.9rem", padding: 0 }}>
          Who&rsquo;s reading this report?
        </legend>
        <p className="hint">This only changes how results are explained.</p>
        <div className="choices">
          {PERSONA_CHOICES.map((choice) => (
            <label className="choice" key={choice.value}>
              <input
                type="radio"
                name="persona"
                value={choice.value}
                checked={persona === choice.value}
                disabled={busy}
                onChange={() => setPersona(choice.value)}
              />
              <strong>{choice.label}</strong>
              <em>{choice.hint}</em>
            </label>
          ))}
        </div>
      </fieldset>

      <button type="submit" disabled={busy}>
        {busy ? "Analysing…" : "Analyse this codebase"}
      </button>

      {busy ? (
        <p className="hint" style={{ marginTop: "0.9rem" }} aria-live="polite">
          {STAGES[stage]}
        </p>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
