import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

// Proxies GitHub artifact downloads to avoid CORS issues.
// GitHub's artifact ZIP endpoint redirects to a signed CDN URL that
// doesn't include CORS headers, so browser-side fetch fails on the
// redirect. This server-side proxy follows the redirect and streams
// the ZIP back to the client.

export async function POST(req: NextRequest) {
  const { repo, artifactId, token } = (await req.json()) as {
    repo: string;
    artifactId: number;
    token: string;
  };

  if (!repo || !artifactId || !token) {
    return Response.json({ error: "Missing repo, artifactId, or token" }, { status: 400 });
  }

  const url = `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return Response.json(
      { error: `GitHub returned ${res.status}: ${text.slice(0, 500)}` },
      { status: res.status },
    );
  }

  const arrayBuffer = await res.arrayBuffer();

  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(arrayBuffer.byteLength),
    },
  });
}
