# tweet-to-speech

Turn X posts to audio so you can listen.

Paste the link to a long X post, and the app fetches the text and reads it back
as audio. There is no bot and no account to connect: one page, one request, one
audio file.

## Running it

```bash
npm install
cp .env.example .env.local   # optional, see below
npm run dev
```

The app works with no configuration at all. Without keys it reads posts through
public endpoints and plays them with the browser's built-in voice.

## Configuration

Everything in `.env.example` is optional, but each key improves one half of the
pipeline.

| Variable | Effect when set |
| --- | --- |
| `OPENAI_API_KEY` | Uses a hosted voice and returns a downloadable MP3 instead of browser speech. |
| `OPENAI_TTS_MODEL` | Overrides the default `gpt-4o-mini-tts`. |
| `X_BEARER_TOKEN` | Reads posts through the official X API instead of the public endpoints. |

## How a post is read

`src/lib/x.ts` tries three sources in order and uses the first that returns text.

1. **Official X API**, only when `X_BEARER_TOKEN` is set. The only route covered
   by X's terms of service. Reading posts needs a paid tier.
2. **The syndication endpoint** that powers embedded posts. No key, undocumented.
3. **fxtwitter**, a third-party JSON mirror. No key, undocumented.

The last two exist so the app is usable before you pay for API access. They are
not covered by X's terms and can break without notice. Treat them as a
development shortcut, not a foundation to build a product on.

If every source fails, the post may be private, deleted, or an X Article whose
body the public endpoints do not expose. The "Paste text" tab is the fallback
for those cases and always works.

## How audio is produced

`src/lib/tts.ts` strips links and stray whitespace, splits the text at sentence
boundaries into chunks under the provider's per-request limit, synthesizes each
chunk, and concatenates the MP3 frames into one file. A single job is capped at
40,000 characters so a large paste cannot run up an unexpected bill.

Adding another hosted provider means writing one more `synthesize`-shaped
function and selecting it in `speak`.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/x.ts` | Post ID extraction and the three fetch sources. |
| `src/lib/tts.ts` | Text normalization, chunking, synthesis. |
| `src/app/api/article/route.ts` | Accepts a URL, returns the post text. |
| `src/app/api/speech/route.ts` | Accepts text, returns MP3 bytes. |
| `src/app/page.tsx` | The single-page interface. |

The conversion logic lives in `src/lib` rather than in the routes, so a second
trigger such as an X bot could call the same functions without the UI.
