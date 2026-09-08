"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Article {
  text: string;
  title?: string;
  authorName?: string;
  authorHandle?: string;
  source: string;
  characters: number;
  estimatedSeconds: number;
}

type Mode = "url" | "paste";

const SOURCE_LABELS: Record<string, string> = {
  "official-api": "X API",
  syndication: "syndication endpoint",
  fxtwitter: "fxtwitter",
  manual: "pasted text",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [article, setArticle] = useState<Article | null>(null);
  const [voice, setVoice] = useState("nova");
  const [voices, setVoices] = useState<string[]>([]);
  const [serverSpeech, setServerSpeech] = useState<boolean | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"fetch" | "speak" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserSpeaking, setBrowserSpeaking] = useState(false);

  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  // Ask once whether a hosted voice is available, so the button can say what it will do.
  useEffect(() => {
    fetch("/api/speech")
      .then((response) => response.json())
      .then((body) => {
        setServerSpeech(Boolean(body?.configured));
        if (Array.isArray(body?.voices)) setVoices(body.voices);
      })
      .catch(() => setServerSpeech(false));
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  const resetAudio = useCallback(() => {
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setBrowserSpeaking(false);
  }, []);

  const handleFetch = useCallback(async () => {
    setError(null);
    resetAudio();
    setArticle(null);
    setBusy("fetch");
    try {
      const response = await fetch("/api/article", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        setError(await readError(response, "Could not read that post."));
        return;
      }
      setArticle(await response.json());
    } catch {
      setError("Network error while reading that post.");
    } finally {
      setBusy(null);
    }
  }, [url, resetAudio]);

  const usePastedText = useCallback(() => {
    const text = pasted.trim();
    if (!text) return;
    setError(null);
    resetAudio();
    setArticle({
      text,
      source: "manual",
      characters: text.length,
      estimatedSeconds: Math.round((text.length / 5.5 / 150) * 60),
    });
  }, [pasted, resetAudio]);

  const speakInBrowser = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      setError("This browser has no built-in speech synthesis.");
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.onend = () => setBrowserSpeaking(false);
    utterance.onerror = () => setBrowserSpeaking(false);
    setBrowserSpeaking(true);
    synth.speak(utterance);
  }, []);

  const handleSpeak = useCallback(async () => {
    if (!article) return;
    setError(null);

    if (serverSpeech === false) {
      speakInBrowser(article.text);
      return;
    }

    setBusy("speak");
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: article.text, voice }),
      });

      if (response.status === 501) {
        setServerSpeech(false);
        speakInBrowser(article.text);
        return;
      }
      if (!response.ok) {
        setError(await readError(response, "Could not generate audio."));
        return;
      }

      const blob = await response.blob();
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
    } catch {
      setError("Network error while generating audio.");
    } finally {
      setBusy(null);
    }
  }, [article, serverSpeech, voice, speakInBrowser]);

  const stopBrowserSpeech = useCallback(() => {
    window.speechSynthesis?.cancel();
    setBrowserSpeaking(false);
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-5 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Tweet to Speech</h1>
        <p className="text-muted text-[15px] leading-relaxed">
          Paste a link to a long X post and listen to it instead of reading it.
        </p>
      </header>

      <section className="border-border bg-surface flex flex-col gap-4 rounded-xl border p-5">
        <div className="flex gap-1 text-sm" role="tablist">
          {(["url", "paste"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => {
                setMode(value);
                setError(null);
              }}
              className={`rounded-lg px-3 py-1.5 transition-colors ${
                mode === value
                  ? "bg-accent text-accent-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {value === "url" ? "Post link" : "Paste text"}
            </button>
          ))}
        </div>

        {mode === "url" ? (
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void handleFetch();
            }}
          >
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://x.com/username/status/1234567890"
              aria-label="X post URL"
              className="border-border focus:border-accent flex-1 rounded-lg border bg-transparent px-3 py-2.5 text-[15px] outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={!url.trim() || busy !== null}
              className="bg-accent text-accent-foreground rounded-lg px-4 py-2.5 text-[15px] font-medium transition-opacity disabled:opacity-40"
            >
              {busy === "fetch" ? "Reading…" : "Read post"}
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={6}
              placeholder="Paste the text of the post here."
              aria-label="Post text"
              className="border-border focus:border-accent resize-y rounded-lg border bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none transition-colors"
            />
            <button
              type="button"
              onClick={usePastedText}
              disabled={!pasted.trim()}
              className="bg-accent text-accent-foreground self-start rounded-lg px-4 py-2.5 text-[15px] font-medium transition-opacity disabled:opacity-40"
            >
              Use this text
            </button>
          </div>
        )}
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-[15px] leading-relaxed text-red-500"
        >
          {error}
        </p>
      )}

      {article && (
        <section className="border-border bg-surface flex flex-col gap-5 rounded-xl border p-5">
          <div className="flex flex-col gap-1">
            {article.title && <h2 className="text-lg font-semibold">{article.title}</h2>}
            <p className="text-muted text-sm">
              {article.authorName
                ? `${article.authorName}${article.authorHandle ? ` @${article.authorHandle}` : ""}`
                : "Pasted text"}
            </p>
            <p className="text-muted text-sm">
              {article.characters.toLocaleString()} characters, about{" "}
              {formatDuration(article.estimatedSeconds)} to listen.
              {article.source !== "manual" &&
                ` Read via ${SOURCE_LABELS[article.source] ?? article.source}.`}
            </p>
          </div>

          <div className="border-border max-h-72 overflow-y-auto rounded-lg border p-4 text-[15px] leading-relaxed whitespace-pre-wrap">
            {article.text}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {serverSpeech && voices.length > 0 && (
              <label className="text-muted flex items-center gap-2 text-sm">
                Voice
                <select
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                  className="border-border text-foreground rounded-lg border bg-transparent px-2 py-1.5"
                >
                  {voices.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {browserSpeaking ? (
              <button
                type="button"
                onClick={stopBrowserSpeech}
                className="border-border rounded-lg border px-4 py-2.5 text-[15px] font-medium"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSpeak()}
                disabled={busy !== null}
                className="bg-accent text-accent-foreground rounded-lg px-4 py-2.5 text-[15px] font-medium transition-opacity disabled:opacity-40"
              >
                {busy === "speak" ? "Generating audio…" : "Listen"}
              </button>
            )}

            {serverSpeech === false && (
              <span className="text-muted text-sm">
                No speech provider key set, so playback uses your browser voice.
              </span>
            )}
          </div>

          {audioUrl && (
            <div className="flex flex-col gap-2">
              <audio controls autoPlay src={audioUrl} className="w-full" />
              <a
                href={audioUrl}
                download="x-post-audio.mp3"
                className="text-accent self-start text-sm underline underline-offset-4"
              >
                Download MP3
              </a>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
