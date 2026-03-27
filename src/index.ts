#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer }         from "./server.js";
import { loadConfig }           from "./config/loader.js";
import { createRegistry }       from "./parsers/index.js";
import { createCli }            from "./cli.js";
import path                     from "node:path";

const CLI_COMMANDS = ["capture", "init-parser", "test", "add", "inspect", "help", "--help", "-h", "--version", "-V"];

function isCliMode(): boolean {
  const firstArg = process.argv[2];
  return firstArg != null && CLI_COMMANDS.includes(firstArg);
}

async function startMcpServer(): Promise<void> {
  const configPath = path.join(process.cwd(), "prism.config.json");
  const config     = await loadConfig(configPath);
  const registry   = createRegistry();

  const { loadExternalParsers } = await import("./cli/auto-loader.js");
  const { parismHome }          = await import("./cli/paths.js");
  const loaded = await loadExternalParsers(parismHome(), registry);
  if (loaded > 0) {
    console.error(`[parism] Loaded ${loaded} external parser(s)`);
  }

  const server    = createServer(config, registry);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

async function startCli(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

async function main(): Promise<void> {
  if (isCliMode()) {
    await startCli();
  } else {
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error("[parism] Fatal error:", err);
  process.exit(1);
});
