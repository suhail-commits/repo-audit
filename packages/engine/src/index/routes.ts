import {
  collect,
  isFunctionNode,
  memberPath,
  type AstIndex,
  type AstNode,
  type ParsedFile,
} from "./ast";
import type { FileIndex } from "./files";

export type RouteFramework =
  | "next-app"
  | "next-pages"
  | "express"
  | "hono"
  | "fastify";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number] | "ALL";

export interface Route {
  method: HttpMethod;
  /** Normalized URL path, e.g. "/api/orders/:id". */
  path: string;
  file: string;
  line: number;
  framework: RouteFramework;
  /** The handler function body, for rules that inspect what it does. */
  handler: AstNode | null;
  /**
   * False when a route was detected but its handler could not be resolved — a
   * handler passed by reference, or a dynamically built path. These are counted
   * separately and surfaced as "unknown" rather than silently assumed safe.
   */
  resolved: boolean;
}

/**
 * Every HTTP entry point in the repo.
 *
 * Coverage matters more than precision here: a route this table misses is a route
 * the auth-coverage rule cannot check, which would under-report the flagship
 * finding. Anything detected but not fully understood is kept with
 * `resolved: false` so the report can disclose it.
 */
export class RouteTable {
  readonly routes: Route[] = [];
  readonly warnings: string[] = [];

  static build(files: FileIndex, asts: AstIndex): RouteTable {
    const table = new RouteTable();

    for (const parsed of asts.all()) {
      const file = files.get(parsed.relPath);
      if (!file || file.isTest) continue;

      if (isNextAppRoute(parsed.relPath)) {
        table.routes.push(...nextAppRoutes(parsed));
      } else if (isNextPagesApi(parsed.relPath)) {
        table.routes.push(...nextPagesRoutes(parsed));
      }
      // Express-style registrations can appear in any file, including alongside
      // a Next route, so this always runs.
      table.routes.push(...expressStyleRoutes(parsed));
    }

    table.routes.sort(
      (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );

    const unresolved = table.routes.filter((r) => !r.resolved).length;
    if (unresolved > 0) {
      table.warnings.push(
        `${unresolved} route(s) detected but their handlers could not be resolved`,
      );
    }
    return table;
  }

  get count(): number {
    return this.routes.length;
  }

  resolved(): Route[] {
    return this.routes.filter((r) => r.resolved);
  }

  unresolved(): Route[] {
    return this.routes.filter((r) => !r.resolved);
  }

  byFile(relPath: string): Route[] {
    return this.routes.filter((r) => r.file === relPath);
  }

  frameworks(): RouteFramework[] {
    return [...new Set(this.routes.map((r) => r.framework))];
  }
}

// ---------------------------------------------------------------------------
// Next.js App Router
// ---------------------------------------------------------------------------

/**
 * An App Router route handler, wherever the `app/` directory happens to live.
 *
 * **The `app/` root is not necessarily at the scan root.** In a monorepo the
 * Next application sits at `apps/web/src/app/`, and anchoring this pattern to
 * the repository root found zero routes in every such repo — including this
 * one, whose own `apps/web/src/app/api/scans/route.ts` went undetected. Same
 * anchoring mistake that once made monorepo entry points read as dead code.
 *
 * `(?:^|\/)` keeps the segment exact: `my-app/route.ts` does not match, because
 * the character before `app` must be a separator or the start of the path.
 * `node_modules` never reaches here — `guards.ts` excludes it from the index.
 *
 * Group 1 is the path *inside* the app directory, which is what maps to a URL.
 */
const NEXT_APP_ROUTE_RE =
  /(?:^|\/)(?:src\/)?app\/((?:.*\/)?route\.[cm]?[jt]sx?)$/;

function isNextAppRoute(relPath: string): boolean {
  return NEXT_APP_ROUTE_RE.test(relPath);
}

function nextAppRoutes(parsed: ParsedFile): Route[] {
  const routePath = nextAppPath(parsed.relPath);
  const out: Route[] = [];

  for (const node of parsed.program["body"] as AstNode[]) {
    for (const { name, fn } of exportedFunctions(node)) {
      if (!(HTTP_METHODS as readonly string[]).includes(name)) continue;
      out.push({
        method: name as HttpMethod,
        path: routePath,
        file: parsed.relPath,
        line: parsed.lineMap.lineAt(node.start),
        framework: "next-app",
        handler: fn,
        resolved: fn !== null,
      });
    }
  }
  return out;
}

/**
 * Map an App Router file path to its URL path.
 *
 * `(marketing)` groups and `@slot` parallel routes do not appear in the URL;
 * `[id]` becomes `:id` and `[...rest]` becomes a wildcard.
 */
export function nextAppPath(relPath: string): string {
  // Everything before the `app/` directory is repository layout, not URL.
  const inner = (NEXT_APP_ROUTE_RE.exec(relPath)?.[1] ?? relPath).replace(
    /\/?route\.[cm]?[jt]sx?$/,
    "",
  );

  const segments: string[] = [];
  for (const seg of inner.split("/")) {
    if (seg === "") continue;
    if (seg.startsWith("(") && seg.endsWith(")")) continue;
    if (seg.startsWith("@")) continue;
    if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      segments.push("*");
      continue;
    }
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      segments.push("*");
      continue;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      segments.push(`:${seg.slice(1, -1)}`);
      continue;
    }
    segments.push(seg);
  }
  return `/${segments.join("/")}`;
}

