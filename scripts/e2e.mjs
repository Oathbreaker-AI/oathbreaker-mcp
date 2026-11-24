// End-to-end check of both entry points against a local stand-in for the
// Oathbreaker API: the hosted Worker under `wrangler dev` (real workerd, real
// Durable Object) over Streamable HTTP, and the built npm package over stdio.
// Run with `npm run build && node scripts/e2e.mjs`. Needs no network or key.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const API_PORT = 8799;
const MCP_PORT = 8798;
const KEY = "ob_sk_e2e_fake";
const seen = { chat: [], maxConcurrent: 0, running: 0 };

const config = {
  models: [
    { model: "oathbreaker-glm-5.3-flash", name: "Oathbreaker Flash — GLM-5.3 Flash Abliterated", inferenceReady: true, inputPerMillion: 0.4, cachedInputPerMillion: 0.04, outputPerMillion: 1.2, maxOutputTokens: 32768, contextLimit: 131072 },
    { model: "oathbreaker-glm-5.3", name: "Oathbreaker — GLM-5.3 Abliterated", inferenceReady: true, inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 4, maxOutputTokens: 32768, contextLimit: 131072 },
  ],
  membership: { percentOff: 25 },
};

const api = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  if (req.url === "/api/config") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config));
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid API key.", request_id: "req_e2e" } }));
  }
  if (req.url === "/v1/account/balance") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ balance_usd: 5, held_usd: 0, available_usd: 5 }));
  }
  if (req.url === "/v1/chat/completions") {
    seen.chat.push({ body, ua: req.headers["user-agent"] });
    seen.running += 1;
    seen.maxConcurrent = Math.max(seen.maxConcurrent, seen.running);
    const slow = body.messages.at(-1).content.includes("slow");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ model: body.model, choices: [{ delta: { reasoning_content: "Considering. " } }] });
    for (const word of ["Answer", " from", " the", " stand-in."]) {
      await new Promise(resolve => setTimeout(resolve, slow ? 900 : 20));
      send({ model: body.model, choices: [{ delta: { content: word } }] });
    }
    send({ model: body.model, choices: [{ delta: {}, finish_reason: "stop" }] });
    send({ model: body.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } });
    res.end("data: [DONE]\n\n");
    seen.running -= 1;
    return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => api.listen(API_PORT, "127.0.0.1", resolve));

writeFileSync("wrangler.e2e.json", JSON.stringify({
  name: "oathbreaker-mcp-e2e", main: "src/worker.ts", compatibility_date: "2026-11-17", compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [{ name: "KEY_SLOTS", class_name: "McpKeySlots" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["McpKeySlots"] }],
  vars: { OATHBREAKER_API_BASE: `http://127.0.0.1:${API_PORT}` },
}));
const wrangler = spawn("npx", ["wrangler", "dev", "--config", "wrangler.e2e.json", "--port", String(MCP_PORT), "--ip", "127.0.0.1", "--log-level", "warn"], {
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let wranglerLog = "";
wrangler.stdout.on("data", d => (wranglerLog += d));
wrangler.stderr.on("data", d => (wranglerLog += d));

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
  }
};
const text = result => result.content.map(part => part.text ?? "").join("");

