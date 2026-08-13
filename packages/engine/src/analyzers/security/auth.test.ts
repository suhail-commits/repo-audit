import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { analyzeAuth, authCoverageFindings, authCoverageSignal } from "./auth";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function authOf(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  const ctx = await buildContext(repo.rootPath);
  return {
    report: analyzeAuth(ctx),
    signal: authCoverageSignal(ctx),
    findings: authCoverageFindings(ctx),
    routes: ctx.routes,
  };
}

const OPEN_DELETE = `export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  await db.users.delete(id);
  return Response.json({ ok: true });
}
`;

const GUARDED_POST = `import { getServerSession } from "next-auth";
export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) return new Response("no", { status: 401 });
  return Response.json({ ok: true });
}
`;

describe("route auth coverage", () => {
  it("flags a mutating route with no visible check", async () => {
    const { report, signal, findings } = await authOf({
      "app/api/users/route.ts": OPEN_DELETE,
    });

    expect(report.open).toHaveLength(1);
    expect(signal.value).toBe(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.data.routes).toEqual(["DELETE /api/users"]);
  });

  it("stays silent when the handler checks the session", async () => {
    const { report, signal, findings } = await authOf({
      "app/api/orders/route.ts": GUARDED_POST,
    });

    expect(report.open).toHaveLength(0);
    expect(signal.value).toBe(0);
    expect(findings).toHaveLength(0);
  });

  /**
   * The decision that keeps this from flagging every public API on the
   * internet — including this project's own `/api/scans`, which is open by
   * design.
   */
  it("ignores read-only routes entirely", async () => {
    const { report, signal } = await authOf({
      "app/api/health/route.ts":
        "export async function GET() {\n  return Response.json({ ok: true });\n}\n",
    });

    expect(report.verdicts).toHaveLength(0);
    // Nothing mutating to judge is not the same as nothing wrong.
    expect(signal.available).toBe(false);
  });

  it("subtracts routes a middleware matcher covers", async () => {
    const { report, signal } = await authOf({
      "app/api/admin/route.ts": OPEN_DELETE,
      "middleware.ts":
        "export function middleware() {\n  return null;\n}\n" +
        "export const config = { matcher: ['/api/admin/:path*'] };\n",
    });

    expect(report.open).toHaveLength(0);
    expect(signal.value).toBe(0);
  });

  it("still flags a route the matcher does not reach", async () => {
    const { report } = await authOf({
      "app/api/admin/route.ts": OPEN_DELETE,
      "app/api/exports/route.ts": OPEN_DELETE,
      "middleware.ts":
        "export function middleware() {\n  return null;\n}\n" +
        "export const config = { matcher: ['/api/admin/:path*'] };\n",
    });

    expect(report.open.map((v) => v.route.path)).toEqual(["/api/exports"]);
  });

  /**
   * Never `unavailable`. A middleware file we cannot follow is present in most
   * real Next applications, and going quiet there would silence the flagship
   * check on the most common thing anyone will paste in.
   */
  it("downgrades rather than silences when middleware cannot be followed", async () => {
    const { report, signal, findings } = await authOf({
      "app/api/users/route.ts": OPEN_DELETE,
      "middleware.ts":
        "export function middleware(req: Request) {\n  return check(req);\n}\n",
    });

    expect(report.opaqueMiddleware).toBe(true);
    expect(report.open).toHaveLength(1);
    expect(signal.available).toBe(true);
    // Halved, because the evidence is unchanged but what it means is not.
    expect(signal.value).toBe(0.5);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.confidence).toBe("low");
  });

  it("accepts an Express guard mounted above the route", async () => {
    const { report } = await authOf({
      "src/server.ts":
        "import express from 'express';\n" +
        "const app = express();\n" +
        "app.use('/api', requireAuth);\n" +
        "app.post('/api/things', (req, res) => res.json({ ok: true }));\n",
    });

    expect(report.open).toHaveLength(0);
  });

  it("does not treat a body parser as a guard", async () => {
    const { report } = await authOf({
      "src/server.ts":
        "import express from 'express';\n" +
        "const app = express();\n" +
        "app.use('/api', express.json());\n" +
        "app.post('/api/things', (req, res) => res.json({ ok: true }));\n",
    });

    expect(report.open).toHaveLength(1);
  });

  /**
   * The only security finding the twenty-repo sweep produced, and it was a
   * false positive of ours: `colinhacks/zod`'s
   * `packages/docs/pages/api/_og.tsx` renders an Open Graph image. Next's
   * Pages API has no per-verb export so `RouteTable` records it as `ALL`,
   * which made every legacy Pages route read as state-changing.
   */
  it("does not treat a read-only pages/api handler as state-changing", async () => {
    const { report, signal } = await authOf({
      "pages/api/og.tsx":
        "export default function handler(req: any, res: any) {\n" +
        "  const title = req.query.title;\n" +
        "  return res.send(render(title));\n" +
        "}\n",
    });

    expect(report.verdicts).toHaveLength(0);
    expect(signal.available).toBe(false);
  });

  it("still judges a pages/api handler that branches on a mutating verb", async () => {
    const { report } = await authOf({
      "pages/api/items.ts":
        "export default function handler(req: any, res: any) {\n" +
        "  if (req.method === 'DELETE') return remove(req.query.id);\n" +
        "  return res.json([]);\n" +
        "}\n",
    });

    expect(report.open).toHaveLength(1);
  });

  it("counts a 401 path as a check even without a known helper", async () => {
    const { report } = await authOf({
      "app/api/things/route.ts":
        "export async function POST(request: Request) {\n" +
        "  if (!isAllowed(request)) return new Response('nope', { status: 403 });\n" +
        "  return Response.json({ ok: true });\n" +
        "}\n",
    });

    expect(report.open).toHaveLength(0);
  });
});
