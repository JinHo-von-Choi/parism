/**
 * 실행 영수증 시험: 요약, 작업 공간 상태, 서명, 보관, 판정.
 * 작업 공간 상태는 임시 git 저장소에서 실제 git으로 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync }                     from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir }                           from "node:os";
import path                                 from "node:path";
import {
  ReceiptStore, checkReceipts, loadSigningKey, signReceipt, signatureValid, summarize, workspaceState,
  type Receipt,
} from "../../src/engine/receipts.js";

const LIMITS = { untrackedMaxFiles: 100, untrackedMaxBytes: 1024 * 1024 };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-rcp-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function receiptFor(dir: string, patch: Partial<Receipt> = {}): Promise<Receipt> {
  const workspace = await workspaceState(dir, LIMITS);
  return {
    id: "rcp_test", cmd: "npx", args: ["vitest", "run", "--reporter=json"], args_requested: ["vitest", "run"], cwd: dir,
    exit_code: 0, started_at: new Date().toISOString(), duration_ms: 10,
    summary: { kind: "test", passed: 3, failed: 0, skipped: 0, files_failed: 0 },
    output_sha256: "0".repeat(64), ...(workspace && { workspace }), ...patch,
  };
}

const REQUIRED = [["npx", "vitest", "run"]];

describe("summarize()", () => {
  it("시험 보고서와 진단 보고서에서 요약을 꺼낸다", () => {
    expect(summarize({ kind: "test", passed: 5, failed: 1, skipped: 2, files_failed: 1, failures: [] }))
      .toEqual({ kind: "test", passed: 5, failed: 1, skipped: 2, files_failed: 1 });
    expect(summarize({ kind: "diagnostics", errors: 2, warnings: 3, diagnostics: [] }))
      .toEqual({ kind: "diagnostics", errors: 2, warnings: 3 });
  });

  it("보고서가 아닌 결과에는 요약이 없다", () => {
    expect(summarize({ entries: [] })).toBeUndefined();
    expect(summarize(null)).toBeUndefined();
    expect(summarize([{ kind: "test" }])).toBeUndefined();
  });
});

describe("workspaceState()", () => {
  let dir: string;
  beforeEach(() => { dir = makeRepo(); });

  it("아무것도 바뀌지 않으면 같은 값이다", async () => {
    const first  = await workspaceState(dir, LIMITS);
    const second = await workspaceState(dir, LIMITS);
    expect(first?.state_digest).toBe(second?.state_digest);
    expect(first?.covers).toEqual(["tracked", "staged", "untracked_names", "untracked_content"]);
    expect(first?.git_head).toMatch(/^[0-9a-f]{12}$/);
  });

  it("추적 파일 수정, 스테이징, 새 파일, 새 파일의 내용 변경을 각각 다른 상태로 본다", async () => {
    const seen = new Set<string>();
    const note = async (): Promise<void> => { seen.add((await workspaceState(dir, LIMITS))!.state_digest); };

    await note();
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    await note();
    git(dir, "add", "a.txt");
    await note();
    writeFileSync(path.join(dir, "new.txt"), "x");
    await note();
    writeFileSync(path.join(dir, "new.txt"), "y");
    await note();

    expect(seen.size).toBe(5);
  });

  it("수정을 되돌리면 처음 상태와 같다", async () => {
    const before = (await workspaceState(dir, LIMITS))!.state_digest;
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    expect((await workspaceState(dir, LIMITS))!.state_digest).toBe(before);
  });

  it(".gitignore로 제외된 파일은 상태에 들어가지 않는다", async () => {
    const before = (await workspaceState(dir, LIMITS))!.state_digest;
    mkdirSync(path.join(dir, "ignored"));
    writeFileSync(path.join(dir, "ignored", "cache.bin"), "zzz");
    expect((await workspaceState(dir, LIMITS))!.state_digest).toBe(before);
  });

  it("추적되지 않는 파일이 한도를 넘으면 내용 해시를 빼고 그 사실을 남긴다", async () => {
    writeFileSync(path.join(dir, "n1.txt"), "1");
    writeFileSync(path.join(dir, "n2.txt"), "2");
    const state = await workspaceState(dir, { untrackedMaxFiles: 1, untrackedMaxBytes: 1024 });

    expect(state?.covers).toEqual(["tracked", "staged", "untracked_names"]);
    expect(state?.untracked_skipped?.files).toBe(2);
  });

  it("하위 디렉터리에서 불러도 저장소 전체의 상태다", async () => {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "keep.txt"), "k");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "sub");
    const fromRoot = await workspaceState(dir, LIMITS);
    const fromSub  = await workspaceState(path.join(dir, "sub"), LIMITS);
    expect(fromSub?.state_digest).toBe(fromRoot?.state_digest);
    expect(fromSub?.root).toBe(fromRoot?.root);
  });

  it("git 저장소가 아니면 undefined다", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "parism-plain-"));
    expect(await workspaceState(plain, LIMITS)).toBeUndefined();
  });
});

describe("checkReceipts()", () => {
  let dir: string;
  beforeEach(() => { dir = makeRepo(); });

  const verdict = async (receipts: Receipt[], commands = REQUIRED): Promise<string[]> =>
    (await checkReceipts({ receipts, commands, cwd: dir, limits: LIMITS })).items.map(i => i.verdict);

  it("통과한 영수증이 있고 작업 공간이 그대로면 ok다", async () => {
    const report = await checkReceipts({ receipts: [await receiptFor(dir)], commands: REQUIRED, cwd: dir, limits: LIMITS });
    expect(report.ok).toBe(true);
    expect(report.items[0]).toMatchObject({ verdict: "ok", receipt_id: "rcp_test" });
  });

  it("호출자가 준 인자와 실제로 실행한 인자 어느 쪽으로도 찾는다", async () => {
    const receipt = await receiptFor(dir);
    expect(await verdict([receipt], [["npx", "vitest", "run", "--reporter=json"]])).toEqual(["ok"]);
  });

  it("영수증이 없으면 missing이다", async () => {
    expect(await verdict([])).toEqual(["missing"]);
    expect(await verdict([await receiptFor(dir)], [["npx", "tsc", "--noEmit"]])).toEqual(["missing"]);
  });

  it("실행 뒤 파일이 바뀌면 stale이다", async () => {
    const receipt = await receiptFor(dir);
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    expect(await verdict([receipt])).toEqual(["stale"]);
  });

  it("종료 코드, 실패한 시험, 실행하지 못한 파일, 오류, 실행 실패는 failed다", async () => {
    expect(await verdict([await receiptFor(dir, { exit_code: 1 })])).toEqual(["failed"]);
    expect(await verdict([await receiptFor(dir, { summary: { kind: "test", passed: 1, failed: 2, skipped: 0, files_failed: 0 } })])).toEqual(["failed"]);
    expect(await verdict([await receiptFor(dir, { summary: { kind: "test", passed: 1, failed: 0, skipped: 0, files_failed: 1 } })])).toEqual(["failed"]);
    expect(await verdict([await receiptFor(dir, { summary: { kind: "diagnostics", errors: 1, warnings: 0 } })])).toEqual(["failed"]);
    expect(await verdict([await receiptFor(dir, { exit_code: 1, failure_reason: "timeout" })])).toEqual(["failed"]);
  });

  it("같은 명령의 영수증이 여럿이면 가장 최근 것으로 판정한다", async () => {
    const old    = await receiptFor(dir, { id: "old", started_at: "2026-01-01T00:00:00.000Z" });
    const recent = await receiptFor(dir, { id: "new", started_at: "2026-06-01T00:00:00.000Z", exit_code: 1 });
    expect(await verdict([recent, old])).toEqual(["failed"]);
  });

  it("다른 저장소의 영수증은 쓰지 않는다", async () => {
    const other = makeRepo();
    expect(await verdict([await receiptFor(other)])).toEqual(["missing"]);
  });

  it("작업 공간 상태가 없는 영수증은 unverifiable이다", async () => {
    const plain   = mkdtempSync(path.join(tmpdir(), "parism-plain-"));
    const receipt = await receiptFor(plain);
    const report  = await checkReceipts({ receipts: [receipt], commands: REQUIRED, cwd: plain, limits: LIMITS });
    expect(report.items[0]!.verdict).toBe("unverifiable");
    expect(report.ok).toBe(false);
  });

  it("서명 키가 있으면 서명이 맞지 않는 영수증을 거절한다", async () => {
    const key      = Buffer.from("k".repeat(32));
    const signed   = signReceipt(await receiptFor(dir), key);
    const tampered = { ...signed, exit_code: 0, summary: { kind: "test" as const, passed: 99, failed: 0, skipped: 0, files_failed: 0 } };
    const check    = async (r: Receipt): Promise<string> =>
      (await checkReceipts({ receipts: [r], commands: REQUIRED, cwd: dir, limits: LIMITS, key })).items[0]!.verdict;

    expect(await check(signed)).toBe("ok");
    expect(await check(tampered)).toBe("bad_signature");
    expect(await check(await receiptFor(dir))).toBe("bad_signature");
  });
});

describe("서명", () => {
  it("내용이 바뀌면 서명이 맞지 않는다", async () => {
    const key    = Buffer.from("k".repeat(32));
    const signed = signReceipt({ id: "r", cmd: "ls", args: [], cwd: "/", exit_code: 0, started_at: "t", duration_ms: 1, output_sha256: "h" }, key);

    expect(signatureValid(signed, key)).toBe(true);
    expect(signatureValid({ ...signed, exit_code: 1 }, key)).toBe(false);
    expect(signatureValid(signed, Buffer.from("x".repeat(32)))).toBe(false);
  });

  it("가드가 읽기를 허용한 경로 안의 키 파일은 쓰지 않는다", () => {
    const dir     = mkdtempSync(path.join(tmpdir(), "parism-key-"));
    const keyFile = path.join(dir, "receipt.key");
    writeFileSync(keyFile, "k".repeat(32));

    expect(loadSigningKey(keyFile, [dir]).key).toBeUndefined();
    expect(loadSigningKey(keyFile, [dir]).warning).toMatch(/inside guard.allowed_paths/);
    expect(loadSigningKey(keyFile, []).key).toBeUndefined();
    expect(loadSigningKey(keyFile, ["/some/other/place"]).key?.length).toBe(32);
    expect(loadSigningKey(undefined, [dir])).toEqual({});
  });

  it("너무 짧은 키는 쓰지 않는다", () => {
    const dir     = mkdtempSync(path.join(tmpdir(), "parism-key-"));
    const keyFile = path.join(dir, "short.key");
    writeFileSync(keyFile, "short");
    expect(loadSigningKey(keyFile, ["/elsewhere"]).warning).toMatch(/shorter than 16 bytes/);
  });
});

describe("ReceiptStore", () => {
  const base = (i: number, at = new Date().toISOString()): Receipt =>
    ({ id: `r${i}`, cmd: "ls", args: [], cwd: "/", exit_code: 0, started_at: at, duration_ms: 1, output_sha256: "h" });

  it("남긴 영수증을 오래된 순서로 읽는다", () => {
    const dir   = mkdtempSync(path.join(tmpdir(), "parism-store-"));
    const store = new ReceiptStore(dir, { maxEntries: 10, maxAgeDays: 30 });
    store.append(base(1));
    store.append(base(2));
    expect(store.list().map(r => r.id)).toEqual(["r1", "r2"]);
  });

  it("개수를 넘으면 오래된 것부터, 기간이 지난 것은 모두 지운다", () => {
    const dir   = mkdtempSync(path.join(tmpdir(), "parism-store-"));
    const store = new ReceiptStore(dir, { maxEntries: 2, maxAgeDays: 30 });
    store.append(base(0, "2020-01-01T00:00:00.000Z"));
    for (let i = 1; i <= 3; i++) store.append(base(i));
    expect(store.list().map(r => r.id)).toEqual(["r2", "r3"]);
  });

  it("깨진 줄은 건너뛴다", () => {
    const dir   = mkdtempSync(path.join(tmpdir(), "parism-store-"));
    const store = new ReceiptStore(dir, { maxEntries: 10, maxAgeDays: 30 });
    store.append(base(1));
    writeFileSync(store.file, readFileSync(store.file, "utf8") + "not json\n{\"id\":5}\n");
    expect(store.list().map(r => r.id)).toEqual(["r1"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
