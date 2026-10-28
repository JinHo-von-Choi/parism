/**
 * 정규식 엔진 바이트 동일성 검증.
 *
 * ## 무엇을 확인하는가
 *
 * Rust 정규식 엔진을 켜도 **출력이 한 바이트도 달라지지 않는다.**
 * 계획서 TASK-027 의 요구다. 이 모듈은 그 비교를 수행한다.
 *
 * ## 왜 별도 모듈인가
 *
 * 비교는 **두 엔진의 출력을 바이트로 나란히 놓는 것**이라 결과가 눈에 보이지 않는다.
 * "같다" 와 "비교할 것이 없었다" 는 전혀 다른 두 상태인데, 둘 다 테스트는 통과한다.
 *
 * 그래서 이 모듈은 **비교가 실제로 의미 있었는지**도 함께 센다.
 *
 * - `rustEngaged` — Rust 엔진이 실제로 처리한 연산 수. 0 이면 Rust 를 못 쓴 것이다.
 * - `redactions` — 실제로 뭔가를 가린 횟수. 0 이면 패턴이 한 번도 안 걸린 것이다.
 *
 * 둘 다 0 인 검사는 "통과" 가 아니라 **검증 실패** 다. 호출하는 쪽이 그걸 확인해야 한다.
 *
 * ## 코퍼스
 *
 * 1. **파서 팩 fixture** — `parism test` 이 되짚는 바로 그 데이터다. 계약이므로 손대지 않는다.
 * 2. **manifest fixture** — 사람이 캡처해 저장한 것이다. 있으면 함께 쓴다.
 * 3. **비밀 섞은 변형** — 1·2 의 원본에 비밀 형태 문자열을 덧붙인 파생 항목.
 *
 * 3번이 있는 이유를 실측으로 적는다:
 *
 *   `parism test` 코퍼스 27 fixture / 2,591 바이트에 **기본 리댁션 패턴은 한 번도 걸리지 않는다**(실측).
 *   즉 원본만 비교하면 Rust 활성/비활성 결과가 **처음부터 같아서** 통과한다.
 *   통과한 것이 아니라 **비교할 것이 없었다** 는 뜻이다.
 *   변형은 원본을 바꾸지 않는다 — 파생 항목으로 따로 세고 원본도 그대로 비교한다.
 *
 * ## 좌표계
 *
 * Rust 엔진은 **바이트 오프셋**을 준다. JavaScript 문자열 인덱스는 UTF-16 코드유닛이다.
 * 변환은 `regex-engine.ts` 가 한다. 여기서는 그 결과만 비교한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join }                                    from "node:path";

import { createRegistry }                           from "../parsers/index.js";
import { defaultFixturesDir }                       from "../cli/paths.js";
import { sanitizeText }                             from "../fixtures/sanitize.js";
import { DEFAULT_OUTPUT_REDACT_PATTERNS, redact }  from "./redactor.js";
import { maskWithRanges }                           from "./mask-map.js";
import {
  findAllRanges,
  replaceAllText,
  type RegexFallback,
} from "./regex-engine.js";
import { resolveNativeBinary }                      from "./regex-native.js";

/** 비교에서 어긋난 항목 하나. */
export interface ByteIdentityMismatch {
  /** 무엇을 비교했는지. */
  label:  string;
  /** 어긋난 지점 주변의 원문. */
  sample: string;
}

/** 검증 결과. */
export interface ByteIdentityReport {
  /** 코퍼스 크기. */
  corpus: {
    /** 파서 팩 fixture 수. */
    packFixtures:     number;
    /** manifest fixture 수. */
    manifestFixtures: number;
    /** 비밀 섞은 파생 항목 수. */
    derived:          number;
  };
  /** 바이트 단위 비교 횟수. */
  comparisons:  number;
  /** 비교한 총 바이트 수. */
  bytes:        number;
  /** 불일치. **비어 있어야 한다.** */
  mismatches:   ByteIdentityMismatch[];
  /** Rust 엔진이 실제로 처리한 연산 수. 0 이면 검증이 무의미하다. */
  rustEngaged:  number;
  /** Rust 가 거절해 TypeScript 로 되돌아간 사실. */
  fallbacks:    RegexFallback[];
  /** 실제로 뭔가를 가린 횟수. 0 이면 비교가 무의미하다. */
  redactions:   number;
  /** Rust 바이너리를 쓸 수 있었는지. */
  nativeAvailable: boolean;
}

