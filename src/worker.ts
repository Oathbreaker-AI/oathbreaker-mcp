// Hosted server at https://oathbreaker.ai/mcp (a Cloudflare Worker on the route
// oathbreaker.ai/mcp*). Stateless: every MCP request builds a fresh server
// around the caller's API key. No database, no secrets, and nothing about the
// request is stored or logged.
import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { OathbreakerApi, type FetchLike } from "./api.js";
import { LINKS, MCP_SLOTS_PER_KEY, SITE } from "./catalog.js";
import { unlimited, type Release, type SlotLimiter } from "./limiter.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

export interface Env {
  KEY_SLOTS: DurableObjectNamespace<McpKeySlots>;
  /** Defaults to https://oathbreaker.ai. */
  OATHBREAKER_API_BASE?: string;
  /** Optional service binding to the site Worker; plain fetch is used without it. */
  SITE?: Fetcher;
}

/** A slot is freed after this long even if its request never released it. */
const SLOT_LEASE_MS = 15 * 60_000;

/**
 * One instance per API key, addressed by the key's SHA-256 (never the key).
 * Leases live in memory: if the instance is evicted, the count starts again
 * from zero, which only ever lets a request through.
 */
export class McpKeySlots extends DurableObject<Env> {
  private leases = new Map<string, number>();

  async acquire(id: string, max: number): Promise<boolean> {
    const now = Date.now();
    for (const [lease, expires] of this.leases) if (expires <= now) this.leases.delete(lease);
    if (this.leases.size >= max) return false;
    this.leases.set(id, now + SLOT_LEASE_MS);
    return true;
  }

  async release(id: string): Promise<void> {
    this.leases.delete(id);
  }
}

class DurableLimiter implements SlotLimiter {
  constructor(private readonly stub: DurableObjectStub<McpKeySlots>) {}

  async acquire(): Promise<Release | null> {
    const id = crypto.randomUUID();
    if (!(await this.stub.acquire(id, MCP_SLOTS_PER_KEY))) return null;
    return async () => {
      try {
        await this.stub.release(id);
      } catch {
        /* The lease expires on its own. */
      }
    };
  }
}

/** The caller's Oathbreaker key from `Authorization: Bearer` or `X-API-Key`. */
export function apiKeyFrom(request: Request): string | undefined {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  const key = bearer ?? request.headers.get("x-api-key")?.trim();
  return key || undefined;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const CORS = {
  origin: "*",
  methods: "GET, POST, DELETE, OPTIONS",
  headers: "Content-Type, Accept, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  exposeHeaders: "Mcp-Session-Id, Mcp-Protocol-Version",
  maxAge: 86_400,
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      return new Response("Not found. The Oathbreaker MCP server is at /mcp.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // A person opening the URL in a browser gets the setup page.
    if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) {
      return Response.redirect(LINKS.setup, 302);
    }

    const key = apiKeyFrom(request);
    const limiter = key ? new DurableLimiter(env.KEY_SLOTS.get(env.KEY_SLOTS.idFromName(await sha256Hex(key)))) : unlimited;
    const site = env.SITE;
    const fetcher: FetchLike | undefined = site ? (input, init) => site.fetch(input, init) : undefined;
    const api = new OathbreakerApi({ baseUrl: env.OATHBREAKER_API_BASE ?? SITE, apiKey: key, userAgent: `oathbreaker-mcp/${VERSION} (hosted)`, fetch: fetcher });

    const handler = createMcpHandler(() => createServer({ api, limiter, version: VERSION, mode: "hosted" }), {
      route: url.pathname,
      corsOptions: CORS,
      // Authentication is the API key header, never a cookie, so a browser
      // Origin cannot borrow anyone's credentials.
      allowedOriginHostnames: "*",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
