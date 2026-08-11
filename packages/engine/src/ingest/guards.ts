import { posix } from "node:path";

/**
 * Limits and filters applied to every repo before analysis.
 *
 * These exist for two reasons: analysis cost, and the fact that we are processing
 * untrusted user-supplied archives. Nothing here executes repo code — the engine
 * only ever reads and parses.
 */

export const LIMITS = {
  /** Files above this are indexed by name but never read or parsed. */
  maxFileBytes: 1_000_000,
  /** Hard cap on files considered; beyond this the scan reports truncation. */
  maxFiles: 25_000,
  /**
   * Hard cap on source bytes read into memory across a scan. Generous for real
   * source trees once node_modules and build output are excluded.
   */
  maxTotalBytes: 150_000_000,
  /** Reject archives that expand beyond this (zip-bomb guard). */
  maxExtractedBytes: 500_000_000,
  /** Reject archives with more entries than this. */
  maxArchiveEntries: 50_000,
} as const;

/** Directories never worth analyzing. Matched against any path segment. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".netlify",
  ".output",
  "coverage",
  ".nyc_output",
  ".cache",
  ".parcel-cache",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",
  ".gradle",
  "target",
  ".terraform",
]);

/** Extensions parsed semantically by oxc — the full-analysis tier. */
export const JS_TS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Extensions parsed structurally by tree-sitter. */
export const STRUCTURAL_EXTENSIONS = new Set([".py", ".pyi"]);

/**
 * Everything treated as source code.
 *
 * Files in languages we cannot parse still count towards the language profile
 * and line totals, so the report can say what it could not analyze rather than
 * behaving as though those files do not exist.
 */
export const CODE_EXTENSIONS = new Set([
  ...JS_TS_EXTENSIONS,
  ...STRUCTURAL_EXTENSIONS,
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".hpp",
  ".swift",
  ".kt",
  ".kts",
]);

export function isJsTsFile(relPath: string): boolean {
  return JS_TS_EXTENSIONS.has(extensionOf(relPath));
}

export function isStructuralFile(relPath: string): boolean {
  return STRUCTURAL_EXTENSIONS.has(extensionOf(relPath));
}

/**
 * Non-code text files that individual rules still need to read: schemas,
 * migrations, manifests, container config, docs.
 */
export const SUPPORTING_EXTENSIONS = new Set([
  ".json",
  ".sql",
  ".prisma",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
  ".sh",
  ".graphql",
  ".gql",
]);

/** Exact filenames worth reading regardless of extension. */
export const SUPPORTING_FILENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "procfile",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".gitignore",
  ".npmrc",
]);

/**
 * Lockfiles are read for dependency-CVE scanning but never parsed or counted as
 * authored code — they would swamp every LOC and duplication metric.
 */
export const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
]);

const GENERATED_PATH_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.bundle\.js$/i,
  // Framework-emitted ambient declarations. They are never imported and never
  // authored, so counting them makes real projects look full of dead files.
  /(^|[/\\])next-env\.d\.ts$/i,
  /(^|[/\\])vite-env\.d\.ts$/i,
  /(^|[/\\])env\.d\.ts$/i,
  /\.generated\./i,
  /[/\\]generated[/\\]/i,
  /[/\\]__generated__[/\\]/i,
  /[/\\]\.gen[/\\]/i,
  /[/\\]migrations?[/\\].*\.(ts|js)$/i,
];

const TEST_PATH_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  // A bare `test.js` / `tests.ts` is a common layout in small packages. Without
  // this, the file counts as authored source (inflating duplication findings)
  // while the tautology signal simultaneously reports "the project has no tests".
  /(^|[/\\])(tests?|spec)\.[cm]?[jt]sx?$/i,
  // Python conventions: pytest collects test_*.py and *_test.py.
  /(^|[/\\])test_[^/\\]*\.pyi?$/i,
  /_test\.pyi?$/i,
  /(^|[/\\])conftest\.pyi?$/i,
  /(^|[/\\])__tests__[/\\]/i,
  /(^|[/\\])__mocks__[/\\]/i,
  // `(^|...)` rather than a required leading separator: a top-level `test/`
  // directory has no slash before it, so anchoring here missed every helper in
  // `test/` at the repo root (seen on ai/nanoid).
  /(^|[/\\])(tests?|e2e|cypress|playwright)[/\\]/i,
];

/** Normalize to repo-relative POSIX form so every index keys the same way. */
export function normalizePath(relPath: string): string {
  return relPath.split(/[\\/]/).filter(Boolean).join(posix.sep);
}

export function isIgnoredPath(relPath: string): boolean {
  return normalizePath(relPath)
    .split(posix.sep)
    .some((seg) => IGNORED_DIRS.has(seg));
}

export function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // A leading dot means a dotfile (".env"), not an extension.
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function basenameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
}

export function isCodeFile(relPath: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(relPath));
}

export function isLockfile(relPath: string): boolean {
  return LOCKFILES.has(basenameOf(relPath));
}

export function isTestFile(relPath: string): boolean {
  return TEST_PATH_PATTERNS.some((p) => p.test(relPath));
}

export function isGeneratedPath(relPath: string): boolean {
  return GENERATED_PATH_PATTERNS.some((p) => p.test(relPath));
}

/** Whether the file should be read into the index at all. */
export function isRelevantFile(relPath: string): boolean {
  if (isIgnoredPath(relPath)) return false;
  if (isCodeFile(relPath)) return true;
  if (isLockfile(relPath)) return true;
  const base = basenameOf(relPath);
  if (SUPPORTING_FILENAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (base.startsWith("dockerfile")) return true;
  return SUPPORTING_EXTENSIONS.has(extensionOf(relPath));
}

/**
 * Content-based generated-file detection, for files whose path looks authored.
 * Only the head of the file is inspected.
 */
export function hasGeneratedHeader(content: string): boolean {
  const head = content.slice(0, 1000);
  return (
    head.includes("@generated") ||
    /Code generated .*DO NOT EDIT/i.test(head) ||
    /DO NOT EDIT THIS FILE/i.test(head) ||
    /auto-?generated by/i.test(head)
  );
}

/** A NUL byte in the first 8KB is the standard heuristic for binary content. */
export function isBinaryContent(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Reject archive entry paths that would escape the extraction root — absolute
 * paths, drive letters, and `..` traversal (zip-slip). Returns the safe
 * normalized path, or null if the entry must be discarded.
 */
export function safeArchivePath(entryPath: string): string | null {
  const raw = entryPath.replace(/\\/g, "/");
  if (raw.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(raw)) return null;
  const segments: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    // Windows reserved names and NUL bytes in entry names.
    if (seg.includes("\0")) return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
