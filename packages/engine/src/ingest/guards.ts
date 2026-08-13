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

/**
 * Extensions parsed structurally by tree-sitter.
 *
 * Only languages whose node names are wired into the structural signals and
 * which have been swept against a real repository. `tree-sitter-wasms` ships
 * thirty-odd grammars that load fine; loading is not the same as analysing
 * correctly.
 */
export const STRUCTURAL_EXTENSIONS = new Set([".py", ".pyi", ".go", ".rs"]);

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
  // Key material. Read so a committed private key can be found — without these
  // the file is never indexed and the secret scanner cannot see what it exists
  // to look for.
  ".pem",
  ".key",
]);

/** Exact filenames worth reading regardless of extension. */
export const SUPPORTING_FILENAMES = new Set([
  "dockerfile",
  // SSH private keys carry no extension at all.
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
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
  // Non-npm ecosystems, added so the dependency-vulnerability check can read
  // them. Listed here rather than as source because none of them is authored
  // code, which is exactly what `isLockfile` is asked elsewhere.
  "poetry.lock",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "gemfile.lock",
  "composer.lock",
]);

/**
 * Python's pinned-dependency convention, which has no single filename.
 * `requirements.txt`, `requirements-dev.txt`, `requirements/base.txt`.
 */
const REQUIREMENTS_RE = /(^|[/\\])requirements[^/\\]*\.txt$/i;

export function isRequirementsFile(relPath: string): boolean {
  return REQUIREMENTS_RE.test(relPath);
}

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
  // `tsd` type tests: `*.test-d.ts`, conventionally under `test-d/`. Seen on
  // `sindresorhus/execa`, where 151 of 261 files were type tests — nothing
  // imports them, and nothing is meant to, so every one read as dead code and
  // pushed both `orphan-files` and the health score up on a well-kept repo.
  /\.test-d\.[cm]?tsx?$/i,
  /(^|[/\\])test-d[/\\]/i,
  // A bare `test.js` / `tests.ts` is a common layout in small packages. Without
  // this, the file counts as authored source (inflating duplication findings)
  // while the tautology signal simultaneously reports "the project has no tests".
  /(^|[/\\])(tests?|spec)\.[cm]?[jt]sx?$/i,
  // Python conventions: pytest collects test_*.py and *_test.py.
  /(^|[/\\])test_[^/\\]*\.pyi?$/i,
  /_test\.pyi?$/i,
  // Go: `*_test.go` is enforced by the toolchain itself, so it is about as
  // canonical as a test convention gets. Seen on `spf13/cobra`, where every
  // single clone family was in a `_test.go` file and `duplicate-logic` read
  // 0.80 on a well-regarded hand-written library. Fifth instance of the same
  // mistake as the bare `test.js`, top-level `test/` and `tsd` cases.
  /_test\.go$/i,
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

/** Names a licence file carries. `LICENSE-MIT` and `LICENCE` both count. */
const LICENSE_NAME = /^(?:un)?licen[cs]e(?:[-._].*)?$|^copying(?:[-._].*)?$|^notice(?:[-._].*)?$/;

/**
 * Extensions a licence is written with. The empty string is the common case.
 *
 * Constrained deliberately: without it a source file called `license.ts` — a
 * licence *checker*, say — would be picked up as the project's licence.
 */
const LICENSE_EXTENSIONS = new Set(["", ".md", ".txt", ".rst"]);

/**
 * A licence file, which until now was never indexed at all.
 *
 * `LICENSE` has no extension and was in no filename list, so `isRelevantFile`
 * rejected it and the file never reached `FileIndex`. **Exactly the shape of the
 * `deploy/id_rsa` bug**: the one file a check most exists to read was invisible
 * to it, and nothing failed — the check simply found nothing, which is
 * indistinguishable from a repository with nothing to find.
 */
export function isLicenseFile(relPath: string): boolean {
  const base = basenameOf(relPath);
  const ext = extensionOf(relPath);
  const stem = ext === "" ? base : base.slice(0, -ext.length);
  return LICENSE_EXTENSIONS.has(ext) && LICENSE_NAME.test(stem);
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
  if (isRequirementsFile(relPath)) return true;
  if (isLicenseFile(relPath)) return true;
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
