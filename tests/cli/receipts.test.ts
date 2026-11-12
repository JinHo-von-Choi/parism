/**
 * `parism receipts` 명령 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync }                    from "node:child_process";
import { mkdtempSync, writeFileSync }      from "node:fs";
import { tmpdir }                          from "node:os";
import path                                from "node:path";
import { autoKeyFile, formatCheck, parseRequire, receiptsCheck, receiptsList } from "../../src/cli/receipts.js";
import { ReceiptStore, loadSigningKey, signReceipt, workspaceState, type Receipt } from "../../src/engine/receipts.js";

let repo:      string;
let home:      string;
let hostConfig: string;
let savedHome: string | undefined;

/** 엔진이 쓰는 것과 같은 자동 서명 키로 서명해 남긴다. 키가 없으면 만든다. */
async function addReceipt(patch: Partial<Receipt> = {}): Promise<void> {
  const workspace = await workspaceState(repo, { untrackedMaxFiles: 2000, untrackedMaxBytes: 64 * 1024 * 1024 });
  const signing   = loadSigningKey(undefined, [repo], autoKeyFile());
  new ReceiptStore(path.join(home, "receipts"), { maxEntries: 500, maxAgeDays: 30 }).append({
    id: `rcp_${Math.random().toString(36).slice(2)}`, cmd: "npx", args: ["vitest", "run"], cwd: repo, exit_code: 0,
    started_at: new Date().toISOString(), duration_ms: 5, output_sha256: "0".repeat(64),
    summary: { kind: "test", passed: 4, failed: 0, skipped: 0, files_failed: 0 },
    ...(workspace && { workspace }), ...patch,
  }, signing.key ? r => signReceipt(r, signing.key!) : undefined);
}

beforeAll(async () => {
  repo = mkdtempSync(path.join(tmpdir(), "parism-cli-rcp-"));
  home = mkdtempSync(path.join(tmpdir(), "parism-cli-home-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo, stdio: "ignore" });

  hostConfig = path.join(home, "host.json");
  writeFileSync(hostConfig, JSON.stringify({ verify: { commands: [["npx", "vitest", "run"]] } }));
  savedHome = process.env.PARISM_HOME;
  process.env.PARISM_HOME = home;
  await addReceipt();
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.PARISM_HOME;
  else process.env.PARISM_HOME = savedHome;
});

describe("parseRequire()", () => {
  it("공백으로 나누거나 JSON 배열을 그대로 쓴다", () => {
    expect(parseRequire("npx vitest  run")).toEqual(["npx", "vitest", "run"]);
    expect(parseRequire('["npx","vitest","run","my test.ts"]')).toEqual(["npx", "vitest", "run", "my test.ts"]);
  });

  it("빈 값과 문자열이 아닌 원소는 거절한다", () => {
    expect(() => parseRequire("   ")).toThrow(/needs a command/);
    expect(() => parseRequire("[1,2]")).toThrow(/non-empty JSON array of strings/);
    expect(() => parseRequire("[]")).toThrow();
  });
});

describe("receiptsCheck()", () => {
  it("설정의 검증 묶음으로 판정한다", async () => {
    const report = await receiptsCheck({ cwd: repo, config: hostConfig });
    expect(report).toMatchObject({ ok: true });
    expect("items" in report && report.items[0]!.verdict).toBe("ok");
  });

  it("--require가 있으면 그 명령으로 판정한다", async () => {
    const report = await receiptsCheck({ cwd: repo, config: hostConfig, require: [["npx", "tsc", "--noEmit"]] });
    expect(report.ok).toBe(false);
    expect("items" in report && report.items[0]!.verdict).toBe("missing");
  });

  it("판정할 명령이 없으면 통과가 아니라 오류다", async () => {
    const empty = path.join(home, "empty.json");
    writeFileSync(empty, "{}");
    const report = await receiptsCheck({ cwd: repo, config: empty });
    expect(report).toMatchObject({ ok: false });
    expect("error" in report && report.error).toMatch(/no commands to check/);
  });

  it("파일을 고친 뒤에는 통과하지 않는다", async () => {
    writeFileSync(path.join(repo, "a.txt"), "two\n");
    const report = await receiptsCheck({ cwd: repo, config: hostConfig });
    expect(report.ok).toBe(false);
    expect("items" in report && report.items[0]!.verdict).toBe("stale");
    expect("items" in report && formatCheck(report)).toMatch(/^FAIL npx vitest run {2}\[stale\]/);
    writeFileSync(path.join(repo, "a.txt"), "one\n");
  });
});

describe("receiptsList()", () => {
  it("새것부터 개수만큼 돌려준다", async () => {
    await addReceipt({ id: "rcp_latest", cmd: "npx", args: ["tsc", "--noEmit"] });
    const list = await receiptsList({ limit: 1, config: hostConfig });
    expect(list.map(r => r.id)).toEqual(["rcp_latest"]);
  });
});
