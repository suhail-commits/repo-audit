import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  extensionOf,
  hasGeneratedHeader,
  isBinaryContent,
  isCodeFile,
  isGeneratedPath,
  isLockfile,
  isTestFile,
} from "../ingest/guards";
import { walkRepo, type WalkedFile } from "../ingest/walk";

export interface IndexedFile {
  relPath: string;
  absPath: string;
  ext: string;
  sizeBytes: number;
  /** Total lines. */
  lines: number;
  /** Non-blank lines — the figure quoted as "lines of code". */
  sloc: number;
  /** SHA-1 of the raw content; identical hashes are exact duplicates. */
  hash: string;
  content: string;
  isCode: boolean;
  isTest: boolean;
  isGenerated: boolean;
  isLockfile: boolean;
}

/**
 * Every file in the repo worth looking at, read exactly once.
 *
 * All other indexes and every analyzer read from here. Nothing else in the engine
 * touches the filesystem for source content — reading a file twice on a large repo
 * is the difference between a scan that finishes and one that doesn't.
 */
export class FileIndex {
  private readonly byPath = new Map<string, IndexedFile>();

  readonly truncated: boolean;
  readonly oversized: string[];
  readonly warnings: string[] = [];

  private constructor(
    files: IndexedFile[],
    truncated: boolean,
    oversized: string[],
  ) {
    for (const f of files) this.byPath.set(f.relPath, f);
    this.truncated = truncated;
    this.oversized = oversized;
  }

  static async build(rootPath: string): Promise<FileIndex> {
    const walk = await walkRepo(rootPath);
    const files: IndexedFile[] = [];
    const skipped: string[] = [];

    for (const w of walk.files) {
      const indexed = await readIndexedFile(w);
      if (indexed) files.push(indexed);
      else skipped.push(w.relPath);
    }

    const index = new FileIndex(files, walk.truncated, walk.oversized);
    if (skipped.length > 0) {
      index.warnings.push(
        `${skipped.length} file(s) skipped as binary or unreadable`,
      );
    }
    if (walk.truncated) {
      index.warnings.push(
        "Repository exceeded scan limits; analysis covers a subset of files",
      );
    }
    return index;
  }

  get(relPath: string): IndexedFile | undefined {
    return this.byPath.get(relPath);
  }

  has(relPath: string): boolean {
    return this.byPath.has(relPath);
  }

  all(): IndexedFile[] {
    return [...this.byPath.values()];
  }

  /** Authored source only: excludes tests, generated output, and lockfiles. */
  sourceFiles(): IndexedFile[] {
    return this.all().filter(
      (f) => f.isCode && !f.isGenerated && !f.isLockfile && !f.isTest,
    );
  }

  codeFiles(): IndexedFile[] {
    return this.all().filter((f) => f.isCode && !f.isGenerated);
  }

  testFiles(): IndexedFile[] {
    return this.all().filter((f) => f.isCode && f.isTest);
  }

  /** Files matching a repo-relative path predicate — used by framework detection. */
  find(predicate: (f: IndexedFile) => boolean): IndexedFile[] {
    return this.all().filter(predicate);
  }

  get fileCount(): number {
    return this.byPath.size;
  }

  /** Total non-blank lines of authored source. The headline size figure. */
  get totalSloc(): number {
    return this.sourceFiles().reduce((sum, f) => sum + f.sloc, 0);
  }
}

async function readIndexedFile(w: WalkedFile): Promise<IndexedFile | null> {
  let buf: Buffer;
  try {
    buf = await readFile(w.absPath);
  } catch {
    return null;
  }
  if (isBinaryContent(buf)) return null;

  const content = buf.toString("utf8");
  const lines = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
  let sloc = 0;
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim().length > 0) sloc++;
  }

  return {
    relPath: w.relPath,
    absPath: w.absPath,
    ext: extensionOf(w.relPath),
    sizeBytes: w.sizeBytes,
    lines,
    sloc,
    hash: createHash("sha1").update(buf).digest("hex"),
    content,
    isCode: isCodeFile(w.relPath),
    isTest: isTestFile(w.relPath),
    isGenerated: isGeneratedPath(w.relPath) || hasGeneratedHeader(content),
    isLockfile: isLockfile(w.relPath),
  };
}
