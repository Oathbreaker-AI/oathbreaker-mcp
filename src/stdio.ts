#!/usr/bin/env node
// Local server for MCP clients that start a command (stdio). Reads the API key
// from OATHBREAKER_API_KEY. stdout carries the protocol, so nothing else may be
// written there; notes go to stderr.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OathbreakerApi } from "./api.js";
import { MCP_SLOTS_PER_KEY, SITE } from "./catalog.js";
import { LocalLimiter } from "./limiter.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const apiKey = process.env.OATHBREAKER_API_KEY?.trim() || undefined;
if (!apiKey) process.stderr.write("oathbreaker-mcp: OATHBREAKER_API_KEY is not set; only list_models will work.\n");

const api = new OathbreakerApi({
  baseUrl: process.env.OATHBREAKER_API_BASE?.trim() || SITE,
  apiKey,
  userAgent: `oathbreaker-mcp/${VERSION} (local)`,
});
const limiter = new LocalLimiter(MCP_SLOTS_PER_KEY);

serveStdio(() => createServer({ api, limiter, version: VERSION, mode: "local" }));
