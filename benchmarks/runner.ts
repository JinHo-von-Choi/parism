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
import type { Scenario, ScenarioResult, ExtractionResult } from "./types.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures");

/**
 * Computes accuracy by comparing extracted names against expected names.
 * Extracted names come from result.data — tries entries[].name pattern.
 * Returns 1.0 if no expectedNames (unvalidated = assumed correct).
 */
function computeAccuracy(
  result: ExtractionResult,
  expectedNames: string[] | undefined,
): number {
  if (!expectedNames || expectedNames.length === 0) return 1.0;
  if (!result.success || !result.data) return 0.0;

  // Try to extract names from the data array
  const data = result.data as Array<{ name?: string } | null>;
  if (!Array.isArray(data)) return 1.0;

  const extractedNames = data
    .filter(Boolean)
    .map(e => e?.name)
    .filter((n): n is string => typeof n === "string");

  const correctCount = expectedNames.filter(expected =>
    extractedNames.includes(expected)
  ).length;

  return correctCount / expectedNames.length;
}

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

  // Accuracy against ground truth (if expectedNames provided)
  const rawAccuracy      = computeAccuracy(rawExtraction, scenario.expectedNames);
  rawExtraction.accuracy = rawAccuracy;

  // WITH Parism: 파서가 null이면 실패
  const jsonStart      = Date.now();
  const jsonExtraction = {
    success:  parsed !== null,
    data:     parsed,
    timeMs:   Date.now() - jsonStart,
    errorMsg: parsed === null ? "parser returned null" : undefined,
  };
  const jsonAccuracy      = parsed !== null ? 1.0 : 0.0;
  jsonExtraction.accuracy = jsonAccuracy;  // satisfy ExtractionResult.accuracy

  // Projected cost assuming 1 retry on failure/inaccuracy
  // Formula: TOTAL × (1 + (1 - accuracy))
  const totalRaw  = rawOutputTokens  + rawContextTokens;
  const totalJson = jsonOutputTokens + jsonContextTokens;
  const rawProjectedCost  = Math.round(totalRaw  * (1 + (1 - rawAccuracy)));
  const jsonProjectedCost = Math.round(totalJson * (1 + (1 - jsonAccuracy)));

  return {
    name:        scenario.name,
    description: scenario.description,
    rawOutputTokens,
    jsonOutputTokens,
    rawContextTokens,
    jsonContextTokens,
    rawExtraction,
    jsonExtraction,
    rawAccuracy,
    jsonAccuracy,
    rawProjectedCost,
    jsonProjectedCost,
  };
}
