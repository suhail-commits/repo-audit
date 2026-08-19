import type { Finding, Signal } from "@vibe/shared";

import { isLicenseFile } from "../../ingest/guards";
import type { AnalysisContext } from "../context";

/**
 * Who is allowed to use this code, and does the repository agree with itself?
 *
 * This is the first question in technical due diligence and the one that ends
 * deals — unassigned IP or a copyleft obligation nobody noticed is not a bug to
 * schedule, it is a reason to walk. It lives in Security rather than in a
 * section of its own because it is the same kind of question: something the
 * repository exposes that its owner may not know about.
 *
 * **Everything here is offline.** The other half of the question — what the
 * dependencies are licensed under — is not answered, and cannot be cheaply:
 * there is no batch licence API, and asking the npm registry per package is a
 * request each, five hundred of them for a mid-size tree, inside one serverless
 * invocation. So that half is stated as not examined rather than quietly
 * omitted, which is invariant 5 applied to a whole half of a check.
 */

/** No licence at all is a real answer, but a mild one: it creates ambiguity. */
export const MISSING_WEIGHT = 1.5;

/** A contradiction is worse than a silence — two files disagree on the terms. */
export const MISMATCH_WEIGHT = 2.5;

/**
 * Distinctive phrases, longest-standing first.
 *
 * Order is load-bearing: every GNU licence contains "GNU ... GENERAL PUBLIC
 * LICENSE", so AGPL and LGPL must be tested before GPL or all three read as
 * GPL — and the difference between AGPL and GPL is the entire reason anyone
 * checks. Same for BSD, where the 3-clause text is the 2-clause text plus a
 * paragraph.
 */
const FINGERPRINTS: { id: string; test: (text: string) => boolean }[] = [
  {
    id: "AGPL-3.0",
    test: (t) => t.includes("gnu affero general public license"),
  },
  {
    id: "LGPL-3.0",
    test: (t) =>
      t.includes("gnu lesser general public license") && t.includes("version 3"),
  },
  {
    id: "LGPL-2.1",
    test: (t) => t.includes("gnu lesser general public license"),
  },
  {
    id: "GPL-3.0",
    test: (t) =>
      t.includes("gnu general public license") && t.includes("version 3"),
  },
  { id: "GPL-2.0", test: (t) => t.includes("gnu general public license") },
  {
    id: "MPL-2.0",
    test: (t) => t.includes("mozilla public license") && t.includes("2.0"),
  },
  {
    id: "Apache-2.0",
    test: (t) => t.includes("apache license") && t.includes("version 2.0"),
  },
  {
    id: "MIT",
    test: (t) =>
      t.includes("permission is hereby granted, free of charge, to any person"),
  },
  {
    id: "ISC",
    test: (t) =>
      t.includes("permission to use, copy, modify, and/or distribute this software"),
  },
  {
    id: "BSD-3-Clause",
    test: (t) =>
      t.includes("redistribution and use in source and binary forms") &&
      t.includes("may be used to endorse or promote products"),
  },
  {
    id: "BSD-2-Clause",
    test: (t) => t.includes("redistribution and use in source and binary forms"),
  },
  {
    id: "Unlicense",
    test: (t) =>
      t.includes("free and unencumbered software released into the public domain"),
  },
];

export interface LicenseReading {
  /** Repo-relative path of the licence file, if one was found. */
  file?: string;
  /** SPDX id recognised from the text. Absent when the text matched nothing. */
  identified?: string;
  /** SPDX id declared in a manifest, e.g. `package.json`'s `license` field. */
  declared?: string;
  /** Where the declaration was read from. */
  declaredIn?: string;
}

export function readLicense(ctx: AnalysisContext): LicenseReading {
  const reading: LicenseReading = {};

  /*
   * Shallowest wins. A monorepo carries a licence per package, and the one that
   * governs the repository is the one at the root — picking an arbitrary
   * package's would compare the wrong file against the root manifest and
   * manufacture a mismatch.
   */
  const files = ctx.files
    .all()
    .filter((f) => isLicenseFile(f.relPath))
    .sort(
      (a, b) =>
        depth(a.relPath) - depth(b.relPath) ||
        a.relPath.localeCompare(b.relPath),
    );

  const file = files[0];
  if (file) {
    reading.file = file.relPath;
    const identified = identifyLicense(file.content);
    if (identified) reading.identified = identified;
  }

  const declaration = readDeclaration(ctx);
  if (declaration) {
    reading.declared = declaration.id;
    reading.declaredIn = declaration.file;
  }

  return reading;
}

export function identifyLicense(text: string): string | undefined {
  // Collapse whitespace: licence texts are hard-wrapped at varying widths, so a
  // phrase match against the raw text fails whenever a line break lands inside
  // the phrase.
  const normalised = text.toLowerCase().replace(/\s+/g, " ");
  return FINGERPRINTS.find((f) => f.test(normalised))?.id;
}

// ---------------------------------------------------------------------------

function depth(relPath: string): number {
  return relPath.split("/").length;
}

/** The licence a manifest claims, from the shallowest manifest that states one. */
function readDeclaration(
  ctx: AnalysisContext,
): { id: string; file: string } | undefined {
  const candidates = ctx.files
    .all()
    .filter((f) => {
      const base = f.relPath.split("/").pop() ?? "";
      return base === "package.json" || base === "Cargo.toml";
    })
    .sort((a, b) => depth(a.relPath) - depth(b.relPath));

  for (const file of candidates) {
    const id = file.relPath.endsWith("package.json")
      ? fromPackageJson(file.content)
      : fromCargoToml(file.content);
    if (id) return { id, file: file.relPath };
  }
  return undefined;
}