/** 코퍼스 항목 하나. */
export interface CorpusItem {
  /** 무엇인지. */
  label: string;
  /** 비교할 텍스트. */
  text:  string;
}

/**
 * 비밀 형태 문자열을 담은 실제 명령 출력 조각.
 *
 * `systemctl show` 의 `Environment=` 줄, `curl -v` 의 `Authorization:` 헤더,
 * `aws configure list` 의 키 줄을 그대로 본떴다.
 *
 * **BMP 밖 문자(U+1F389) 를 일부러 넣었다.** Rust 는 바이트 오프셋을 주고
 * JavaScript 는 UTF-16 인덱스를 준다. 이 문자가 없으면 좌표 변환이 틀려도
 * 바이트 비교가 우연히 맞아 버린다.
 */
export const SECRET_CANARY_BLOCK = [
  "Environment=OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
  "github_token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  "slack_webhook: xoxb-1234567890-abcdefghij",
  "gitlab_token: glpat-ABCDEFGHIJKLMNOPQRST",
  "--token=abcdef123456",
  "--password=hunter2",
  "home=/home/사람이름/src",
  "비밀 키 🔑 값 emoji",
  "café naïve İstanbul ı ſecret",
  "빈 줄 앞",
  "",
  "빈 줄 뒤",
].join("\n");

/**
 * 차등 시험에 쓰는 패턴 목록.
 *
 * 기본 리댁션 패턴과 겹치지만 정규식 엔진의 **다른 경로**(문자 클래스, 단어 경계,
 * 비어 있는 매칭, 역참조, lookaround)를 건다. 역참조와 lookaround 는 Rust 가
 * 거절하고 TypeScript 로 되돌아가는 경로를 확인한다.
 */
export const DIFFERENTIAL_PATTERNS: string[] = [
  ...DEFAULT_OUTPUT_REDACT_PATTERNS,
  "\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9\\-_]{16,}|AKIA[0-9A-Z]{16})\\b",
  "\\b(--?(?:token|password|passwd|secret|api[-_]?key|auth)(?:=|\\s+))(\\S+)",
  "\\d+",
  "\\w+",
  "\\s+",
  "\\S+",
  "[a-z\\d]+",
  "[^\\s]+",
  ".+",
  ".*",
  "a.c",
  "\\bfoo\\b",
  "\\Bfoo",
  "[\\w.-]+@[\\w.-]+",
  "x{2,}",
  "(?<name>\\w+)",
  "[\\b]",
  "(a)\\1",
  "(?=a)",
  "(?<=a)",
];

/** 엔진 모드를 강제로 바꾼다. 되돌릴 때 원래 값을 정확히 복구한다. */
async function withEngine<T>(mode: "rust" | "typescript", fn: () => Promise<T>): Promise<T> {
  const before = process.env.PARISM_REGEX_ENGINE;
  process.env.PARISM_REGEX_ENGINE = mode;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PARISM_REGEX_ENGINE;
    else process.env.PARISM_REGEX_ENGINE = before;
  }
}

/** 파서 팩의 fixture 입력. `parism test` 이 되짚는 바로 그 데이터다. */
export function packFixtureCorpus(): CorpusItem[] {
  const registry = createRegistry();
  const items: CorpusItem[] = [];
  for (const name of registry.listPacks()) {
    const pack = registry.getPack(name);
    for (const fixture of pack?.fixtures ?? []) {
      items.push({ label: `pack:${name}`, text: fixture.input });
    }
  }
  return items;
}

/**
 * manifest fixture 의 stdout. 사람이 캡처해 저장한 것이다.
 *
 * 디렉터리가 없으면 빈 목록이다 — fixture 를 캡처하지 않은 집도 정상이다.
 */
