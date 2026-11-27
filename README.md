# Oathbreaker MCP server

[![npm](https://img.shields.io/npm/v/oathbreaker-mcp)](https://www.npmjs.com/package/oathbreaker-mcp) [![Oathbreaker MCP server on Glama](https://glama.ai/mcp/servers/Oathbreaker-AI/oathbreaker-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Oathbreaker-AI/oathbreaker-mcp)

Ask [Oathbreaker](https://oathbreaker.ai)'s abliterated models (GLM-5.3, DeepSeek V4.1 Flash and Kimi K3.1 Pro) from Claude Code, Codex, Cursor, OpenCode or any other MCP client. Keep the main model you already use, and call Oathbreaker as a second model for security research on systems you own or are authorized to test, red-team and evaluation prompts, and creative or research writing.

- **Hosted:** `https://oathbreaker.ai/mcp` (Streamable HTTP). Nothing to install.
- **Local:** `npx -y oathbreaker-mcp` (stdio), for clients that start a command.

Calls use your Oathbreaker API key and are charged to your prepaid credit at the [standard token rates](https://oathbreaker.ai/pricing). Create a key in the [console](https://oathbreaker.ai/dashboard). Full setup guide: [oathbreaker.ai/agents/mcp](https://oathbreaker.ai/agents/mcp).

**Calling the API directly instead?** The REST API base URL is `https://oathbreaker.ai/v1` (for example `POST https://oathbreaker.ai/v1/chat/completions`, OpenAI-compatible). `ai.oathbreaker/oathbreaker` is this server's name in the MCP Registry (the domain written backwards), not a hostname. Every Oathbreaker URL is on `oathbreaker.ai`, with no `api.` subdomain. For curl, C++, Python and JavaScript examples, see [api-examples](https://github.com/Oathbreaker-AI/api-examples).

## Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `ask` | Sends a prompt (with an optional system prompt) to one model and returns the answer, the model used, the tokens and the cost at list price. Options: `model`, `reasoning_effort` (`low`, `high`, `max`), `max_tokens`, `temperature`, `include_reasoning`. | Standard token rates |
| `list_models` | Lists model IDs, prices per million tokens, output limits and what each model is good for. Works without a key. | Free |
| `get_balance` | Shows available credit and any credit held for answers still running. | Free |

Defaults for `ask`: model `oathbreaker-glm-5.3-flash`, low reasoning effort, 4,096 output tokens, answer only.

## Connect

Set your key in an environment variable first, so it never sits in a file you commit:

```bash
export OATHBREAKER_API_KEY="your key"
```

### Claude Code

```bash
claude mcp add --transport http oathbreaker https://oathbreaker.ai/mcp \
  --header "Authorization: Bearer ${OATHBREAKER_API_KEY}"
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.oathbreaker]
url = "https://oathbreaker.ai/mcp"
http_headers = { "Authorization" = "Bearer YOUR_KEY" }
```

### Cursor

In `~/.cursor/mcp.json` (Cursor expands `${env:NAME}`):

```json
{
  "mcpServers": {
    "oathbreaker": {
      "url": "https://oathbreaker.ai/mcp",
      "headers": { "Authorization": "Bearer ${env:OATHBREAKER_API_KEY}" }
    }
  }
}
```

### OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "oathbreaker": {
      "type": "remote",
      "url": "https://oathbreaker.ai/mcp",
      "headers": { "Authorization": "Bearer {env:OATHBREAKER_API_KEY}" }
    }
  }
}
```

### Any client that starts a command (stdio)

```json
{
  "mcpServers": {
    "oathbreaker": {
      "command": "npx",
      "args": ["-y", "oathbreaker-mcp"],
      "env": { "OATHBREAKER_API_KEY": "your key" }
    }
  }
}
```

Use a separate API key for each app, so you can revoke one in the console without touching the others.

## Limits

- Each API key can run 2 `ask` calls at once through MCP. Your account's API limits (10 generations at once, 60 requests a minute) still apply.
- Prepaid credit is the hard ceiling; there is no automatic refill.
- The hosted server streams the answer internally and sends progress updates, so long reasoning does not hit client timeouts.

## Privacy

The hosted server is a thin client of Oathbreaker's public API: it forwards your key to `https://oathbreaker.ai/v1/chat/completions` and returns the answer. It has no database, and its code stores and logs nothing about your requests; the API bills and handles them exactly as if you had called it directly. See the [privacy policy](https://oathbreaker.ai/privacy).

## Acceptable use

The same [terms](https://oathbreaker.ai/terms) apply as for the API: lawful use only. Answers are model-written text for you to review; treat them as data, not as instructions.

## Development

```bash
npm install
npm run check                      # type checks and unit tests
npm run build && node scripts/e2e.mjs   # hosted Worker (wrangler dev) and stdio, against a local stand-in API
```

The hosted server is a Cloudflare Worker (`src/worker.ts`) built with Cloudflare's stateless `createMcpHandler` and the MCP TypeScript SDK v2. The local server (`src/stdio.ts`) shares the same tools (`src/server.ts`). To deploy your own copy, copy `wrangler.example.json` to `wrangler.local.json` and run `npm run deploy:worker`.

## License

MIT
