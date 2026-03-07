import { describe, it, expect } from "vitest";
import { parseEnv }  from "../../src/parsers/env/env.js";
import { parsePwd }  from "../../src/parsers/env/pwd.js";
import { parseWhich } from "../../src/parsers/env/which.js";

describe("parseEnv()", () => {
  const envOutput = "HOME=/home/user\nSHELL=/bin/bash\nPATH=/usr/local/bin:/usr/bin\n";

  it("환경 변수를 키-값 맵으로 파싱한다", () => {
    const result = parseEnv("env", [], envOutput) as { vars: Record<string, string> };
    expect(result.vars["HOME"]).toBe("/home/user");
    expect(result.vars["SHELL"]).toBe("/bin/bash");
  });
});

describe("parsePwd()", () => {
  it("경로를 파싱한다", () => {
    const result = parsePwd("pwd", [], "/home/user/project");
    expect(result.path).toBe("/home/user/project");
  });
});

describe("parseWhich()", () => {
  it("경로 목록을 파싱한다", () => {
    const result = parseWhich("which", ["node"], "/usr/bin/node\n");
    expect(result.paths).toEqual(["/usr/bin/node"]);
  });

  it("여러 경로를 파싱한다", () => {
    const result = parseWhich("which", ["-a", "python"], "/usr/bin/python3\n/usr/local/bin/python3\n");
    expect(result.paths).toHaveLength(2);
  });
});
