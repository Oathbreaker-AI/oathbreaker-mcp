import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/version.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const serverJson = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

test("version, registry name and package name agree across package.json, server.json and the code", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(serverJson.version, pkg.version);
  assert.equal(serverJson.name, pkg.mcpName);
  const npm = serverJson.packages.find((entry: any) => entry.registryType === "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(serverJson.remotes[0].url, "https://oathbreaker.ai/mcp");
});