export function manifestCorpus(dir: string = defaultFixturesDir()): CorpusItem[] {
  if (!existsSync(dir)) return [];
  const items: CorpusItem[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as { stdout?: unknown };
      if (typeof raw.stdout !== "string") continue;
      items.push({ label: `manifest:${file}`, text: raw.stdout });
    } catch {
      /** 깨진 manifest 는 `parism test` 가 따로 밝힌다. 여기서는 조용히 세지 않는다. */
    }
  }
  return items;
}

/** 두 문자열의 바이트가 다르면 어긋난 지점 주변을 알려 준다. */
function describeDifference(label: string, rust: string, typescript: string): ByteIdentityMismatch {
  const rustBytes = Buffer.from(rust, "utf8");
  const tsBytes   = Buffer.from(typescript, "utf8");
  let at = 0;
  const max = Math.min(rustBytes.length, tsBytes.length);
  while (at < max && rustBytes[at] === tsBytes[at]) at++;
  const start = Math.max(0, at - 20);
  return {
    label,
    sample:
      `바이트 ${at} 부근에서 갈랐다 (rust ${rustBytes.length} 바이트 / typescript ${tsBytes.length} 바이트)\n` +
      `  rust      : ${JSON.stringify(rust.slice(start, at + 20))}\n` +
      `  typescript: ${JSON.stringify(typescript.slice(start, at + 20))}`,
  };
}

/**
 * 두 산출물의 바이트를 비교한다. 같으면 null.
 *
 * 다르면 **어디서 갈라졌는지** 를 알려 준다 — 사람이 그 지점을 바로 찾아볼 수 있어야 한다.
 */
export function compareArtifacts(label: string, rust: string, typescript: string): ByteIdentityMismatch | null {
  const rustBytes = Buffer.from(rust, "utf8");
  const tsBytes   = Buffer.from(typescript, "utf8");
  if (rustBytes.equals(tsBytes)) return null;
  return describeDifference(label, rust, typescript);
}

/**
 * 한 코퍼스 항목에 파이프라인 단계를 적용한 결과의 **직렬화**.
 *
 * 텍스트만 비교하면 안 된다. 마스킹 구간이 틀리면 **근거 바이트 구간**이 틀어지므로
 * 그 결과가 조용히 나간다. 구간과 리댁션 기록도 바이트로 비교한다.
 */
async function pipelineArtifact(
  text:  string,
  stage: "redact" | "mask" | "sanitize",
  home:  string,
  opts?: { onFallback?: (info: RegexFallback) => void },
): Promise<{ artifact: string; redactions: number }> {
  if (stage === "redact") {
    const out = await redact(text, DEFAULT_OUTPUT_REDACT_PATTERNS, opts);
    return { artifact: out, redactions: countMatches(text, DEFAULT_OUTPUT_REDACT_PATTERNS) };
  }
  if (stage === "mask") {
    const out = await maskWithRanges(text, DEFAULT_OUTPUT_REDACT_PATTERNS, opts);
    return {
      artifact: `${out.text}\u0000${JSON.stringify(out.ranges)}`,
      redactions: out.count,
    };
  }
  const out = await sanitizeText(text, { home, engine: opts });
  return {
    artifact: `${out.text}\u0000${JSON.stringify({ redactions: out.redactions, ranges: out.ranges })}`,
    redactions: out.redactions.reduce((sum, r) => sum + r.count, 0),
  };
}

/** 패턴이 몇 번 걸리는지 센다. 비교가 의미 있었는지 확인하는 데 쓴다. */
function countMatches(text: string, patterns: readonly string[]): number {
  let count = 0;
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        count += 1;
      }
    } catch {
      /** 유효하지 않은 패턴은 `validatePatterns` 가 따로 밝힌다. */
    }
  }
  return count;
}

/** 한 모드에서 실행할 작업. 결과의 직렬화와 엔진 이름을 돌려준다. */
type Runner = (onFallback?: (info: RegexFallback) => void) => Promise<{
  artifact:   string;
  redactions: number;
  engine?:    string;
}>;

/**
 * 정규식 엔진 바이트 동일성을 검증한다.
 *
 * ## 반환값의 해석
 *
 * - `mismatches` 가 비어 있고 `rustEngaged` 와 `redactions` 가 양수면 **검증이 성공했다.**
 * - `mismatches` 가 비어 있는데 `rustEngaged` 가 0 이면 **검증하지 못했다.** Rust 가 한 번도 안 돌아갔다.
 * - `mismatches` 가 비어 있는데 `redactions` 가 0 이면 **비교할 것이 없었다.** 패턴이 한 번도 안 걸렸다.
 */
