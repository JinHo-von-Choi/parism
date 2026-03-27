import { describe, it, expect } from "vitest";

describe("CLI entry", () => {
  it("commander program이 capture, init-parser, test, add, inspect 명령을 가진다", async () => {
    const { createCli } = await import("../src/cli.js");
    const program = createCli();

    const commandNames = program.commands.map((c: { name: () => string }) => c.name());
    expect(commandNames).toContain("capture");
    expect(commandNames).toContain("init-parser");
    expect(commandNames).toContain("test");
    expect(commandNames).toContain("add");
    expect(commandNames).toContain("inspect");
  });
});
