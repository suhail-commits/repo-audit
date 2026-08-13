import type { Finding, Signal } from "@vibe/shared";

import {
  collect,
  memberPath,
  type AstNode,
  type ParsedFile,
} from "../../index/ast";
import type { Route } from "../../index/routes";
import { clamp01, unavailable, type AnalysisContext } from "../context";
import { countOf } from "../../format";

/**
 * Routes that change something and never check who is asking.
 *
 * This is what `RouteTable` was built for, and it is the highest
 * false-positive risk in the project — because the absence of a check inside a
 * handler is not the absence of a check.
 *
 * Three decisions carry that risk:
 *
 * 1. **Mutating methods only.** A public `GET /api/health` is correct design;
 *    an unauthenticated `DELETE /api/users/:id` is not. Counting reads would
 *    flag every public API on the internet — including this project's own
 *    `/api/scans`, which is deliberately open.
 * 2. **Middleware is subtracted where it can be read.** Next's
 *    `export const config = { matcher: [...] }` and Express's
 *    `app.use(path, guard)` are static enough to turn into path patterns.
 * 3. **When middleware exists but cannot be followed, the finding is still
 *    made — at `low`, saying so.** Going `unavailable` instead would silence
 *    this check on most real Next applications, and invariant 5 asks us to
 *    report what could not be determined, not to say nothing.
 */

export const WEIGHT = 3;

/** Verbs that change state. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A handler registered for every verb still has to *handle* a mutating one.
 *
 * A Next `pages/api` route has no per-verb export, so `RouteTable` records it
 * as `ALL` and the handler switches on `req.method` internally. Treating `ALL`
 * as mutating outright made every legacy Pages API route and every
 * `app.all()` a candidate — seen on `colinhacks/zod`, whose
 * `packages/docs/pages/api/_og.tsx` renders an Open Graph *image* and was
 * reported as a state-changing route with no access control. The only security
 * finding across the whole twenty-repo sweep, and it was ours.
 *
 * So an `ALL` route counts only when its body mentions a mutating verb, which
 * is how such a handler decides what to do in the first place.
 */
