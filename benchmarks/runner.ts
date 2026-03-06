/**
 * 단일 시나리오 실행기.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-06
 */

import { readFile }                        from "node:fs/promises";
import path                                from "node:path";
import { fileURLToPath }                   from "node:url";
import { countTokens, countJsonTokens }    from "./tokenizer.js";
import { defaultRegistry }                 from "../src/parsers/index.js";
import type { Scenario, ScenarioResult }   from "./types.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures");

/**
 * 단일 시나리오를 실행하고 비교 결과를 반환한다.
 *
 * Without Parism: raw fixture text + regex extraction (extractRaw)
 * With Parism:    Parism parser registry produces structured JSON
 */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  // 픽스처 로드
  const fixturePath = path.join(FIXTURE_DIR, scenario.fixturePath);
  const raw         = await readFile(fixturePath, "utf-8");

  // cmd 추출: 픽스처 파일명에서 첫 단어 사용 (ls-normal.txt → "ls")
  const cmd = path.basename(scenario.fixturePath).split("-")[0] ?? "unknown";

  // Parism JSON 파싱
  const parsed     = defaultRegistry.parse(cmd, scenario.parserArgs ?? [], raw, { maxItems: 0 });
  const jsonOutput = { stdout: { raw, parsed } };

  // 토큰 측정
  const rawOutputTokens   = countTokens(raw);
  const jsonOutputTokens  = countJsonTokens(jsonOutput);
  const rawContextTokens  = countTokens(scenario.rawContextPrompt);
  const jsonContextTokens = countTokens(scenario.jsonContextPrompt);

  // WITHOUT Parism: regex 기반 raw 추출 (LLM 텍스트 파싱 시뮬레이션)
  const rawExtraction = scenario.extractRaw(raw);

  // WITH Parism: 파서가 null이면 실패
  const jsonStart      = Date.now();
  const jsonExtraction = {
    success:  parsed !== null,
    data:     parsed,
    timeMs:   Date.now() - jsonStart,
    errorMsg: parsed === null ? "parser returned null" : undefined,
  };

  return {
    name:        scenario.name,
    description: scenario.description,
    rawOutputTokens,
    jsonOutputTokens,
    rawContextTokens,
    jsonContextTokens,
    rawExtraction,
    jsonExtraction,
  };
}