function fromPackageJson(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { license?: unknown };
    return typeof parsed.license === "string" && parsed.license.trim() !== ""
      ? parsed.license.trim()
      : undefined;
  } catch {
    // A manifest we cannot parse is not a declaration. Nothing else in the
    // engine treats unparseable JSON as fatal either.
    return undefined;
  }
}

function fromCargoToml(content: string): string | undefined {
  // Deliberately not a TOML parser: one key, at the top level, quoted.
  const match = /^\s*license\s*=\s*"([^"]+)"/m.exec(content);
  return match?.[1]?.trim();
}

/**
 * Whether a declared SPDX expression covers the licence the text turned out to
 * be.
 *
 * Declarations are expressions, not ids — `(MIT OR Apache-2.0)` is common and
 * dual-licensed projects are not in conflict with either of their own licence
 * files. So this asks whether the identified id appears among the declaration's
 * terms, rather than comparing two strings.
 */
export function licenseMatches(declared: string, identified: string): boolean {
  const terms = declared
    .toUpperCase()
    .split(/[^A-Z0-9.+-]+/)
    .filter((t) => t !== "");
  const target = identified.toUpperCase();

  if (terms.includes(target)) return true;

  /*
   * `LICENSE` files carry the full text of a *versioned* licence while manifests
   * routinely declare the family — `GPL-3.0` against a file identified as
   * `GPL-3.0-only`, or `BSD` against `BSD-3-Clause`. Treating a prefix as
   * agreement keeps the signal on real contradictions (MIT declared, AGPL text)
   * rather than on notation.
   */
  return terms.some(
    (term) => target.startsWith(term) || term.startsWith(target),
  );
}

// ---------------------------------------------------------------------------

/*
 * The three consumers below take a reading rather than a context, following
 * `analyzeDependencies`: read once, derive three times. Re-reading per consumer
 * would re-scan the file list and re-parse every manifest for an answer that
 * cannot have changed.
 */

export function missingLicenseSignal(reading: LicenseReading): Signal {
  const missing = reading.file === undefined;

  return {
    id: "missing-license",
    // Presence-shaped, like the rest of this dimension: a licence file either
    // exists or it does not, and there is no proportion to take.
    value: missing ? 1 : 0,
    weight: MISSING_WEIGHT,
    available: true,
    evidence: missing
      ? ["No licence file found — by default the code is all rights reserved."]
      : [
          reading.identified
            ? `${reading.identified} — \`${reading.file}\`.`
            : `\`${reading.file}\` present, but its text matches no licence we recognise.`,
        ],
  };
}

export function licenseMismatchSignal(reading: LicenseReading): Signal {
  /*
   * Both halves are needed to find a disagreement, and a missing half is not
   * agreement. Unrecognised text counts as missing too: we cannot say a licence
   * we failed to identify contradicts anything.
   */
  if (!reading.identified || !reading.declared) {
    return {
      id: "license-mismatch",
      value: 0,
      weight: MISMATCH_WEIGHT,
      available: false,
      evidence: [],
      unavailableReason: reading.identified
        ? "no licence is declared in a manifest, so there is nothing to compare the licence file against"
        : reading.file
          ? "the licence file's text matches no licence we recognise"
          : "there is no licence file to compare a declaration against",
    };
  }

  const mismatch = !licenseMatches(reading.declared, reading.identified);

  return {
    id: "license-mismatch",
    value: mismatch ? 1 : 0,
    weight: MISMATCH_WEIGHT,
    available: true,
    evidence: mismatch
      ? [
          `\`${reading.declaredIn}\` declares ${reading.declared}, but \`${reading.file}\` is ${reading.identified}.`,
        ]
      : [`${reading.identified}, and \`${reading.declaredIn}\` agrees.`],
  };
}

export function licenseFindings(reading: LicenseReading): Finding[] {
  const findings: Finding[] = [];

  if (!reading.file) {
    findings.push({
      ruleId: "missing-license",
      dimension: "security",
      severity: "low",
      // The absence of a file is observed, not inferred.
      confidence: "certain",
      source: "builtin",
      title: "No licence file",
      locations: [],
      data: {},
      estimatedFixMinutes: 10,
    });
    return findings;
  }

  if (
    reading.identified &&
    reading.declared &&
    !licenseMatches(reading.declared, reading.identified)
  ) {
    findings.push({
      ruleId: "license-mismatch",
      dimension: "security",
      severity: "medium",
      confidence: "high",
      source: "builtin",
      title: "The licence file and the manifest disagree",
      locations: [
        { file: reading.file },
        ...(reading.declaredIn ? [{ file: reading.declaredIn }] : []),
      ],
      data: {
        declared: reading.declared,
        identified: reading.identified,
        declaredIn: reading.declaredIn ?? "",
        licenseFile: reading.file,
      },
      estimatedFixMinutes: 30,
    });
  }

  return findings;
}

/**
 * The half of the question we did not answer, said out loud.
 *
 * Returned as a scan warning rather than as an unavailable signal on purpose:
 * an unavailable signal would drag coverage and therefore confidence down on
 * every scan forever, which would misrepresent a permanent design boundary as
 * missing evidence about this particular repository.
 */
export function licenseWarnings(): string[] {
  return [
    "Dependency licences were not examined — only the repository's own licence. " +
      "There is no batch licence lookup, and querying a registry per package would " +
      "cost hundreds of requests inside a single scan.",
  ];
}
