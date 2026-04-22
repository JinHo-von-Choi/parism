import { createEngine }     from "../facade/engine.js";
import type { ResponseEnvelope } from "../types/envelope.js";

interface EvalResult {
  total:   number;
  success: number;
  fail:    number;
  details: Array<{ cmd: string; args: string[]; passed: boolean; error?: string }>;
}

interface EvalResults {
  "parse-error": EvalResult;
  "retry-rate": EvalResult;
  completion:   EvalResult;
}

type TestCase = { cmd: string; args: string[] };

const SCENARIOS: Record<string, TestCase[]> = {
  "parse-error": [
    { cmd: "ls", args: ["-la", "/tmp"] },
    { cmd: "ps", args: ["aux"] },
    { cmd: "git", args: ["status", "--porcelain"] },
    { cmd: "find", args: ["/tmp", "-name", "*.log"] },
    { cmd: "df", args: ["-h"] },
    { cmd: "du", args: ["-sh", "/tmp"] },
    { cmd: "stat", args: ["/tmp"] },
  ],
  "retry-rate": [
    { cmd: "ls", args: ["/nonexistent"] },
    { cmd: "cat", args: ["/nonexistent/file"] },
    { cmd: "git", args: ["branch", "-vv"] },
    { cmd: "docker", args: ["ps"] },
    { cmd: "kubectl", args: ["get", "pods"] },
    { cmd: "helm", args: ["list"] },
    { cmd: "curl", args: ["-I", "http://localhost:9999"] },
  ],
  completion: [
    { cmd: "echo", args: ["test"] },
    { cmd: "pwd", args: [] },
    { cmd: "which", args: ["ls"] },
    { cmd: "env", args: [] },
    { cmd: "uname", args: [] },
    { cmd: "git", args: ["--version"] },
    { cmd: "node", args: ["--version"] },
  ],
};

type ScenarioName = keyof EvalResults;

async function runSingleCmd(engine: Awaited<ReturnType<typeof createEngine>>, cmd: string, args: string[]): Promise<boolean> {
  try {
    const result: ResponseEnvelope = await engine.run(cmd, { args });
    return result.ok;
  } catch {
    return false;
  }
}

export async function runEvalSuite(scenario: string | undefined, verbose?: boolean): Promise<EvalResults> {
  const engine = await createEngine();
  const results: EvalResults = {
    "parse-error": { total: 0, success: 0, fail: 0, details: [] },
    "retry-rate":  { total: 0, success: 0, fail: 0, details: [] },
    completion:   { total: 0, success: 0, fail: 0, details: [] },
  };

  const scenariosToRun: ScenarioName[] = scenario 
    ? [scenario as ScenarioName] 
    : (["parse-error", "retry-rate", "completion"]);

  for (const name of scenariosToRun) {
    const testCases = SCENARIOS[name];
    const result = results[name];

    for (const tc of testCases) {
      const passed = await runSingleCmd(engine, tc.cmd, tc.args);
      result.total++;
      if (passed) result.success++; else result.fail++;
      result.details.push({ cmd: tc.cmd, args: tc.args, passed, error: passed ? undefined : "command failed" });

      if (verbose) {
        console.log(`[${name}] ${tc.cmd} ${tc.args.join(" ")}: ${passed ? "PASS" : "FAIL"}`);
      }
    }
  }

  return results;
}