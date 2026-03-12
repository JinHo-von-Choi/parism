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

/** GPT-4o input token price: $2.50 per 1M tokens */
const GPT4O_INPUT_PRICE_PER_TOKEN = 2.50 / 1_000_000;
/** Cost estimate base: 1000 agent calls */
const COST_ESTIMATE_CALLS = 1_000;

/**
 * LLM이 raw 텍스트를 파싱하는 데 소요하는 추정 추론 시간 모델.
 * - base: GPT-4o TTFT 기준 500ms
 * - context penalty: 100토큰당 1ms (context 크기 비례 처리 시간)
 * with Parism은 deterministic code이므로 항상 0ms.
 */
const PARSE_CALL_BASE_MS    = 500;  // GPT-4o TTFT baseline (ms)
const PARSE_MS_PER_100_TKNS = 1;    // context size penalty (ms per 100 tokens)

/**
 * 1000회 호출 기준 달러 비용 계산 (GPT-4o input pricing).
 */
function calcDollarCost(tokens: number): number {
  return parseFloat((tokens * COST_ESTIMATE_CALLS * GPT4O_INPUT_PRICE_PER_TOKEN).toFixed(4));
}

/** CFR 계산 시 riskLevel별 가중치 */
const RISK_WEIGHT: Record<string, number> = {
  catastrophic: 1.0,
  major:        0.5,
  minor:        0.1,
  none:         0.0,
};

/**
 * Critical Failure Rate 계산.
 * CFR = errorRate × riskWeight
 */
function computeCfr(errorRate: number, riskLevel: string | undefined): number {
  const weight = RISK_WEIGHT[riskLevel ?? "none"] ?? 0;
  return parseFloat((errorRate * weight).toFixed(4));
}

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
  const execStart = Date.now();

  // 픽스처 로드
  const fixturePath = path.join(FIXTURE_DIR, scenario.fixturePath);
  const raw         = await readFile(fixturePath, "utf-8");

  // cmd 추출: 픽스처 파일명에서 첫 단어 사용 (ls-normal.txt → "ls")
  const cmd = path.basename(scenario.fixturePath).split("-")[0] ?? "unknown";

  // Parism JSON 파싱
  const parseResult = defaultRegistry.parse(cmd, scenario.parserArgs ?? [], raw, { maxItems: 0 });
  const jsonOutput  = { stdout: { raw, parsed: parseResult.parsed } };

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
  const parsed         = parseResult.parsed;
  const jsonStart      = Date.now();
  const jsonExtraction = {
    success:  parsed !== null,
    data:     parsed,
    timeMs:   Date.now() - jsonStart,
    errorMsg: parsed === null ? "parser returned null" : undefined,
  };
  const jsonAccuracy      = parsed !== null ? 1.0 : 0.0;
  jsonExtraction.accuracy = jsonAccuracy;  // satisfy ExtractionResult.accuracy

  // 토큰 합계
  const totalRaw  = rawOutputTokens  + rawContextTokens;
  const totalJson = jsonOutputTokens + jsonContextTokens;

  // Parsed-only mode: agent reads only stdout.parsed (not the raw envelope field)
  // Represents the real cost when LLM context only receives structured output
  const jsonParsedOnlyTokens = parsed !== null ? countJsonTokens(parsed) : jsonOutputTokens;
  const totalJsonParsedOnly  = jsonParsedOnlyTokens + jsonContextTokens;

  // Dollar cost estimates (1000 calls × GPT-4o input pricing)
  const dollarCostRaw            = calcDollarCost(totalRaw);
  const dollarCostJsonFull       = calcDollarCost(totalJson);
  const dollarCostJsonParsedOnly = calcDollarCost(totalJsonParsedOnly);

  // Critical Failure Rate: errorRate × riskWeight
  const cfr = computeCfr(1 - rawAccuracy, scenario.riskLevel);

  // LLM 추론 기반 파싱 추정 시간 (without Parism)
  // Parism은 deterministic code이므로 0ms
  const estimatedRawParseMs =
    PARSE_CALL_BASE_MS + Math.round(totalRaw / 100 * PARSE_MS_PER_100_TKNS);

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
    jsonParsedOnlyTokens,
    dollarCostRaw,
    dollarCostJsonFull,
    dollarCostJsonParsedOnly,
    cfr,
    execTimeMs:          Date.now() - execStart,
    estimatedRawParseMs,
  };
}
