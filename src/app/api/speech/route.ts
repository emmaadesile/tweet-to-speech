import { NextResponse } from "next/server";
import { isVoice, speak, speechProviderConfigured, SpeechError, VOICES } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The client asks first, so it knows whether to offer browser playback instead. */
export async function GET() {
  return NextResponse.json({
    configured: speechProviderConfigured(),
    voices: VOICES,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { text, voice } = (body ?? {}) as { text?: unknown; voice?: unknown };
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Provide the text to read." }, { status: 400 });
  }

  const selectedVoice = isVoice(voice) ? voice : "nova";

  try {
    const audio = await speak(text, selectedVoice);
    return new NextResponse(audio as unknown as BodyInit, {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(audio.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof SpeechError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected error generating audio." }, { status: 500 });
  }
}
