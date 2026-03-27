import { Command } from "commander";

/**
 * CLI 프로그램을 생성한다. 명령어 핸들러는 각 모듈에서 등록.
 */
export function createCli(): Command {
  const program = new Command();

  program
    .name("parism")
    .description("Structured shell output for AI agents")
    .version("0.5.0");

  program
    .command("capture <command>")
    .description("Execute command and save raw output as fixture")
    .option("-o, --output <dir>", "Output directory", "~/.parism/fixtures")
    .action(async (_command: string, _options: Record<string, unknown>) => {
      console.log("[parism] capture: not yet implemented");
      process.exit(1);
    });

  program
    .command("init-parser <name>")
    .description("Scaffold a new parser pack (TypeScript + schema + test)")
    .option("-d, --dir <dir>", "Output directory", ".")
    .action(async (name: string, options: { dir?: string }) => {
      const { initParser } = await import("./cli/init-parser.js");
      const result = initParser(name, options.dir ?? ".");
      console.log(`Parser pack "${result.name}" created:`);
      result.files.forEach(f => console.log(`  ${f}`));
    });

  program
    .command("test [parser]")
    .description("Run fixture replay tests for a parser pack")
    .action(async (_parser: string | undefined) => {
      console.log("[parism] test: not yet implemented");
      process.exit(1);
    });

  program
    .command("add <path>")
    .description("Register a local parser pack permanently")
    .action(async (_path: string) => {
      console.log("[parism] add: not yet implemented");
      process.exit(1);
    });

  program
    .command("inspect <command>")
    .description("Show raw / parsed / compact output comparison")
    .action(async (_command: string) => {
      console.log("[parism] inspect: not yet implemented");
      process.exit(1);
    });

  return program;
}
