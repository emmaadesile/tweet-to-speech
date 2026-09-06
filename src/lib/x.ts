/**
 * Fetching the text of an X (Twitter) post.
 *
 * Three sources are tried in order. The official API is preferred because it is
 * the only one covered by X's terms of service; the other two need no key and
 * exist so the app is usable before you pay for API access. Both unofficial
 * routes are undocumented and may break without notice.
 */

export type PostSource = "official-api" | "syndication" | "fxtwitter";

export interface Post {
  id: string;
  text: string;
  title?: string;
  authorName?: string;
  authorHandle?: string;
  createdAt?: string;
  source: PostSource;
}

export class PostFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "PostFetchError";
    this.status = status;
  }
}

const HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixupx.com",
  "nitter.net",
]);

/**
 * Pull the numeric post ID out of anything a user is likely to paste: a full
 * status URL, a URL with tracking params or a /photo/1 suffix, or a bare ID.
 */
export function extractPostId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^\d{5,25}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  const match = url.pathname.match(/\/status(?:es)?\/(\d{1,25})/);
  return match ? match[1] : null;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

async function getJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new PostFetchError(`upstream responded ${response.status}`, response.status);
  }
  return response.json();
}

/**
 * The syndication endpoint requires a token derived from the post ID. This is
 * the algorithm the embed widget itself uses.
 */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

/**
 * X Articles carry their body in a Draft.js-style block structure rather than
 * in `text`. Walk it defensively, since the shape is undocumented.
 */
function textFromArticleBlocks(article: unknown): string | null {
  if (!article || typeof article !== "object") return null;
  const state = (article as Record<string, unknown>).content_state;
  if (!state || typeof state !== "object") return null;
  const blocks = (state as Record<string, unknown>).blocks;
  if (!Array.isArray(blocks)) return null;

  const lines = blocks
    .map((block) =>
      block && typeof block === "object"
        ? String((block as Record<string, unknown>).text ?? "")
        : "",
    )
    .filter((line) => line.trim().length > 0);

  return lines.length > 0 ? lines.join("\n\n") : null;
}

async function fromOfficialApi(id: string): Promise<Post | null> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return null;

  const url =
    `https://api.twitter.com/2/tweets/${id}` +
    "?tweet.fields=created_at,note_tweet,text" +
    "&expansions=author_id&user.fields=name,username";

  const json = await getJson(url, { authorization: `Bearer ${token}` });
  const data = json?.data;
  if (!data) return null;

  // note_tweet holds the untruncated body of a long post.
  const text: string = data.note_tweet?.text || data.text || "";
  if (!text.trim()) return null;

  const user = json?.includes?.users?.[0];
  return {
    id,
    text,
    authorName: user?.name,
    authorHandle: user?.username,
    createdAt: data.created_at,
    source: "official-api",
  };
}

async function fromSyndication(id: string): Promise<Post | null> {
  const url =
    "https://cdn.syndication.twimg.com/tweet-result" +
    `?id=${id}&token=${syndicationToken(id)}&lang=en`;

  const json = await getJson(url);
  const articleText = textFromArticleBlocks(json?.article);
  const text: string =
    articleText || json?.note_tweet?.text || json?.text || "";
  if (!text.trim()) return null;

  return {
    id,
    text,
    title: json?.article?.title || undefined,
    authorName: json?.user?.name,
    authorHandle: json?.user?.screen_name,
    createdAt: json?.created_at,
    source: "syndication",
  };
}

async function fromFxTwitter(id: string): Promise<Post | null> {
  const json = await getJson(`https://api.fxtwitter.com/status/${id}`);
  const tweet = json?.tweet;
  const text: string = tweet?.text || "";
  if (!text.trim()) return null;

  return {
    id,
    text,
    authorName: tweet?.author?.name,
    authorHandle: tweet?.author?.screen_name,
    createdAt: tweet?.created_at,
    source: "fxtwitter",
  };
}

export async function fetchPost(id: string): Promise<Post> {
  // Labelled explicitly rather than read from Function.name, which a production
  // build minifies into single letters.
  const sources: Array<[string, (id: string) => Promise<Post | null>]> = [
    // The official API is skipped entirely without a token, rather than
    // reported as a failure it was never able to attempt.
    ...(process.env.X_BEARER_TOKEN
      ? ([["X API", fromOfficialApi]] as Array<[string, (id: string) => Promise<Post | null>]>)
      : []),
    ["syndication", fromSyndication],
    ["fxtwitter", fromFxTwitter],
  ];
  const failures: string[] = [];

  for (const [label, source] of sources) {
    try {
      const post = await source(id);
      if (post) return post;
      failures.push(`${label}: no text in response`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
    }
  }

  throw new PostFetchError(
    `Could not read that post. Tried ${failures.length} sources (${failures.join("; ")}). ` +
      "It may be private, deleted, or an X Article the public endpoints do not expose. " +
      "You can paste the text directly instead.",
    502,
  );
}
