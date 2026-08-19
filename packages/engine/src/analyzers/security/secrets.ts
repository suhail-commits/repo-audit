import type { Finding, Location, Severity, Signal } from "@vibe/shared";

import type { IndexedFile } from "../../index/files";
import { basenameOf } from "../../ingest/guards";
import { type AnalysisContext } from "../context";

/**
 * Credentials committed into the repository.
 *
 * Two signals live here because they answer the same question from opposite
 * ends: `hardcoded-secrets` finds a credential wherever it was written, and
 * `committed-env` finds the file that exists to hold them. They share the
 * placeholder vocabulary, which is the part that decides whether either fires.
 *
 * **Provider prefixes only.** A generic `DB_PASSWORD = "hunter2"` is not caught
 * and is not meant to be. Entropy-based detection fires on hashes, minified
 * output, base64 fixtures, UUIDs and git SHAs — every repository is full of
 * high-entropy strings that are not secrets — and in this project a false
 * positive costs more than a missed finding. A provider prefix is close to
 * ground truth: nothing that is not an AWS key begins `AKIA` and continues for
 * exactly sixteen more uppercase characters.
 *
 * **What this cannot see:** a secret committed and later deleted stays in git
 * history, and we never look there. The GitHub path fetches a source tarball,
 * which is the current tree, and the commit API gives us no patch text. A repo
 * that leaked a key last year and removed it reads clean here.
 */

/** Presence-shaped: one live credential is full exposure, not one over N files. */
export const SECRET_WEIGHT = 4;
export const ENV_WEIGHT = 2.5;

interface SecretPattern {
  id: string;
  /** What the reader is told was found. Never accompanied by the value. */
  label: string;
  re: RegExp;
  severity: Severity;
}

/**
 * Each pattern is anchored to a vendor-assigned prefix and a fixed body length.
 *
 * Deliberately omitted: bare 32-hex Twilio-style ids and anything matching only
 * on shape. `[0-9a-f]{32}` is also every MD5 digest in every fixture file.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key",
    label: "AWS access key ID",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    severity: "critical",
  },
  {
    id: "github-token",
    label: "GitHub personal access token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    severity: "critical",
  },
  {
    id: "github-fine-grained",
    label: "GitHub fine-grained token",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    severity: "critical",
  },
  {
    id: "stripe-live-key",
    label: "Stripe live secret key",
    re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/,
    severity: "critical",
  },
  {
    id: "anthropic-key",
    label: "Anthropic API key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    severity: "critical",
  },
  {
    id: "openai-key",
    label: "OpenAI API key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
    severity: "critical",
  },
  {
    id: "private-key",
    label: "Private key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: "critical",
  },
  {
    id: "gcp-service-account",
    label: "Google service-account key",
    re: /"type"\s*:\s*"service_account"/,
    severity: "critical",
  },
  {
    id: "slack-token",
    label: "Slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    severity: "high",
  },
  {
    id: "google-api-key",
    label: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: "high",
  },
  {
    id: "npm-token",
    label: "npm access token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/,
    severity: "high",
  },
  {
    id: "sendgrid-key",
    label: "SendGrid API key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
    severity: "high",
  },
];

/**
 * One cheap pass to find candidate lines before running twelve patterns on each.
 *
 * Without it every line of every file is tested twelve times. This is the same
 * alternation with the expensive tails removed, so it over-matches and is only
 * ever used to skip.
 */
const CANDIDATE = /AKIA|ASIA|gh[pousr]_|github_pat_|[sr]k_live_|sk-|BEGIN |service_account|xox[baprs]-|AIza|npm_|SG\./;

/**
 * Words that mean "this is not the real value".
 *
 * Matched against the whole line rather than the captured value, because the
 * giveaway is usually beside the string: `AWS_KEY=AKIA... # example only`.
 */
const PLACEHOLDER =
  /example|sample|placeholder|dummy|redacted|your[-_ ]|my[-_ ]?(?:secret|key|token)|xxxx|\.\.\.|<[a-z_]+>|\bfake\b|\btest(?:ing)?\b|changeme|replace[-_ ]?me/i;

/** Very long lines are minified bundles or embedded data, never authored code. */
const MAX_LINE = 500;

export interface SecretHit {
  pattern: SecretPattern;
  file: string;
  line: number;
}