const HANDLES_MUTATION = /["'`](?:POST|PUT|PATCH|DELETE)["'`]/;

/**
 * Names that mean "the caller was identified".
 *
 * Deliberately wide. A missed name here produces a false positive — the worst
 * outcome this analyzer has — while an over-broad name merely keeps us quiet
 * about a route that probably is protected.
 */
const AUTH_CALLS =
  /(?:^|\.)(?:getServerSession|getSession|auth|authenticate|authorize|requireAuth|requireUser|requireSession|currentUser|getUser|getToken|verifyToken|verifyJwt|verifyIdToken|checkAuth|ensureAuthenticated|protect|guard|withAuth|isAuthenticated|validateRequest|getAuth|clerkClient|useUser)$/i;

/** Property reads that only exist once something has populated them. */
const AUTH_MEMBERS =
  /(?:^|\.)(?:user|session|auth|currentUser|userId|principal|identity)$/i;

const UNAUTHORIZED = /\b(401|403)\b|Unauthorized|Forbidden/;

interface RouteVerdict {
  route: Route;
  /** A check was visible inside the handler. */
  guarded: boolean;
  /** A middleware pattern covers this path. */
  covered: boolean;
}

export interface AuthReport {
  verdicts: RouteVerdict[];
  /** Mutating, resolved routes with no visible check and no middleware cover. */
  open: RouteVerdict[];
  /** A middleware file exists whose coverage we could not fully determine. */
  opaqueMiddleware: boolean;
  /** Routes whose handler could not be resolved, so nothing could be checked. */
  unresolved: number;
}

export function analyzeAuth(ctx: AnalysisContext): AuthReport {
  const { patterns, opaque } = middlewareCoverage(ctx);

  const verdicts: RouteVerdict[] = [];
  for (const route of ctx.routes.routes) {
    if (!route.resolved || !route.handler) continue;
    if (!isMutating(route, ctx)) continue;

    verdicts.push({
      route,
      guarded: handlerChecksCaller(route, ctx),
      covered: patterns.some((p) => p.test(route.path)),
    });
  }

  return {
    verdicts,
    open: verdicts.filter((v) => !v.guarded && !v.covered),
    opaqueMiddleware: opaque,
    /*
     * Unresolved routes are counted as candidates whatever their verb: we
     * could not read the handler, so we cannot claim to know it is read-only
     * either. Invariant 5 — report what could not be determined.
     */
    unresolved: ctx.routes.unresolved().length,
  };
}

function isMutating(route: Route, ctx: AnalysisContext): boolean {
  if (MUTATING.has(route.method)) return true;
  if (route.method !== "ALL" || !route.handler) return false;

  const content = ctx.files.get(route.file)?.content;
  if (!content) return false;
  return HANDLES_MUTATION.test(
    content.slice(route.handler.start, route.handler.end),
  );
}

/**
 * Does anything in this handler establish who is calling?
 *
 * The handler subtree is walked rather than the file, so a guard used by a
 * neighbouring function does not launder this one.
 */
function handlerChecksCaller(route: Route, ctx: AnalysisContext): boolean {
  if (!route.handler) return false;

  for (const call of collect(route.handler, "CallExpression")) {
    const path = memberPath(call["callee"] as AstNode | undefined);
    if (path && AUTH_CALLS.test(path)) return true;
  }

  for (const member of collect(route.handler, "MemberExpression")) {
    const path = memberPath(member);
    if (path && AUTH_MEMBERS.test(path)) return true;
  }

  /*
   * A handler that can answer 401 or 403 has decided something about the
   * caller, even if it did so through a helper this file does not recognise.
   *
   * Read from `FileIndex` rather than the AST: `ParsedFile` carries no source
   * text, and oxc's offsets index the same string the file was parsed from.
   */
  const content = ctx.files.get(route.file)?.content;
  if (!content) return false;
  return UNAUTHORIZED.test(content.slice(route.handler.start, route.handler.end));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

interface Coverage {
  patterns: RegExp[];
  /** True when a middleware file exists that we could not fully read. */
  opaque: boolean;
}

/**
 * Path patterns that a middleware demonstrably covers.
 *
 * Only static forms are read. A matcher built at runtime, or a guard applied
 * by a wrapper we cannot follow, sets `opaque` instead — which downgrades the
 * finding rather than removing it.
 */
function middlewareCoverage(ctx: AnalysisContext): Coverage {
  const patterns: RegExp[] = [];
  let opaque = false;

  for (const file of ctx.files.codeFiles()) {
    const parsed = ctx.asts.get(file.relPath);
    if (!parsed) continue;

    const isNextMiddleware = /(^|\/)(src\/)?middleware\.[cm]?[jt]sx?$/.test(
      file.relPath,
    );

    if (isNextMiddleware) {
      const matchers = nextMatchers(parsed);
      if (matchers.length === 0) {
        /*
         * A middleware file with no `config.matcher` runs on every request in
         * Next — but whether it actually authenticates, and for which paths,
         * is inside a function we are not going to interpret. Treat it as
         * covering nothing and flag the uncertainty.
         */
        opaque = true;
      } else {
        for (const matcher of matchers) patterns.push(matcherToRegExp(matcher));
      }
    }

    for (const mount of expressMounts(parsed)) {
      patterns.push(matcherToRegExp(`${mount}/:path*`));
    }
  }

  return { patterns, opaque };
}

/** `export const config = { matcher: [...] }` or `matcher: "..."`. */
function nextMatchers(parsed: ParsedFile): string[] {
  const out: string[] = [];

  for (const property of collect(parsed.program, "Property")) {
    const key = property["key"] as AstNode | undefined;
    const name =
      key?.type === "Identifier"
        ? String(key["name"])
        : key?.type === "Literal"
          ? String(key["value"])
          : "";
    if (name !== "matcher") continue;

    const value = property["value"] as AstNode | undefined;
    if (!value) continue;

    if (value.type === "Literal" && typeof value["value"] === "string") {
      out.push(value["value"]);
      continue;
    }
    if (value.type === "ArrayExpression") {
      for (const element of (value["elements"] as AstNode[]) ?? []) {
        if (element?.type === "Literal" && typeof element["value"] === "string") {
          out.push(element["value"]);
        }
      }
    }
  }

  return out;
}

/**
 * `app.use('/api', requireAuth)` — a mount with a path and a handler.
 *
 * A bare `app.use(express.json())` has no path and mounts no guard, so it is
 * skipped: treating it as blanket cover would silence the whole check on any
 * Express app that parses JSON.
 */
function expressMounts(parsed: ParsedFile): string[] {
  const out: string[] = [];

  for (const call of collect(parsed.program, "CallExpression")) {
    const callee = call["callee"] as AstNode | undefined;
    if (callee?.type !== "MemberExpression") continue;
    const property = callee["property"] as AstNode | undefined;
    if (property?.type !== "Identifier" || property["name"] !== "use") continue;

    const args = (call["arguments"] as AstNode[]) ?? [];
    const first = args[0];
    if (!first || first.type !== "Literal") continue;
    const path = first["value"];
    if (typeof path !== "string" || !path.startsWith("/")) continue;

    // The mounted value has to look like a guard, not a body parser.
    const guards = args.slice(1).some((arg) => {
      const name = memberPath(arg) ?? "";
      return AUTH_CALLS.test(name);
    });
    if (guards) out.push(path.replace(/\/$/, ""));
  }

  return out;
}

/** Next matcher syntax → a regular expression over normalized route paths. */
function matcherToRegExp(matcher: string): RegExp {
  const body = matcher
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // `:path*` and `:path+` are "this prefix and everything under it".
    .replace(/\/:[A-Za-z0-9_]+[*+]/g, "(?:/.*)?")
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

// ---------------------------------------------------------------------------

export function authCoverageSignal(ctx: AnalysisContext): Signal {
  const id = "unauthenticated-routes";

  if (ctx.asts.parsedCount === 0) {
    return unavailable(
      id,
      WEIGHT,
      "route checks read JavaScript and TypeScript frameworks, and this project has none",
    );
  }

  const report = analyzeAuth(ctx);

  if (report.verdicts.length === 0) {
    return unavailable(
      id,
      WEIGHT,
      ctx.routes.count === 0
        ? "no HTTP routes were found in this project"
        : "no routes that change state were found to judge",
    );
  }

  const ratio = report.open.length / report.verdicts.length;

  const evidence: string[] = [];
  if (report.open.length > 0) {
    evidence.push(
      `${report.open.length} of ${report.verdicts.length} state-changing routes have no visible check on the caller`,
    );
    for (const v of report.open.slice(0, 4)) {
      evidence.push(`${v.route.method} ${v.route.path} — ${v.route.file}`);
    }
  }
  if (report.opaqueMiddleware) {
    evidence.push(
      "a middleware file is present that we could not follow — some of these may already be protected",
    );
  }
  if (report.unresolved > 0) {
    evidence.push(
      `${countOf(report.unresolved, "state-changing route")} had handlers we could not resolve and were not judged`,
    );
  }

  const perFile: Record<string, number> = {};
  for (const v of report.open) perFile[v.route.file] = 1;

  return {
    id,
    /*
     * The one genuine proportion in this dimension. "Half the mutating routes
     * are open" is a meaningfully different statement from "one is", unlike a
     * committed credential where one is the whole story.
     *
     * Halved when a middleware we could not read is present: the evidence is
     * the same, our confidence in what it means is not.
     */
    value: clamp01(report.opaqueMiddleware ? ratio / 2 : ratio),
    weight: WEIGHT,
    available: true,
    evidence,
    perFile,
  };
}

export function authCoverageFindings(ctx: AnalysisContext): Finding[] {
  if (ctx.asts.parsedCount === 0) return [];
  const report = analyzeAuth(ctx);
  if (report.open.length === 0) return [];

  return [
    {
      ruleId: "unauthenticated-route",
      dimension: "security",
      /*
       * Downgraded, not suppressed, when a middleware we cannot follow exists.
       * Suppressing would silence this on most Next applications; claiming
       * `medium` anyway would assert something we did not establish.
       */
      severity: report.opaqueMiddleware ? "low" : "medium",
      confidence: report.opaqueMiddleware ? "low" : "medium",
      source: "builtin",
      title: `${report.open.length} state-changing ${
        report.open.length === 1 ? "route does" : "routes do"
      } not check who is calling`,
      locations: report.open.slice(0, 8).map((v) => ({
        file: v.route.file,
        line: v.route.line,
      })),
      data: {
        open: report.open.length,
        judged: report.verdicts.length,
        routes: report.open.map((v) => `${v.route.method} ${v.route.path}`),
        middlewarePresent: report.opaqueMiddleware,
        unresolved: report.unresolved,
      },
      estimatedFixMinutes: 20 * Math.min(report.open.length, 8),
    },
  ];
}