export async function verifyByteIdentity(options: {
  /** 홈 경로. 정제 규칙의 기준이 된다. */
  home?:         string;
  /** manifest fixture 디렉터리. 없으면 기본값. */
  manifestDir?:  string;
} = {}): Promise<ByteIdentityReport> {
  const home      = options.home ?? "/home/사람이름";
  const fallbacks: RegexFallback[] = [];
  const seen      = new Set<string>();
  const noteFallback = (info: RegexFallback) => {
    /** 같은 사유가 hundreds 번 반복된다 — 패턴과 사유로 접는다. */
    const key = `${info.pattern}\u0000${info.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    fallbacks.push(info);
  };

  const packs     = packFixtureCorpus();
  const manifests = manifestCorpus(options.manifestDir);
  const base      = [...packs, ...manifests];

  /** 비밀 섞은 파생 항목. 원본은 그대로 두고 따로 세는다. */
  const derived: CorpusItem[] = base.map(item => ({
    label: `${item.label}+canary`,
    text:  item.text.length > 0 ? `${item.text}\n${SECRET_CANARY_BLOCK}` : SECRET_CANARY_BLOCK,
  }));

  const mismatches: ByteIdentityMismatch[] = [];
  let comparisons = 0;
  let bytes       = 0;
  let redactions  = 0;
  let rustEngaged = 0;

  /**
   * 두 엔진의 결과를 바이트로 비교한다.
   *
   * 두 모드는 **순차로** 돌린다. env 하나를 공유하므로 동시에 돌리면 섞인다.
   */
  const compareBoth = async (label: string, run: Runner): Promise<void> => {
    const ts   = await withEngine("typescript", () => run(undefined));
    const rust = await withEngine("rust", () => run(noteFallback));
    comparisons += 1;
    bytes += Buffer.byteLength(ts.artifact, "utf8") + Buffer.byteLength(rust.artifact, "utf8");
    redactions += Math.max(ts.redactions, rust.redactions);
    if (rust.engine === "rust") rustEngaged += 1;
    const diff = compareArtifacts(label, rust.artifact, ts.artifact);
    if (diff) mismatches.push(diff);
  };

  /** 1. 파이프라인 단계 — redactor·mask-map·sanitize 를 항목마다 비교한다. */
  for (const item of [...base, ...derived]) {
    for (const stage of ["redact", "mask", "sanitize"] as const) {
      await compareBoth(`${item.label}/${stage}`, async onFallback => {
        const out = await pipelineArtifact(item.text, stage, home, { onFallback });
        return { artifact: out.artifact, redactions: out.redactions };
      });
    }
  }

  /** 2. 엔진 연산 — 패턴 × 텍스트 조합을 직접 비교한다. */
  const engineTexts = [
    ...new Set([...base, ...derived].map(i => i.text)),
    "",
    SECRET_CANARY_BLOCK,
  ];
  for (const pattern of DIFFERENTIAL_PATTERNS) {
    /** JavaScript 에서도 유효하지 않은 패턴은 건너뛴다. */
    try { new RegExp(pattern, "g"); } catch { continue; }

    for (const text of engineTexts) {
      await compareBoth(`find/${pattern}`, async onFallback => {
        const res = await findAllRanges(pattern, text, "g", { onFallback });
        return { artifact: JSON.stringify(res.value), redactions: 0, engine: res.engine };
      });

      await compareBoth(`replace/${pattern}`, async onFallback => {
        const res = await replaceAllText(pattern, text, "[R]", "g", true, { onFallback });
        return { artifact: res.value, redactions: 0, engine: res.engine };
      });
    }
  }

  return {
    corpus: {
      packFixtures:     packs.length,
      manifestFixtures: manifests.length,
      derived:          derived.length,
    },
    comparisons,
    bytes,
    mismatches,
    rustEngaged,
    fallbacks,
    redactions,
    nativeAvailable: resolveNativeBinary() !== undefined,
  };
}