/**
 * Files a credential in which would be a real finding.
 *
 * Tests and generated output are excluded because both are full of
 * correctly-shaped fake keys — that is what a fixture *is*. Markdown is
 * excluded for the same reason: documentation shows people what a key looks
 * like. Each exclusion is a deliberate miss, and each one exists because the
 * alternative fires on well-kept repositories.
 */
function isEligible(file: IndexedFile): boolean {
  if (file.isTest || file.isGenerated || file.isLockfile) return false;
  if (file.ext === ".md") return false;
  return true;
}

export function findSecrets(ctx: AnalysisContext): SecretHit[] {
  const hits: SecretHit[] = [];

  for (const file of ctx.files.all()) {
    if (!isEligible(file)) continue;
    if (!CANDIDATE.test(file.content)) continue;

    const lines = file.content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > MAX_LINE) continue;
      if (!CANDIDATE.test(line)) continue;
      /*
       * The preceding line counts too. Annotating a sample credential on the
       * line above it is at least as common as doing so inline:
       *
       *   // example only — replace with your own
       *   const accessKeyId = "AKIA…";
       *
       * Widening in this direction trades a missed finding for a false
       * positive avoided, which is the trade this project makes everywhere.
       */
      if (PLACEHOLDER.test(line)) continue;
      if (i > 0 && PLACEHOLDER.test(lines[i - 1]!)) continue;

      for (const pattern of SECRET_PATTERNS) {
        if (!pattern.re.test(line)) continue;
        hits.push({ pattern, file: file.relPath, line: i + 1 });
        // One finding per line is enough; a line rarely holds two credentials
        // and reporting the same line twice reads as two leaks.
        break;
      }
    }
  }

  return hits;
}

export function hardcodedSecretsSignal(ctx: AnalysisContext): Signal {
  const id = "hardcoded-secrets";
  const hits = findSecrets(ctx);

  const perFile: Record<string, number> = {};
  for (const hit of hits) perFile[hit.file] = 1;

  const worst = hits.some((h) => h.pattern.severity === "critical")
    ? "critical"
    : hits.length > 0
      ? "high"
      : "none";

  const evidence = hits.slice(0, 5).map(
    (h) => `${h.file}:${h.line} — ${h.pattern.label}`,
  );
  if (hits.length > 5) {
    evidence.push(`and ${hits.length - 5} more`);
  }

  return {
    id,
    /*
     * Presence-shaped, not a ratio. One committed key in a 500-file repository
     * is a ratio of 0.002, which would score ~0 and render the section as
     * "solid" — the false-negative-by-averaging this project treats as a bug.
     * The count belongs in the finding; the score answers "is this exposed".
     */
    value: worst === "critical" ? 1 : worst === "high" ? 0.7 : 0,
    weight: SECRET_WEIGHT,
    available: true,
    evidence,
    perFile,
  };
}

export function hardcodedSecretFindings(ctx: AnalysisContext): Finding[] {
  const hits = findSecrets(ctx);
  if (hits.length === 0) return [];

  // Grouped by credential kind: "AWS access key in 2 places" is one problem to
  // fix, where two separate findings read as two unrelated ones.
  const byPattern = new Map<string, { pattern: SecretPattern; at: Location[] }>();
  for (const hit of hits) {
    const entry = byPattern.get(hit.pattern.id) ?? {
      pattern: hit.pattern,
      at: [],
    };
    entry.at.push({ file: hit.file, line: hit.line });
    byPattern.set(hit.pattern.id, entry);
  }

  return [...byPattern.values()].map(({ pattern, at }) => ({
    /*
     * One rule id for every vendor, with the kind carried in `data`. Twelve
     * ids would need twelve near-identical templates in `packages/rules`, and
     * `narrator.test.ts` would demand each of them — the rule is "a credential
     * was committed"; which vendor issued it is a detail of the instance.
     */
    ruleId: "hardcoded-secret",
    dimension: "security" as const,
    severity: pattern.severity,
    /*
     * `certain` is earned here rather than inferred. A vendor-assigned prefix
     * followed by its exact body length is ground truth about what the string
     * is — not a heuristic about what it might be. Whether the credential is
     * still live is a different question, and the finding does not claim it.
     */
    confidence: "certain" as const,
    source: "builtin" as const,
    title:
      at.length === 1
        ? `${pattern.label} committed to the repository`
        : `${pattern.label} committed in ${at.length} places`,
    locations: at.slice(0, 8),
    data: {
      credential: pattern.label,
      vendor: pattern.id,
      occurrences: at.length,
    },
    estimatedFixMinutes: 30 + at.length * 10,
  }));
}

