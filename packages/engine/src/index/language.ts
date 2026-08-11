import { extensionOf } from "../ingest/guards";

/**
 * How deeply a language can be analyzed.
 *
 * Every repository gets a real verdict; the tier records how much of the
 * evidence was reachable, and the report states it. A language we cannot parse
 * must never quietly score lower than one we can — it scores on fewer signals,
 * at lower confidence, and says so.
 */
export type AnalysisTier =
  /** Parsed semantically: every signal, plus framework-aware security rules. */
  | "full"
  /** Parsed structurally: duplication, comment narration, test assertions. */
  | "structural"
  /** Not parsed: commit history and repository shape only. */
  | "history";

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "ruby"
  | "php"
  | "c"
  | "cpp"
  | "swift"
  | "kotlin"
  | "other";

const BY_EXTENSION: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
};

const TIERS: Record<Language, AnalysisTier> = {
  typescript: "full",
  javascript: "full",
  python: "structural",
  go: "history",
  rust: "history",
  java: "history",
  csharp: "history",
  ruby: "history",
  php: "history",
  c: "history",
  cpp: "history",
  swift: "history",
  kotlin: "history",
  other: "history",
};

export function languageOf(relPath: string): Language {
  return BY_EXTENSION[extensionOf(relPath)] ?? "other";
}

export function tierFor(language: Language): AnalysisTier {
  return TIERS[language];
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  c: "C",
  cpp: "C++",
  swift: "Swift",
  kotlin: "Kotlin",
  other: "other languages",
};

export interface LanguageShare {
  language: Language;
  label: string;
  tier: AnalysisTier;
  files: number;
  sloc: number;
  /** Share of authored source lines, 0-1. */
  share: number;
}

export interface LanguageProfile {
  /** Descending by lines of code. */
  shares: LanguageShare[];
  /** The tier the bulk of this repository could be analyzed at. */
  dominantTier: AnalysisTier;
  dominant: Language | null;
  /** Languages present that we could only judge from history. */
  unparsed: Language[];
}

/**
 * Summarise which languages a repository is written in and how deeply each
 * could be analyzed. Computed over lines rather than file counts — a repo with
 * fifty tiny config files and one enormous module is not "mostly config".
 */
export function profileLanguages(
  files: { relPath: string; sloc: number }[],
): LanguageProfile {
  const totals = new Map<Language, { files: number; sloc: number }>();

  for (const file of files) {
    const language = languageOf(file.relPath);
    const entry = totals.get(language) ?? { files: 0, sloc: 0 };
    entry.files += 1;
    entry.sloc += file.sloc;
    totals.set(language, entry);
  }

  const totalSloc = [...totals.values()].reduce((sum, t) => sum + t.sloc, 0);

  const shares: LanguageShare[] = [...totals.entries()]
    .map(([language, t]) => ({
      language,
      label: LANGUAGE_LABELS[language],
      tier: tierFor(language),
      files: t.files,
      sloc: t.sloc,
      share: totalSloc === 0 ? 0 : t.sloc / totalSloc,
    }))
    .sort((a, b) => b.sloc - a.sloc);

  const dominant = shares[0]?.language ?? null;

  return {
    shares,
    dominant,
    dominantTier: dominant ? tierFor(dominant) : "history",
    unparsed: shares
      .filter((s) => s.tier === "history" && s.share > 0.05)
      .map((s) => s.language),
  };
}
