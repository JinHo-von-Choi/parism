/**
 * 영수증 해시 체인과 서명 시험. 줄을 고치거나 지우거나 끼워 넣으면 찾아야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHAIN_GENESIS, ReceiptStore, loadSigningKey, sha256, signReceipt, verifyChain, type Receipt } from "../../src/engine/receipts.js";

function receipt(n: number): Receipt {
  return {
    id: `rcp_${n}`, cmd: "npx", args: ["vitest", "run"], cwd: "/w", exit_code: 0,
    started_at: new Date(Date.now() + n).toISOString(), duration_ms: 1, output_sha256: "0".repeat(64),
  };
}

function store(): { dir: string; s: ReceiptStore; key: Buffer } {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-chain-"));
  const s   = new ReceiptStore(dir, { maxEntries: 100, maxAgeDays: 30 });
  const key = Buffer.alloc(32, 7);
  for (let i = 1; i <= 4; i++) s.append(receipt(i), r => signReceipt(r, key));
  return { dir, s, key };
}

describe("영수증 체인", () => {
  it("남긴 그대로면 체인과 서명이 맞다", () => {
    const { dir, s, key } = store();
    const lines = s.rawLines();
    expect(JSON.parse(lines[0]!).prev).toBe(CHAIN_GENESIS);
    expect(JSON.parse(lines[1]!).prev).toBe(sha256(lines[0]!));
    expect(verifyChain(lines, key)).toMatchObject({ ok: true, entries: 4, signed: true, problems: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  it("줄 하나를 고치면 그 줄의 서명과 다음 줄의 prev가 틀린다", () => {
    const { dir, s, key } = store();
    const lines = s.rawLines();
    lines[1] = lines[1]!.replace('"exit_code":0', '"exit_code":1');
    const r = verifyChain(lines, key);
    expect(r.ok).toBe(false);
    expect(r.problems.map(p => [p.line, p.reason])).toEqual([[2, "bad_signature"], [3, "chain_broken"]]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("가운데 줄을 지우거나 줄을 끼워 넣으면 체인이 끊긴다", () => {
    const { dir, s, key } = store();
    const lines = s.rawLines();
    expect(verifyChain([lines[0]!, lines[2]!, lines[3]!], key).problems.map(p => p.reason)).toEqual(["chain_broken"]);
    /** 키 없이 다시 만든 영수증은 prev를 맞춰도 서명이 없다 */
    const forged = JSON.stringify({ ...receipt(9), prev: sha256(lines[3]!) });
    expect(verifyChain([...lines, forged], key).problems.map(p => p.reason)).toEqual(["unsigned"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("보관 한도로 앞 줄을 지운 뒤에도 남은 체인은 맞다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-chain-"));
    const s   = new ReceiptStore(dir, { maxEntries: 3, maxAgeDays: 30 });
    for (let i = 1; i <= 6; i++) s.append(receipt(i));
    const lines = s.rawLines();
    expect(lines).toHaveLength(3);
    expect(verifyChain(lines).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("자동 서명 키", () => {
  it("없으면 0600 권한으로 만들고, 다음에는 같은 키를 읽는다", () => {
    const dir  = mkdtempSync(path.join(tmpdir(), "parism-key-"));
    const file = path.join(dir, "keys", "receipts.key");
    const first = loadSigningKey(undefined, ["/nonexistent-allowed"], file);
    expect(first.created).toBe(true);
    expect(first.key).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = loadSigningKey(undefined, ["/nonexistent-allowed"], file);
    expect(again.key?.equals(first.key!)).toBe(true);
    expect(again.created).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("가드가 읽을 수 있는 경로 안이면 쓰지 않는다", () => {
    const dir  = mkdtempSync(path.join(tmpdir(), "parism-key-"));
    const file = path.join(dir, "receipts.key");
    const r    = loadSigningKey(undefined, [dir], file);
    expect(r.key).toBeUndefined();
    expect(r.warning).toMatch(/allowed_paths/);
    writeFileSync(file, "x");
    expect(readFileSync(file, "utf8")).toBe("x");
    rmSync(dir, { recursive: true, force: true });
  });
});
