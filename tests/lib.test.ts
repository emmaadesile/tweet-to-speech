import assert from "node:assert/strict";
import test from "node:test";

import { extractPostId, fetchPost } from "@/lib/x";
import { chunkText, normalizeForSpeech } from "@/lib/tts";

test("extractPostId accepts the URL shapes people actually paste", () => {
  const cases: Array<[string, string | null]> = [
    ["https://x.com/user/status/1234567890123456789", "1234567890123456789"],
    ["https://twitter.com/user/status/1234567890123456789", "1234567890123456789"],
    ["https://mobile.twitter.com/user/status/1234567890123456789", "1234567890123456789"],
    ["https://x.com/user/status/1234567890123456789?s=20&t=abc", "1234567890123456789"],
    ["https://x.com/user/status/1234567890123456789/photo/1", "1234567890123456789"],
    ["  https://x.com/user/status/1234567890123456789  ", "1234567890123456789"],
    ["x.com/user/status/1234567890123456789", "1234567890123456789"],
    ["https://x.com/jack/status/20", "20"], // early posts have short IDs
    ["1234567890123456789", "1234567890123456789"],
    ["https://example.com/user/status/1234567890123456789", null],
    ["https://x.com/user", null],
    ["not a url", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(extractPostId(input), expected, `input: ${input}`);
  }
});

test("normalizeForSpeech drops links and collapses whitespace", () => {
  const result = normalizeForSpeech(
    "First line.   See https://t.co/abc123 for more.\n\n\n\n  Second line.  ",
  );
  assert.ok(!result.includes("http"), "links should be removed");
  assert.ok(!result.includes("\n\n\n"), "blank runs should collapse");
  assert.ok(result.startsWith("First line."));
  assert.ok(result.endsWith("Second line."));
});

test("chunkText keeps every chunk under the limit and loses no words", () => {
  const sentence = "This is a sentence about a long article. ";
  const text = sentence.repeat(400); // ~16k characters
  const chunks = chunkText(text, 1000);

  assert.ok(chunks.length > 1, "long text should split");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `chunk of ${chunk.length} exceeds limit`);
  }

  const wordsIn = text.trim().split(/\s+/).length;
  const wordsOut = chunks.join(" ").trim().split(/\s+/).length;
  assert.equal(wordsOut, wordsIn, "no words should be dropped");
});

test("chunkText splits a single run longer than the limit", () => {
  const chunks = chunkText("x".repeat(2500), 1000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join("").length, 2500);
});

test("chunkText returns nothing for empty input", () => {
  assert.deepEqual(chunkText("", 1000), []);
});

test("fetchPost falls through to the next source when one fails", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("cdn.syndication.twimg.com")) {
      return new Response("nope", { status: 404 });
    }
    if (url.includes("api.fxtwitter.com")) {
      return Response.json({
        tweet: { text: "The article body.", author: { name: "A", screen_name: "a" } },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const post = await fetchPost("1234567890123456789");
  assert.equal(post.text, "The article body.");
  assert.equal(post.source, "fxtwitter");
  assert.equal(calls.length, 2, "should try syndication before fxtwitter");
});

test("fetchPost prefers the long-form body over the truncated text", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      text: "Truncated preview…",
      note_tweet: { text: "The full untruncated article body." },
      user: { name: "A", screen_name: "a" },
    }),
  );

  const post = await fetchPost("1234567890123456789");
  assert.equal(post.text, "The full untruncated article body.");
});

test("fetchPost reads an X Article block structure", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      text: "",
      article: {
        title: "On Something",
        content_state: {
          blocks: [{ text: "Opening paragraph." }, { text: "" }, { text: "Closing paragraph." }],
        },
      },
      user: { name: "A", screen_name: "a" },
    }),
  );

  const post = await fetchPost("1234567890123456789");
  assert.equal(post.title, "On Something");
  assert.equal(post.text, "Opening paragraph.\n\nClosing paragraph.");
});

test("fetchPost reports every source when all of them fail", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("no", { status: 404 }));

  await assert.rejects(
    () => fetchPost("1234567890123456789"),
    (error: Error) => {
      assert.match(error.message, /syndication/);
      assert.match(error.message, /fxtwitter/);
      // Function names must survive as readable labels, not minified letters.
      assert.doesNotMatch(error.message, /\b[a-z]: /);
      return true;
    },
  );
});
