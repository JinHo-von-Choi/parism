/**
 * 단일 추출 시도 결과.
 */
export interface ExtractionResult {
  success:   boolean;
  data:      unknown;
  timeMs:    number;
  errorMsg?: string;
  accuracy?: number;  // 0~1. undefined = not measured. 1.0 = all items correct.
}

/**
 * 단일 시나리오의 비교 결과.
 */
export interface ScenarioResult {
  name:              string;
  description:       string;

  // 출력 토큰 수
  rawOutputTokens:   number;
  jsonOutputTokens:  number;

  // LLM이 올바른 추출을 하도록 안내하는 프롬프트 토큰 수
  rawContextTokens:  number;
  jsonContextTokens: number;

  // 추출 신뢰성
  rawExtraction:     ExtractionResult;
  jsonExtraction:    ExtractionResult;

  rawAccuracy:  number;  // 0~1. 1.0 if no expectedNames provided (assume correct)
  jsonAccuracy: number;  // 0~1. 1.0 if parsed !== null, 0 otherwise

  // Parsed-only mode: agent reads ONLY stdout.parsed (not the raw field in envelope)
  // This represents the optimized production usage pattern
  jsonParsedOnlyTokens: number;  // tokens for parsed output only (no raw duplication)

  // Dollar cost estimates for 1000 agent calls (GPT-4o input pricing: $2.50/1M tokens)
  dollarCostRaw:            number;  // raw 모드 1000회 호출 비용 ($)
  dollarCostJsonFull:       number;  // Parism full 모드 1000회 비용 ($)
  dollarCostJsonParsedOnly: number;  // Parism parsed-only 모드 1000회 비용 ($)

  // Critical Failure Rate: raw 파싱 오류율 × riskLevel 가중치 (0~1)
  cfr: number;

  // E2E 실행 시간 (ms)
  execTimeMs: number;

  /**
   * without Parism일 때 LLM 추론이 raw 텍스트를 파싱하는 데 소요하는 추정 시간.
   * GPT-4o TTFT 기준: 500ms (base) + context 크기 비례.
   * with Parism: deterministic 코드 파싱 = 0ms.
   */
  estimatedRawParseMs: number;
}

/**
 * 전체 벤치마크 실행 결과.
 */
export interface BenchmarkReport {
  runAt:     string;
  scenarios: ScenarioResult[];
  summary: {
    totalRawTokens:          number;
    totalJsonTokens:         number;
    rawSuccessRate:          number;
    jsonSuccessRate:         number;
    avgCfr:                  number;
    totalDollarCostRaw:      number;
    totalDollarCostParsedOnly: number;
    avgExecTimeMs:           number;
  };
}

/**
 * 시나리오 정의.
 */
export interface Scenario {
  name:        string;
  description: string;

  /**
   * 시나리오의 리스크 레벨.
   * CFR 계산 시 가중치로 사용: catastrophic=1.0, major=0.5, minor=0.1, none=0.0
   */
  riskLevel?: "catastrophic" | "major" | "minor" | "none";

  /** raw fixture 파일명 (benchmarks/fixtures/ 기준) */
  fixturePath: string;

  /** raw 출력에서 정보 추출 시도 (regex 기반 시뮬레이션) */
  extractRaw:  (raw: string) => ExtractionResult;

  /** raw 파싱을 위해 LLM에 전달해야 하는 컨텍스트 안내 프롬프트 */
  rawContextPrompt: string;

  /** JSON 사용 시 LLM에 전달하는 컨텍스트 안내 프롬프트 */
  jsonContextPrompt: string;

  /** Optional args passed to the Parism parser registry. Needed for subcommand-based parsers (e.g., git log → ["log"]) */
  parserArgs?: string[];
  /**
   * Ground truth: expected extracted item names for accuracy validation.
   * If provided, runner computes accuracy by comparing extractRaw result
   * against this list.
   */
  expectedNames?: string[];
}
