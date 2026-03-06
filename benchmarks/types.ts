/**
 * 단일 추출 시도 결과.
 */
export interface ExtractionResult {
  success:   boolean;
  data:      unknown;
  timeMs:    number;
  errorMsg?: string;
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
}

/**
 * 전체 벤치마크 실행 결과.
 */
export interface BenchmarkReport {
  runAt:     string;
  scenarios: ScenarioResult[];
  summary: {
    totalRawTokens:  number;
    totalJsonTokens: number;
    rawSuccessRate:  number;
    jsonSuccessRate: number;
  };
}

/**
 * 시나리오 정의.
 */
export interface Scenario {
  name:        string;
  description: string;

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
}
