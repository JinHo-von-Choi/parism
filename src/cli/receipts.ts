/**
 * `parism receipts` 명령. 영수증을 읽어 완료 조건을 판정하거나 목록을 보여 준다.
 * 명령을 실행하지 않는다. Stop 훅, CI, 리뷰 봇이 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import path from "node:path";
import { loadConfig, loadConfigMultiLayer, DEFAULT_RECEIPTS, type PrismConfig } from "../config/loader.js";
import { ReceiptStore, checkReceipts, loadSigningKey, type CheckReport, type Receipt } from "../engine/receipts.js";
import { parismHome } from "./paths.js";

export interface ReceiptsCheckOptions {
  /** 판정할 작업 공간. 기본값은 현재 디렉터리다. */
  cwd?:     string;
  /** 판정할 명령. 주지 않으면 설정의 verify.commands를 쓴다. 각 항목은 [명령, 인자...]다. */
  require?: string[][];
  /** 설정 파일 경로. 주지 않으면 전역·프로젝트·환경 변수 설정을 읽는다. */
  config?:  string;
}

/**
 * `--require` 값 하나를 명령과 인자로 나눈다.
 * JSON 배열(`["npx","vitest","run"]`)이면 그대로 쓰고, 아니면 공백으로 나눈다.
 * 공백이 든 인자는 JSON 배열로 줘야 한다.
 */
export function parseRequire(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string" && p !== "")) {
      throw new Error(`--require ${value}: expected a non-empty JSON array of strings`);
    }
    return parsed as string[];
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("--require needs a command");
  return parts;
}

function storeFor(config: PrismConfig): ReceiptStore {
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  return new ReceiptStore(path.join(parismHome(), "receipts"), { maxEntries: receipts.max_entries, maxAgeDays: receipts.max_age_days });
}

async function configFor(configPath: string | undefined): Promise<PrismConfig> {
  return configPath ? loadConfig(configPath) : loadConfigMultiLayer();
}

/**
 * 완료 조건을 판정한다. 판정할 명령이 하나도 없으면 통과가 아니라 오류다.
 * 명령이 없다는 이유로 통과시키면 설정이 빠진 환경이 항상 통과한다.
 */
export async function receiptsCheck(options: ReceiptsCheckOptions = {}): Promise<CheckReport | { ok: false; error: string }> {
  const config   = await configFor(options.config);
  const commands = options.require && options.require.length > 0 ? options.require : config.verify?.commands ?? [];
  if (commands.length === 0) {
    return { ok: false, error: "no commands to check: give --require or set verify.commands in the host config" };
  }
  const receipts = config.receipts ?? DEFAULT_RECEIPTS;
  const signing  = loadSigningKey(receipts.key_file, config.guard.allowed_paths);
  if (receipts.key_file && !signing.key) {
    return { ok: false, error: signing.warning ?? "the signing key could not be loaded" };
  }
  return checkReceipts({
    receipts: storeFor(config).list(),
    commands,
    cwd:      options.cwd ?? process.cwd(),
    limits:   { untrackedMaxFiles: receipts.untracked_max_files, untrackedMaxBytes: receipts.untracked_max_bytes },
    ...(signing.key && { key: signing.key }),
  });
}

/** 최근 영수증을 새것부터 돌려준다. */
export async function receiptsList(options: { limit?: number; config?: string } = {}): Promise<Receipt[]> {
  const all = storeFor(await configFor(options.config)).list();
  return all.slice(Math.max(0, all.length - (options.limit ?? 20))).reverse();
}

/** 판정 결과를 사람이 읽는 줄로 만든다. */
export function formatCheck(report: CheckReport): string {
  const lines = report.items.map(i => `${i.verdict === "ok" ? "ok  " : "FAIL"} ${i.command.join(" ")}  [${i.verdict}] ${i.detail}`);
  lines.push(report.ok ? "all required commands have a passing, fresh receipt" : "one or more required commands lack a passing, fresh receipt");
  return lines.join("\n");
}
