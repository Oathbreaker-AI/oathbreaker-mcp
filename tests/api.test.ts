import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, OathbreakerApi } from "../src/api.ts";
import { listPriceCost } from "../src/server.ts";
import { CONFIG } from "./helpers.ts";

const request = { model: "oathbreaker-glm-5.3-flash", messages: [{ role: "user" as const, content: "hi" }], max_tokens: 100 };

function streamOf(parts: string[], delayMs = 0) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

test("reads events split across network chunks and CRLF line endings", async () => {
  const body = [
    'data: {"choices":[{"delta":{"reasoning_content":"ab"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const api = new OathbreakerApi({ baseUrl: "https://x.test", apiKey: "k", userAgent: "t", fetch: async () => new Response(streamOf(body)) });
  const progress: number[] = [];
  const result = await api.chat(request, { onProgress: p => progress.push(p.answerChars) });
  assert.equal(result.answer, "Hello!");
  assert.equal(result.reasoning, "ab");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 });
  assert.ok(progress.length > 0);
});

test("ignores comments and keep-alive lines", async () => {
  const body = [": keep-alive\n\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"];
  const api = new OathbreakerApi({ baseUrl: "https://x.test", apiKey: "k", userAgent: "t", fetch: async () => new Response(streamOf(body)) });
  assert.equal((await api.chat(request)).answer, "ok");
});

test("turns an API error body into an ApiError with code, request ID and Retry-After", async () => {
  const api = new OathbreakerApi({
    baseUrl: "https://x.test", apiKey: "k", userAgent: "t",
    fetch: async () => Response.json({ error: { code: "rate_limited", message: "Slow down.", request_id: "req_9" } }, { status: 429, headers: { "retry-after": "12" } }),
  });
  await assert.rejects(api.chat(request), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.message, "Slow down.");
    assert.equal(error.requestId, "req_9");
    assert.equal(error.retryAfterSeconds, 12);
    return true;
  });
});

test("gives up on an answer that stops arriving", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() { /* never sends */ } });
  const api = new OathbreakerApi({ baseUrl: "https://x.test", apiKey: "k", userAgent: "t", idleTimeoutMs: 50, fetch: async (_input, init) => {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    }));
  } });
  void stalled;
  await assert.rejects(api.chat(request), (error: unknown) => error instanceof ApiError && error.code === "stream_idle");
});

test("the caller's cancel signal stops the request", async () => {
  const controller = new AbortController();
  const api = new OathbreakerApi({ baseUrl: "https://x.test", apiKey: "k", userAgent: "t", fetch: async (_input, init) => {
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
      },
    }));
  } });
  const pending = api.chat(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
});

test("never sends a key it was not given, and drops malformed catalog entries", async () => {
  let seen: Record<string, string> = {};
  const api = new OathbreakerApi({ baseUrl: "https://x.test/", userAgent: "t", fetch: async (input, init) => {
    seen = init?.headers as Record<string, string>;
    assert.equal(String(input), "https://x.test/api/config");
    return Response.json({ models: [...CONFIG.models, { model: "broken" }], membership: { percentOff: 25 } });
  } });
  const catalog = await api.catalog();
  assert.equal(seen.authorization, undefined);
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.memberPercentOff, 25);
});

test("list-price cost counts cached input at the cached rate", () => {
  const glm = CONFIG.models[0];
  // 1M input of which 400k cached, 100k output: 600k x $3 + 400k x $0.30 + 100k x $4 = 1.8 + 0.12 + 0.4
  assert.equal(listPriceCost({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }, glm).toFixed(4), "2.3200");
});
