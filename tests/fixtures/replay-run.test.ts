/**
 * fixture 되짚기(`parism test`) 시험. 실제 명령을 capture해 만든 manifest로 되짚는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCommand } from "../../src/cli/capture.js";
import { formatReport, loadFixtures, replayDirectory, replayRegisteredPacks } from "../../src/fixtures/run.js";
import type { ParserPack } from "../../src/parsers/registry.js";
import { createRegistry } from "../../src/parsers/index.js";
import { z } from "zod";

let dir: string;
let work: string;

beforeAll(async () => {
  dir  = mkdtempSync(path.join(tmpdir(), "parism-fx-"));
  work = mkdtempSync(path.join(tmpdir(), "parism-fx-work-"));
  writeFileSync(path.join(work, "a.txt"), "alpha\n");
  writeFileSync(path.join(work, "b.txt"), "beta\n");
  const cwd = process.cwd();
  process.chdir(work);
  try {
    await captureCommand("ls", ["-l", work], dir);
  } finally {
    process.chdir(cwd);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function manifestFile(): string {
  return path.join(dir, readdirSync(dir).find(f => f.endsWith(".json"))!);
}

describe("replayDirectory", () => {
  it("기대값이 없는 capture는 미검토로 센다", () => {
    const report = replayDirectory(dir);
    expect(report).toMatchObject({ total: 1, invalid: 0, unreviewed: 1, changed: 0, contractChanges: 0 });
    expect(formatReport(report)).toMatch(/미검토 기대값 1개/);
  });

  it("검토된 기대값이 실제 파싱과 같으면 일치, 다르면 계약 변화다", () => {
    const file     = manifestFile();
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const first    = replayDirectory(dir).results[0]!;
    expect(first.reviewed).toBe(false);

    /** 지금 파서가 내는 값을 기대값으로 적고 검토자를 남긴다 */
    const parsed = createRegistry().parseWithFallback(manifest.tool.command, manifest.tool.args, manifest.stdout, { maxItems: 0, format: "json" }).parsed;
    writeFileSync(file, JSON.stringify({ ...manifest, expected: { parsed, reviewed_by: "tester" } }));
    expect(replayDirectory(dir)).toMatchObject({ matched: 1, changed: 0, contractChanges: 0 });

    /** 기대값의 파일 이름 하나를 바꾸면 되짚기가 그 차이를 계약 변화로 보고한다 */
    const altered = structuredClone(parsed) as { entries: { name: string }[] };
    altered.entries[0]!.name = "renamed.txt";
    writeFileSync(file, JSON.stringify({ ...manifest, expected: { parsed: altered, reviewed_by: "tester" } }));
    const changed = replayDirectory(dir);
    expect(changed.changed).toBe(1);
    expect(changed.contractChanges).toBeGreaterThan(0);
    expect(formatReport(changed, 5)).toMatch(/의도치 않은 계약 변화/);
    writeFileSync(file, JSON.stringify(manifest));
  });

  it("깨진 JSON과 매니페스트가 아닌 파일을 이유와 함께 알린다", () => {
    writeFileSync(path.join(dir, "zz-broken.json"), "{ nope");
    writeFileSync(path.join(dir, "zz-legacy.json"), JSON.stringify({ input: "x", expected: {} }));
    const loaded = loadFixtures(dir);
    expect(loaded.filter(f => f.error).map(f => f.file)).toEqual(["zz-broken.json", "zz-legacy.json"]);
    const report = replayDirectory(dir);
    expect(report.invalid).toBe(2);
    expect(formatReport(report)).toMatch(/읽지 못한 fixture/);
    rmSync(path.join(dir, "zz-broken.json"));
    rmSync(path.join(dir, "zz-legacy.json"));
  });
});

describe("replayRegisteredPacks", () => {
  it("격리 팩은 건너뛴 사유를, 읽지 못한 팩은 오류를, fixture 있는 팩은 되짚은 결과를 낸다", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "parism-fx-home-"));
    writeFileSync(path.join(home, "registry.json"), JSON.stringify({
      isolated: { path: "/x", isolation: "worker" },
      broken:   { path: "/nonexistent" },
      empty:    { path: "/empty" },
      good:     { path: "/good" },
    }));
    const good: ParserPack = {
      name: "good", commands: ["echo"], version: "1.0.0",
      schema: z.object({ words: z.array(z.string()) }),
      parse: (raw: string) => ({ words: raw.trim().split(/\s+/) }),
      fixtures: [
        { input: "a b\n", args: [], expected: { words: ["a", "b"] } },
        { input: "c\n", args: [], expected: { words: ["x"] } },
      ],
    } as unknown as ParserPack;
    const report = await replayRegisteredPacks(async p => {
      if (p === "/good") return good;
      if (p === "/empty") return { ...good, fixtures: [] } as unknown as ParserPack;
      throw new Error("no such pack");
    }, home);
    const by = Object.fromEntries(report.results.map(r => [r.name, r]));
    expect(by.isolated).toMatchObject({ status: "not_replayable" });
    expect(by.broken).toMatchObject({ status: "not_replayable", reason: expect.stringContaining("no such pack") });
    expect(by.empty).toMatchObject({ status: "no_fixtures" });
    expect(by.good).toMatchObject({ status: "replayed", total: 2, passed: 1, failed: 1 });
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(3);
    rmSync(home, { recursive: true, force: true });
  });
});
