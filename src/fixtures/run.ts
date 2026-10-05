/**
 * fixture 집합 replay 실행기 — `parism test` 가 부르는 경로.
 *
 * 계획서 8장: "capture → sanitized fixture → test → 결과 차이 → parser 변경의 영향을 한 경로로 확인한다."
 *
 * ## 왜 별도 실행기가 필요한가
 *
 * `runFixtureTests`(src/cli/test-runner.ts)는 **ParserPack 안의** fixture 를 되짚는다.
 * 그 경로는 그대로 두고, 여기서는 **manifest 파일로 저장된** fixture 를 되짚는다.
 * 새로 포장한 기능이 아니라 양쪽을 잇는 고리다 — pack fixture 와 manifest fixture 를
 * 같은 도구가 각각 되짚을 뿐, 판정 방식(변화 경로 목록)은 `replay.ts` 가 하나로 통일한다.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../parsers/index.js";
import { validateManifest, type FixtureManifest } from "./manifest.js";
import { formatChanges, replayManifest, type ReplayOptions, type ReplayResult } from "./replay.js";

export interface LoadedFixture {
  file: string;
  manifest?: FixtureManifest;
  /** 매니페스트가 깨졌으면 왜 깨졌는지. 조용히 건너뛰지 않는다. */
  error?: string;
}

export interface ReplayReport {
  total:     number;
  /** 매니페스트가 깨져서 되짚지 못한 것 */
  invalid:   number;
  /** 되짚었지만 사람이 검토한 기대값이 없는 것 */
  unreviewed: number;
  changed:   number;
  matched:   number;
  results:   ReplayResult[];
  invalidFixtures: LoadedFixture[];
  /** 승인된 fixture 집합에서 의도치 않은 계약 변화 수. 배포 판단에 쓰는 숫자다. */
  contractChanges: number;
}

/** 디렉터리에서 manifest 를 모두 읽는다. 깨진 것도 함께 돌려준다. */
export function loadFixtures(dir: string): LoadedFixture[] {
  const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  return files.map(file => {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      return { file, error: `JSON 을 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}` };
    }
    /** 구형 capture 출력처럼 매니페스트가 아니면 그 사실을 밝힌다 — 조용히 통과시키지 않는다. */
    if (raw === null || typeof raw !== "object" || !("manifest_version" in raw)) {
      return { file, error: "fixture 매니페스트 형식이 아니다 (manifest_version 없음) — parism capture 로 다시 받으면 이 형식이 된다" };
    }
    const parsed = validateManifest(raw);
    return parsed.ok && parsed.manifest
      ? { file, manifest: parsed.manifest }
      : { file, error: `매니페스트 검증 실패: ${parsed.issues.join("; ")}` };
  });
}

/**
 * 디렉터리 전체를 되짚는다.
 *
 * **기대값을 쓰지 않는다.** 되짚기는 읽기만 하고 이 함수 안에는 파일을 저장하는 경로가 없다.
 */
export function replayDirectory(dir: string, options: ReplayOptions = {}): ReplayReport {
  const registry = createRegistry();
  const loaded   = loadFixtures(dir);
  const invalidFixtures = loaded.filter(f => f.error !== undefined);
  const results: ReplayResult[] = [];

  for (const item of loaded) {
    if (!item.manifest) continue;
    results.push(replayManifest(item.manifest, registry, options));
  }

  const reviewed = results.filter(r => r.reviewed);
  return {
    total:      loaded.length,
    invalid:    invalidFixtures.length,
    unreviewed: results.filter(r => !r.reviewed).length,
    changed:    reviewed.filter(r => r.status === "changed").length,
    matched:    reviewed.filter(r => r.status === "match").length,
    results,
    invalidFixtures,
    /** 검토된 기대값에서 나온 변화만 센다 — 미검토 기대값의 불일치는 '계약 위반'이 아니다. */
    contractChanges: reviewed.reduce((sum, r) => sum + r.changes, 0),
  };
}

/** 사람이 읽는 요약. 통과 여부 하나가 아니라 무엇이 얼마 변했는지 보여 준다. */
export function formatReport(report: ReplayReport, limit = 20): string {
  const lines: string[] = [];
  lines.push(`fixture ${report.total}개`);
  lines.push(`  검토된 기대값 ${report.matched + report.changed}개 중 일치 ${report.matched} · 변화 ${report.changed}`);
  lines.push(`  미검토 기대값 ${report.unreviewed}개 (사람이 검토해야 계약이 된다)`);
  lines.push(`  매니페스트 오류 ${report.invalid}개`);

  if (report.invalidFixtures.length > 0) {
    lines.push("");
    lines.push("읽지 못한 fixture:");
    for (const f of report.invalidFixtures) lines.push(`  ${f.file}  ${f.error}`);
  }

  const changed = report.results.filter(r => r.reviewed && r.status === "changed");
  if (changed.length > 0) {
    lines.push("");
    lines.push(`의도치 않은 계약 변화 ${report.contractChanges}건 — 이걸 확인하기 전에는 배포 판정을 하지 않는다:`);
    for (const r of changed) {
      lines.push(`  ${r.id}  (${r.command})`);
      lines.push(...formatChanges(r, limit));
    }
  }

  if (report.unreviewed > 0) {
    lines.push("");
    lines.push("미검토 기대값 (기계는 이걸 '계약 위반'으로 세지 않는다):");
    for (const r of report.results.filter(x => !x.reviewed)) {
      lines.push(`  ${r.id}  (${r.command})  ${r.changes}건 차이 — expected.reviewed_by 를 채워 검토한 뒤 다시 본다`);
    }
  }

  return lines.join("\n");
}