// ---------------------------------------------------------------------------
// Committed .env
// ---------------------------------------------------------------------------

/** Suffixes that mean the file is a template for a `.env`, not a `.env`. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?|local\.example)$/i;

/**
 * A `.env` that is tracked and holds values that look real.
 *
 * **The trap this exists to avoid:** `pnpm scan .` walks the working directory,
 * so it sees gitignored files. A developer's own local `.env` is not a
 * committed one, and flagging it would accuse the reader of leaking their own
 * dev config on the project's fastest sanity check. The GitHub path cannot hit
 * this — a source tarball contains only committed files — which is exactly why
 * the local path is the one that needs the guard.
 */
export function committedEnvFiles(ctx: AnalysisContext): IndexedFile[] {
  const ignored = gitignorePatterns(ctx);

  return ctx.files.all().filter((file) => {
    const base = basenameOf(file.relPath);
    if (!base.startsWith(".env")) return false;
    if (ENV_TEMPLATE.test(base)) return false;
    if (isIgnored(file.relPath, base, ignored)) return false;
    return hasRealValues(file.content);
  });
}

export function committedEnvSignal(ctx: AnalysisContext): Signal {
  const id = "committed-env";
  const files = committedEnvFiles(ctx);

  const perFile: Record<string, number> = {};
  for (const file of files) perFile[file.relPath] = 1;

  return {
    id,
    value: files.length > 0 ? 1 : 0,
    weight: ENV_WEIGHT,
    available: true,
    evidence: files.map(
      (f) => `${f.relPath} is committed and holds values that are not placeholders`,
    ),
    perFile,
  };
}

export function committedEnvFindings(ctx: AnalysisContext): Finding[] {
  const files = committedEnvFiles(ctx);
  if (files.length === 0) return [];

  return [
    {
      ruleId: "committed-env-file",
      dimension: "security",
      severity: "high",
      confidence: "certain",
      source: "builtin",
      title:
        files.length === 1
          ? `${files[0]!.relPath} is committed to the repository`
          : `${files.length} environment files are committed to the repository`,
      locations: files.map((f) => ({ file: f.relPath })),
      data: { files: files.map((f) => f.relPath) },
      estimatedFixMinutes: 45,
    },
  ];
}

/**
 * Does this file contain assignments whose values are not obviously fake?
 *
 * A committed `.env` holding `PORT=3000` is untidy; one holding a database URL
 * is a finding. Without this the check fires on every project that ships a
 * `.env` of defaults, which is common and harmless.
 */
function hasRealValues(content: string): boolean {
  for (const line of content.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "").trim();
    if (value === "") continue;
    if (PLACEHOLDER.test(value)) continue;

    // Only values that look like credentials count. A committed `NODE_ENV` or
    // `PORT` is not what this signal is about.
    if (!/secret|token|key|password|passwd|pwd|credential|dsn|url|uri|conn/i.test(key)) {
      continue;
    }
    if (value.length < 8) continue;
    return true;
  }
  return false;
}

interface IgnoreRule {
  /** Directory the rule is scoped to, "" for the repository root. */
  dir: string;
  pattern: string;
}

function gitignorePatterns(ctx: AnalysisContext): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const file of ctx.files.all()) {
    if (basenameOf(file.relPath) !== ".gitignore") continue;
    const slash = file.relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.relPath.slice(0, slash);

    for (const raw of file.content.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      // Negations are rare and reversing one wrongly would produce a false
      // positive, so an ignore file containing them simply contributes its
      // positive rules.
      if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
      rules.push({ dir, pattern: line.replace(/\/+$/, "") });
    }
  }

  return rules;
}

/**
 * Would any ignore rule cover this path?
 *
 * Deliberately over-eager: a rule that *might* match counts as a match. Being
 * wrong in this direction stays quiet about a file that is probably not
 * committed; being wrong in the other direction accuses the reader of leaking
 * their own local config.
 */
function isIgnored(relPath: string, base: string, rules: IgnoreRule[]): boolean {
  return rules.some((rule) => {
    if (rule.dir !== "" && !relPath.startsWith(`${rule.dir}/`)) return false;

    const pattern = rule.pattern.replace(/^\//, "");
    const target = rule.dir === "" ? relPath : relPath.slice(rule.dir.length + 1);

    if (pattern === base || pattern === target) return true;
    if (!pattern.includes("*")) return false;

    const re = new RegExp(
      `^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`,
    );
    return re.test(base) || re.test(target);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