// ---------------------------------------------------------------------------
// Next.js Pages API
// ---------------------------------------------------------------------------

/** Same monorepo reasoning as `NEXT_APP_ROUTE_RE`. Group 1 starts at `api/`. */
const NEXT_PAGES_API_RE =
  /(?:^|\/)(?:src\/)?pages\/(api\/.+\.[cm]?[jt]sx?)$/;

function isNextPagesApi(relPath: string): boolean {
  return NEXT_PAGES_API_RE.test(relPath);
}

function nextPagesRoutes(parsed: ParsedFile): Route[] {
  const routePath = nextPagesPath(parsed.relPath);

  for (const node of parsed.program["body"] as AstNode[]) {
    if (node.type !== "ExportDefaultDeclaration") continue;
    const decl = node["declaration"] as AstNode | undefined;
    const fn = decl && isFunctionNode(decl) ? decl : null;
    return [
      {
        // A pages/api handler serves every verb; the handler switches internally.
        method: "ALL",
        path: routePath,
        file: parsed.relPath,
        line: parsed.lineMap.lineAt(node.start),
        framework: "next-pages",
        handler: fn,
        resolved: fn !== null,
      },
    ];
  }
  return [];
}

export function nextPagesPath(relPath: string): string {
  const inner = (NEXT_PAGES_API_RE.exec(relPath)?.[1] ?? relPath)
    .replace(/\.[cm]?[jt]sx?$/, "")
    .replace(/\/index$/, "");

  const segments: string[] = [];
  for (const seg of inner.split("/")) {
    if (seg === "") continue;
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      segments.push("*");
      continue;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      segments.push(`:${seg.slice(1, -1)}`);
      continue;
    }
    segments.push(seg);
  }
  return `/${segments.join("/")}`;
}

// ---------------------------------------------------------------------------
// Express / Hono / Fastify style registration
// ---------------------------------------------------------------------------

const VERB_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
  "use",
]);

/**
 * Match `x.get('/path', handler)` where the first argument is a string path.
 *
 * Requiring a literal path argument keeps this from firing on `fetch.get(...)`,
 * `cache.get(key)`, and similar — a real problem given how many non-router
 * objects expose a `get` method.
 */
function expressStyleRoutes(parsed: ParsedFile): Route[] {
  const out: Route[] = [];

  for (const call of collect(parsed.program, "CallExpression")) {
    const callee = call["callee"] as AstNode | undefined;
    if (!callee || callee.type !== "MemberExpression") continue;

    const property = callee["property"] as AstNode | undefined;
    if (!property || property.type !== "Identifier") continue;

    const verb = String(property["name"]).toLowerCase();
    if (!VERB_METHODS.has(verb)) continue;

    const args = (call["arguments"] as AstNode[]) ?? [];
    const first = args[0];
    if (!first || first.type !== "Literal") continue;

    const path = first["value"];
    if (typeof path !== "string" || !path.startsWith("/")) continue;

    // `.use('/x', mw)` mounts middleware rather than declaring an endpoint.
    if (verb === "use") continue;

    const objectName = memberPath(callee["object"] as AstNode | undefined) ?? "";
    const handlers = args.slice(1);
    const handler = handlers.findLast((a) => isFunctionNode(a)) ?? null;

    out.push({
      method: verb === "all" ? "ALL" : (verb.toUpperCase() as HttpMethod),
      path,
      file: parsed.relPath,
      line: parsed.lineMap.lineAt(call.start),
      framework: guessFramework(objectName, parsed),
      handler,
      // A handler passed by reference (`router.get('/x', getUser)`) is a real
      // route we cannot follow inline — record it, but do not claim to know it.
      resolved: handler !== null,
    });
  }

  return out;
}

function guessFramework(objectName: string, parsed: ParsedFile): RouteFramework {
  const specifiers = (parsed.module.staticImports ?? []).map(
    (i) => i.moduleRequest?.value ?? "",
  );
  if (specifiers.some((s) => s === "hono" || s.startsWith("hono/"))) return "hono";
  if (specifiers.some((s) => s === "fastify")) return "fastify";
  if (objectName.includes("fastify")) return "fastify";
  return "express";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Named exports that are functions, in either form:
 *   export async function GET() {}
 *   export const GET = async () => {}
 */
function exportedFunctions(
  node: AstNode,
): { name: string; fn: AstNode | null }[] {
  if (node.type !== "ExportNamedDeclaration") return [];
  const decl = node["declaration"] as AstNode | undefined;
  if (!decl) return [];

  if (decl.type === "FunctionDeclaration") {
    const id = decl["id"] as AstNode | undefined;
    if (!id) return [];
    return [{ name: String(id["name"]), fn: decl }];
  }

  if (decl.type === "VariableDeclaration") {
    const out: { name: string; fn: AstNode | null }[] = [];
    for (const d of (decl["declarations"] as AstNode[]) ?? []) {
      const id = d["id"] as AstNode | undefined;
      if (!id || id.type !== "Identifier") continue;
      const init = d["init"] as AstNode | undefined;
      out.push({
        name: String(id["name"]),
        fn: init && isFunctionNode(init) ? init : null,
      });
    }
    return out;
  }

  return [];
}
