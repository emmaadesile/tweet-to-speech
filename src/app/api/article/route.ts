import { NextResponse } from "next/server";
import { extractPostId, fetchPost, PostFetchError } from "@/lib/x";
import { normalizeForSpeech } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const url = (body as { url?: unknown })?.url;
  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "Provide the URL of an X post." }, { status: 400 });
  }

  const id = extractPostId(url);
  if (!id) {
    return NextResponse.json(
      { error: "That does not look like an X post URL. Expected something like https://x.com/user/status/123." },
      { status: 400 },
    );
  }

  try {
    const post = await fetchPost(id);
    const text = normalizeForSpeech(post.text);
    return NextResponse.json({
      ...post,
      text,
      characters: text.length,
      // ~150 words per minute at a natural reading pace, ~5.5 characters per word.
      estimatedSeconds: Math.round((text.length / 5.5 / 150) * 60),
    });
  } catch (error) {
    if (error instanceof PostFetchError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ error: "Unexpected error reading that post." }, { status: 500 });
  }
}
