import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { OathbreakerApi, type FetchLike } from "../src/api.ts";
import { LocalLimiter, type SlotLimiter } from "../src/limiter.ts";
import { createServer, resetCatalogCache } from "../src/server.ts";

export const CONFIG = {
  models: [
    { model: "oathbreaker-glm-5.3", name: "Oathbreaker — GLM-5.3 Abliterated", inferenceReady: true, inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 4, maxOutputTokens: 32768, contextLimit: 131072, toolCalling: true, reasoning: true },
    { model: "oathbreaker-glm-5.3-flash", name: "Oathbreaker Flash — GLM-5.3 Flash Abliterated", inferenceReady: true, inputPerMillion: 0.4, cachedInputPerMillion: 0.04, outputPerMillion: 1.2, maxOutputTokens: 32768, contextLimit: 131072, toolCalling: true, reasoning: true },
    { model: "oathbreaker-kimi-k3.1-pro", name: "Oathbreaker Kimi — K3.1 Pro Abliterated", inferenceReady: false, inputPerMillion: 4.5, cachedInputPerMillion: 0.45, outputPerMillion: 9, maxOutputTokens: 24576, contextLimit: 131072, toolCalling: true, reasoning: true },
  ],
  membership: { memberPricePercent: 75, percentOff: 25 },
};

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

export interface FakeOptions {
  /** SSE events (objects become `data: <json>`); "[DONE]" is appended unless omitted. */
  chunks?: unknown[];
  noDone?: boolean;
  chatStatus?: number;
  chatError?: { code: string; message: string; request_id?: string };
  retryAfter?: string;
  balance?: { balance_usd: number; held_usd: number; available_usd: number };
  configStatus?: number;
}

export function fakeFetch(options: FakeOptions = {}) {
  const calls: Recorded[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const record: Recorded = { url, method: init?.method ?? "GET", headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(record);
    const path = new URL(url).pathname;
    if (path === "/api/config") {
      return options.configStatus ? new Response("nope", { status: options.configStatus }) : Response.json(CONFIG);
    }
    if (path === "/v1/account/balance") {
      if (!headers.authorization) return Response.json({ error: { code: "invalid_api_key", message: "Missing key." } }, { status: 401 });
      return Response.json({ object: "balance", currency: "usd", status: "active", ...(options.balance ?? { balance_usd: 12.5, held_usd: 0.25, available_usd: 12.25 }) });
    }
    if (path === "/v1/chat/completions") {
      if (options.chatStatus) {
        return Response.json({ error: { type: "x", ...(options.chatError ?? { code: "err", message: "Failed." }) } }, {
          status: options.chatStatus,
          headers: options.retryAfter ? { "retry-after": options.retryAfter } : {},
        });
      }
      const events = (options.chunks ?? defaultChunks()).map(chunk => (typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}`));
      if (!options.noDone) events.push("data: [DONE]");
      const body = events.map(event => `${event}\n\n`).join("");
      return new Response(new Blob([body]).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

export function defaultChunks() {
  return [
    { model: "oathbreaker-glm-5.3-flash", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Thinking about it. " } }] },
    { model: "oathbreaker-glm-5.3-flash", choices: [{ index: 0, delta: { content: "Hello" } }] },
    { model: "oathbreaker-glm-5.3-flash", choices: [{ index: 0, delta: { content: " there." }, finish_reason: "stop" }] },
    { model: "oathbreaker-glm-5.3-flash", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } } },
  ];
}

export async function connect(options: { apiKey?: string; fake?: ReturnType<typeof fakeFetch>; limiter?: SlotLimiter; mode?: "hosted" | "local" } = {}) {
  resetCatalogCache();
  const fake = options.fake ?? fakeFetch();
  const api = new OathbreakerApi({ baseUrl: "https://oathbreaker.test", apiKey: options.apiKey, userAgent: "oathbreaker-mcp/test", fetch: fake.fetcher });
  const server = createServer({ api, limiter: options.limiter ?? new LocalLimiter(2), version: "1.0.0", mode: options.mode ?? "local" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, calls: fake.calls };
}

export function textOf(result: any): string {
  return (result.content ?? []).map((part: any) => part.text ?? "").join("");
}