try {
  const base = `http://127.0.0.1:${MCP_PORT}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/nope`);
      if (r.status === 404) break;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await check("hosted: a browser visit to /mcp redirects to the setup page", async () => {
    const r = await fetch(`${base}/mcp`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://oathbreaker.ai/agents/mcp");
  });

  await check("hosted: other paths are 404", async () => {
    assert.equal((await fetch(`${base}/mcpx`)).status, 404);
  });

  await check("hosted: CORS preflight is answered for browser-based clients", async () => {
    const r = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://inspector.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    assert.ok(r.status === 204 || r.status === 200, `status ${r.status}`);
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
  });

  const anon = new Client({ name: "e2e-anon", version: "1.0.0" });
  await check("hosted: connects and lists tools without a key", async () => {
    await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await anon.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["ask", "get_balance", "list_models"]);
  });
  await check("hosted: list_models works without a key", async () => {
    const out = text(await anon.callTool({ name: "list_models", arguments: {} }));
    assert.match(out, /oathbreaker-glm-5\.3-flash: .*\$0\.40 input/);
  });
  await check("hosted: ask without a key explains the Authorization header", async () => {
    const result = await anon.callTool({ name: "ask", arguments: { prompt: "hi" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Authorization header/);
  });

  const authed = () => new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } });
  const client = new Client({ name: "e2e-key", version: "1.0.0" });
  await check("hosted: ask with a key returns the answer, tokens and cost, and streams progress", async () => {
    await client.connect(authed());
    const progress = [];
    const result = await client.callTool({ name: "ask", arguments: { prompt: "slow please" } }, { onprogress: p => progress.push(p.message) });
    const out = text(result);
    assert.ok(!result.isError, out);
    assert.match(out, /^Answer from the stand-in\./);
    assert.match(out, /120 input and 40 output tokens · \$0\.0001 at list price/);
    assert.ok(progress.length >= 1, `progress messages: ${progress.length}`);
    const last = seen.chat.at(-1);
    assert.equal(last.body.max_tokens, 4096);
    assert.equal(last.body.reasoning_effort, "low");
    assert.match(last.ua, /^oathbreaker-mcp\/1\.0\.0 \(hosted\)$/);
  });
  await check("hosted: get_balance with a key", async () => {
    assert.match(text(await client.callTool({ name: "get_balance", arguments: {} })), /Available: \$5\.00/);
  });
  await check("hosted: a wrong key gets the API's 401 explained", async () => {
    const bad = new Client({ name: "e2e-bad", version: "1.0.0" });
    await bad.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer ob_sk_wrong" } } }));
    const result = await bad.callTool({ name: "ask", arguments: { prompt: "hi" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /rejected the API key \(request req_e2e\)/);
  });
  await check("hosted: a third simultaneous ask for the same key is refused; the first two finish", async () => {
    seen.maxConcurrent = 0;
    const clients = await Promise.all([0, 1, 2].map(async i => {
      const c = new Client({ name: `e2e-par-${i}`, version: "1.0.0" });
      await c.connect(authed());
      return c;
    }));
    const calls = clients.map((c, i) => new Promise(resolve => setTimeout(resolve, i * 300)).then(() => c.callTool({ name: "ask", arguments: { prompt: "slow parallel" } })));
    const outs = await Promise.all(calls);
    const refused = outs.filter(r => r.isError && /already running/.test(text(r)));
    const answered = outs.filter(r => !r.isError);
    assert.equal(refused.length, 1, outs.map(text).join(" | "));
    assert.equal(answered.length, 2);
    assert.equal(seen.maxConcurrent, 2);
  });
  await check("hosted: slots are free again afterwards", async () => {
    const result = await client.callTool({ name: "ask", arguments: { prompt: "hi" } });
    assert.ok(!result.isError, text(result));
  });

  await check("local: the built npm package works over stdio with OATHBREAKER_API_KEY", async () => {
    const local = new Client({ name: "e2e-stdio", version: "1.0.0" });
    await local.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/stdio.js"], env: { ...process.env, OATHBREAKER_API_KEY: KEY, OATHBREAKER_API_BASE: `http://127.0.0.1:${API_PORT}` }, stderr: "pipe" }));
    const { tools } = await local.listTools();
    assert.equal(tools.length, 3);
    const out = text(await local.callTool({ name: "ask", arguments: { prompt: "hi", model: "oathbreaker-glm-5.3" } }));
    assert.match(out, /^Answer from the stand-in\./);
    assert.match(seen.chat.at(-1).ua, /\(local\)$/);
    await local.close();
  });
} finally {
  wrangler.kill("SIGTERM");
  api.close();
  rmSync("wrangler.e2e.json", { force: true });
}

console.log(results.join("\n"));
if (results.some(line => line.startsWith("FAIL"))) {
  console.log("\n--- wrangler output ---\n" + wranglerLog.slice(-4000));
  process.exit(1);
}
process.exit(0);
