#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer }         from "./server.js";
import { loadConfig }           from "./config/loader.js";
import { createRegistry }       from "./parsers/index.js";
import path                     from "node:path";

async function main(): Promise<void> {
  const configPath = path.join(process.cwd(), "prism.config.json");
  const config     = await loadConfig(configPath);
  const registry   = createRegistry();

  const server    = createServer(config, registry);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err) => {
  console.error("[parism] Fatal error:", err);
  process.exit(1);
});
