// Streams the cached .lgx for a previously-built core module back to the
// client (the export flow uses this to bundle the artifact). Returns 404
// if the module hasn't been built (or the cache was cleared).

import type { NextRequest } from "next/server";
import { builtLgxFilename, readBuiltLgx } from "../../../lib/buildModule";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]*$/.test(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  const buf = await readBuiltLgx(id);
  if (!buf) {
    return Response.json(
      { error: `No built artifact for "${id}". Build it via the Modules tab first.` },
      { status: 404 }
    );
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${builtLgxFilename(id)}"`,
      "Cache-Control": "no-store",
    },
  });
}
