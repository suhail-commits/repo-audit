import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "../testing/fixture-repo";
import { AstIndex } from "./ast";
import { FileIndex } from "./files";
import { RouteTable, nextAppPath, nextPagesPath } from "./routes";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function tableFor(files: Record<string, string>): Promise<RouteTable> {
  repo = createFixtureRepo({ files, withoutGit: true });
  const fileIndex = await FileIndex.build(repo.rootPath);
  return RouteTable.build(fileIndex, AstIndex.build(fileIndex));
}

describe("nextAppPath", () => {
  it("maps App Router files to URL paths", () => {
    expect(nextAppPath("app/api/orders/route.ts")).toBe("/api/orders");
    expect(nextAppPath("src/app/api/orders/[id]/route.ts")).toBe("/api/orders/:id");
    // Route groups are organisational and never appear in the URL.
    expect(nextAppPath("app/(marketing)/api/ping/route.ts")).toBe("/api/ping");
    expect(nextAppPath("app/api/files/[...path]/route.ts")).toBe("/api/files/*");
    expect(nextAppPath("app/api/opt/[[...slug]]/route.ts")).toBe("/api/opt/*");
    expect(nextAppPath("app/route.ts")).toBe("/");
    // The app directory need not be at the scan root — see the monorepo block.
    expect(nextAppPath("apps/web/src/app/api/scans/route.ts")).toBe("/api/scans");
    expect(nextAppPath("packages/api/app/health/route.ts")).toBe("/health");
  });
});

describe("nextPagesPath", () => {
  it("maps Pages API files to URL paths", () => {
    expect(nextPagesPath("pages/api/users.ts")).toBe("/api/users");
    expect(nextPagesPath("src/pages/api/users/[id].ts")).toBe("/api/users/:id");
    expect(nextPagesPath("pages/api/index.ts")).toBe("/api");
    expect(nextPagesPath("apps/legacy/src/pages/api/users.ts")).toBe("/api/users");
  });
});

describe("RouteTable — Next.js App Router", () => {
  it("finds one route per exported HTTP verb", async () => {
    const table = await tableFor({
      "app/api/orders/route.ts": `
export async function GET(req: Request) { return Response.json([]) }
export async function POST(req: Request) { return Response.json({}) }
export const revalidate = 60;
`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/orders",
      "POST /api/orders",
    ]);
    expect(table.routes.every((r) => r.resolved)).toBe(true);
    expect(table.routes[0]!.handler).not.toBeNull();
  });

  it("finds verbs exported as arrow function consts", async () => {
    const table = await tableFor({
      "app/api/ping/route.ts": `export const GET = async () => Response.json({ ok: true });\n`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/ping",
    ]);
    expect(table.routes[0]!.resolved).toBe(true);
  });

  it("ignores non-verb exports", async () => {
    const table = await tableFor({
      "app/api/x/route.ts": `
export const dynamic = 'force-dynamic';
export function helper() { return 1 }
`,
    });
    expect(table.count).toBe(0);
  });
});

describe("RouteTable — Next.js Pages API", () => {
  it("treats the default export as serving all verbs", async () => {
    const table = await tableFor({
      "pages/api/users/[id].ts": `
export default function handler(req, res) { res.json({}) }
`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "ALL /api/users/:id",
    ]);
    expect(table.routes[0]!.framework).toBe("next-pages");
  });
});

/*
 * Seen on `suhail-commits/repo-audit` — this repository's own scan reported
 * zero HTTP routes while `apps/web/src/app/api/scans/route.ts` sat in the
 * index. Both Next patterns were anchored to the scan root, so no monorepo
 * ever matched: the app lives one or more directories down.
 */
describe("RouteTable — Next.js inside a monorepo", () => {
  it("finds App Router routes below the scan root", async () => {
    const table = await tableFor({
      "apps/web/src/app/api/scans/route.ts": `
export async function POST(request: Request) { return Response.json({}) }
`,
      "packages/api/app/health/route.ts": `
export function GET() { return new Response('ok') }
`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /health",
      "POST /api/scans",
    ]);
  });

  it("finds Pages API routes below the scan root", async () => {
    const table = await tableFor({
      "apps/legacy/src/pages/api/users/[id].ts": `
export default function handler(req, res) { res.json({}) }
`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "ALL /api/users/:id",
    ]);
  });

  it("does not treat a directory merely ending in 'app' as an app root", async () => {
    const table = await tableFor({
      // `my-app/` is a plain folder. Matching it would invent routes in any
      // repository that happens to name a directory this way.
      "src/my-app/route.ts": `
export function GET() { return new Response('ok') }
`,
    });

    expect(table.routes).toEqual([]);
  });
});

describe("RouteTable — Express style", () => {
  it("finds inline handlers", async () => {
    const table = await tableFor({
      "server/index.js": `
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.post('/orders', async (req, res) => { res.json({}) });
`,
    });

    expect(table.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /health",
      "POST /orders",
    ]);
    expect(table.routes.every((r) => r.framework === "express")).toBe(true);
  });

  it("records by-reference handlers as unresolved rather than dropping them", async () => {
    const table = await tableFor({
      "server/routes.js": `
const router = require('express').Router();
router.get('/users/:id', requireAuth, getUser);
`,
    });

    expect(table.count).toBe(1);
    expect(table.routes[0]!.resolved).toBe(false);
    expect(table.unresolved()).toHaveLength(1);
    expect(table.warnings.join(" ")).toMatch(/could not be resolved/);
  });

  it("does not mistake ordinary .get() calls for routes", async () => {
    const table = await tableFor({
      "src/util.ts": `
const cache = new Map();
const v = cache.get('key');
const r = await client.get('https://example.com/api');
const h = headers.get('authorization');
export { v, r, h };
`,
    });
    expect(table.count).toBe(0);
  });

  it("skips middleware mounts", async () => {
    const table = await tableFor({
      "server/app.js": `
const app = require('express')();
app.use('/api', someMiddleware);
app.get('/api/thing', (req, res) => res.end());
`,
    });
    expect(table.routes.map((r) => r.path)).toEqual(["/api/thing"]);
  });

  it("detects hono from its import specifier", async () => {
    const table = await tableFor({
      "src/api.ts": `
import { Hono } from 'hono';
const app = new Hono();
app.get('/items', (c) => c.json([]));
export default app;
`,
    });
    expect(table.routes[0]!.framework).toBe("hono");
  });
});

describe("RouteTable — hygiene", () => {
  it("ignores routes declared inside test files", async () => {
    const table = await tableFor({
      "src/api.test.ts": `
const app = require('express')();
app.get('/from-a-test', (req, res) => res.end());
`,
    });
    expect(table.count).toBe(0);
  });
});
