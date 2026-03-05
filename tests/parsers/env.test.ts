import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/parsers/env/env.js";

describe("parseEnv()", () => {
  const envOutput = "HOME=/home/user\nSHELL=/bin/bash\nPATH=/usr/local/bin:/usr/bin\n";

  it("환경 변수를 키-값 맵으로 파싱한다", () => {
    const result = parseEnv("env", [], envOutput) as { vars: Record<string, string> };
    expect(result.vars["HOME"]).toBe("/home/user");
    expect(result.vars["SHELL"]).toBe("/bin/bash");
  });
});
