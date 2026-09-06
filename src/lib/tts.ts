/**
 * Turning article text into audio.
 *
 * Only OpenAI is wired up server-side. Adding another hosted provider means
 * writing one more `synthesize`-shaped function and picking it in `speak`.
 * When no provider key is configured the API route says so and the browser
 * falls back to its built-in speech synthesis.
 */

export class SpeechError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "SpeechError";
    this.status = status;
  }
}

/** Hosted providers cap a single request; long articles must be split. */
const CHUNK_LIMIT = 3800;

/** A ceiling on one job, so a runaway paste cannot run up a large bill. */
export const MAX_INPUT_CHARS = 40_000;

export const VOICES = [
  "alloy",
  "echo",
  "fable",
  "nova",
  "onyx",
  "shimmer",
] as const;

export type Voice = (typeof VOICES)[number];

export function isVoice(value: unknown): value is Voice {
  return typeof value === "string" && (VOICES as readonly string[]).includes(value);
}

/**
 * Strip the parts of a post that are noise when read aloud: bare links,
 * decorative repetition, and stray whitespace from the source formatting.
 */
export function normalizeForSpeech(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Split on sentence boundaries where possible, falling back to a hard cut only
 * for a single run of text longer than the limit.
 */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const pieces = text.split(/(?<=[.!?])\s+|\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const piece of pieces) {
    if (piece.length > limit) {
      push();
      for (let i = 0; i < piece.length; i += limit) {
        chunks.push(piece.slice(i, i + limit));
      }
      continue;
    }
    if (current.length + piece.length + 1 > limit) push();
    current = current ? `${current} ${piece}` : piece;
  }
  push();

  return chunks;
}

export function speechProviderConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function synthesizeWithOpenAI(input: string, voice: Voice): Promise<ArrayBuffer> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice,
      input,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SpeechError(
      `Speech provider responded ${response.status}. ${detail.slice(0, 300)}`,
      response.status === 401 ? 500 : 502,
    );
  }

  return response.arrayBuffer();
}

/**
 * Synthesize a whole article. Chunks are concatenated as MP3 frames, which
 * browsers play back as one continuous file.
 */
export async function speak(text: string, voice: Voice): Promise<Uint8Array> {
  if (!speechProviderConfigured()) {
    throw new SpeechError("No server-side speech provider is configured.", 501);
  }

  const normalized = normalizeForSpeech(text);
  if (!normalized) {
    throw new SpeechError("There is no text to read.", 400);
  }
  if (normalized.length > MAX_INPUT_CHARS) {
    throw new SpeechError(
      `That is ${normalized.length} characters, above the ${MAX_INPUT_CHARS} limit for one job.`,
      413,
    );
  }

  const chunks = chunkText(normalized);
  const buffers: Uint8Array[] = [];
  for (const chunk of chunks) {
    buffers.push(new Uint8Array(await synthesizeWithOpenAI(chunk, voice)));
  }

  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    output.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return output;
}
