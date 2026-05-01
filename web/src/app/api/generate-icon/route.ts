import OpenAI from "openai";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "No OPENAI_API_KEY configured on the server." },
      { status: 500 },
    );
  }

  const { name, description } = (await req.json()) as {
    name?: string;
    description?: string;
  };

  const subject = name || "app";
  const extra = description ? ` The module does: ${description}.` : "";

  const client = new OpenAI({ apiKey });

  const prompt =
    `A minimal, flat-design app icon for a software module called "${subject}".${extra} ` +
    `Clean vector style, simple geometric shapes, white or light background, no text, no words, no letters. ` +
    `Suitable as a small 128x128 app icon. Modern, minimal, monochrome with a single accent colour.`;

  try {
    const response = await client.images.generate({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
      quality: "standard",
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      return Response.json({ error: "No image returned." }, { status: 502 });
    }

    return Response.json({ image: b64 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 502 });
  }
}
