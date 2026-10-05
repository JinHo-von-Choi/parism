/**
 * 실행 환경 지문(fingerprint).
 *
 * 두 결과를 비교해도 되는지 판단하려면 "같은 대상을 본 것인지"를 확인해야 한다.
 * 지문은 그 판단의 근거다. **지문은 세계 상태를 캡처한 인증서가 아니다.**
 * 같은 지문이어도 그 사이 파일이 바뀌었을 수 있고, 다른 지문이어도 같은 대상일 수 있다.
 *
 * 비밀 유출을 막는 두 가지 장치를 분리한다.
 *   - digest: 세션 내부에서 대상을 식별하기 위한 해시(공개하지 않는다)
 *   - masked: 표시용으로만 쓰는, 가린 값
 * argv 는 비밀을 담을 수 있으므로 해시로 식별하고 표시에는 마스킹한 값을 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Review } from "../evidence.js";

/** 사용자 컨텍스트(예: kubectl context). 사용자가 명시한 것만 담는다 */
export type UserContext = Readonly<Record<string, string>>;

/** 지문 */
export interface Fingerprint {
  cmd:             string;
  /** 대상을 가리키는 해시. argv 를 그대로 담지 않는다(비밀 포함 가능) */
  argv_hash:       string;
  /** 표시용 argv. 값은 마스킹한 형태다 */
  argv_masked:     string;
  /** 실제 경로로 펼친 작업 디렉터리. 심볼릭 링크를 따라가야 같은 저장소로 판정된다 */
  cwd_real:        string;
  /** 실행 때 실제로 적용된 가드 정책의 해시 */
  policy_hash:     string;
  parser_id:       string;
  schema_version:  string;
  content_hash:    string;
  platform:        { os: string; arch: string; node: string };
  /** 실제로 선택된 도구의 버전. 전부 담지 않는다(비교에 필요한 것만) */
  tools:           Readonly<Record<string, string>>;
  /** 허용한 locale */
  locale:          string[];
  context:         UserContext;
  /**
   * 관찰 기록. 동일성 비교 키에는 들어가지 않는다.
   * 환경 변수 '이름'만 담고 값은 담지 않는다 — 값이 새면 비밀이다.
   */
  observation:     { env_names: string[] };
}

/** 두 지문의 호환성 */
export type Compatibility =
  | "same"        // 완전히 같다
  | "compatible"  // 대상은 같고, 비교에 영향 없는 차이가 있다
  | "unknown"     // 판단할 수 없다
  | "incompatible";// 다른 대상이거나 비교가 성립하지 않는다

export interface CompatibilityVerdict {
  compatibility: Compatibility;
  /** comparable=false 면 왜 비교하지 않았는지 */
  reasons: string[];
  /** 무시해도 되는 차이(환경 차이 중 대상 동일성에 영향 없는 것) */
  ignored: string[];
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/** 심볼릭 링크를 따라 실제 경로로 편다. 같은 디렉터리를 경유 경로가 달라도 같게 판정해야 한다. */
export function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** argv 를 표시용으로만 안전하게 만든다. 값이 비밀처럼 보이면 가린다. */
export function maskArgv(args: string[]): string {
  return args
    .map(arg => {
      /** key=value 형태에서 값이 비밀로 보이는 경우만 가린다. 값은 읽어 담지 않는다 */
      const eq = arg.indexOf("=");
      if (eq > 0) {
        const key = arg.slice(0, eq);
        /** 값은 담지 않는다. 키 이름이 비밀로 보이면 통째로 가린다 */
        if (/(token|secret|password|passwd|key|credential|auth)/i.test(key)) return `${key}=[REDACTED]`;
      }
      if (arg.startsWith("-") && arg.length > 40) return `${arg.slice(0, 12)}…`;
      return arg;
    })
    .join(" ");
}

export interface FingerprintInput {
  cmd:        string;
  args:       string[];
  cwd:        string;
  /** 실행 때 실제로 쓰인 가드 정책. 해시로만 남긴다 */
  policy:     unknown;
  review:     Review;
  /** 비교에 필요한 도구 버전(예: git). */
  tools?:     Readonly<Record<string, string>>;
  context?:   UserContext;
  env?:       NodeJS.ProcessEnv;
}

export function buildFingerprint(input: FingerprintInput): Fingerprint {
  const argv = [input.cmd, ...input.args];
  return {
    cmd:            input.cmd,
    argv_hash:      hashOf(argv.join("\0")),
    argv_masked:    maskArgv(input.args),
    cwd_real:       realCwd(input.cwd),
    policy_hash:    hashOf(stableStringify(input.policy)),
    parser_id:      input.review.parser_id,
    schema_version: input.review.schema_version,
    content_hash:   input.review.content_hash,
    platform:       { os: process.platform, arch: process.arch, node: process.versions.node },
    tools:          input.tools ?? {},
    locale:         ["LC_ALL", "LANG"].map(k => `${k}=${process.env[k] ?? ""}`),
    context:        input.context ?? {},
    observation:    { env_names: Object.keys(input.env ?? {}).sort() },
  };
}

/** 객체의 키 순서와 무관하게 같은 문자열을 만든다. 정책 비교에 쓴다. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * 두 지문을 비교한다.
 * OS 나 파서 버전이 달라졌다고 모든 비교를 막지는 않는다 — 규칙으로 나눈다.
 * 판단할 수 없으면 'unknown' 이다. unknown 에서 strict 비교는 거절한다.
 */
export function compareFingerprints(
  base: Fingerprint, current: Fingerprint, opts: { strict?: boolean } = {},
): CompatibilityVerdict {
  const reasons: string[] = [];
  const ignored: string[] = [];

  /** 대상이 달라야 비교가 무의미하다. 여기서 '같아야 한다'가 진짜 동일성의 기준이다. */
  if (base.cmd !== current.cmd) {
    return { compatibility: "incompatible", reasons: [`different command: '${base.cmd}' vs '${current.cmd}'`], ignored };
  }
  if (base.argv_hash !== current.argv_hash) {
    return {
      compatibility: "incompatible",
      reasons: [`different arguments: '${base.argv_masked}' vs '${current.argv_masked}'`],
      ignored,
    };
  }
  if (base.cwd_real !== current.cwd_real) {
    return {
      compatibility: "incompatible",
      reasons: [`different working directory: '${base.cwd_real}' vs '${current.cwd_real}'`],
      ignored,
    };
  }
  if (base.parser_id !== current.parser_id) {
    return { compatibility: "incompatible", reasons: [`different parser: '${base.parser_id}' vs '${current.parser_id}'`], ignored };
  }
  if (base.context && current.context) {
    const baseCtx = stableStringify(base.context);
    const curCtx  = stableStringify(current.context);
    if (baseCtx !== curCtx) {
      /**
       * 사용자 컨텍스트가 다르면 '같은 이름의 다른 자원'을 같은 것으로 보게 될 수 있다.
       * 표 출력에 uid 가 없을 때 특히 위험하다. 성립한다고 가정하지 않는다.
       */
      return { compatibility: "unknown", reasons: [`different user context: ${baseCtx} vs ${curCtx}`], ignored };
    }
  }

  /** 아래부터는 대상 동일성은 맞았다. 남은 차이는 등급을 나눠 판단한다. */
  if (base.schema_version !== current.schema_version) {
    return { compatibility: "unknown", reasons: [`schema version differs: ${base.schema_version} vs ${current.schema_version}`], ignored };
  }
  if (base.policy_hash !== current.policy_hash) {
    ignored.push("guard policy differs (it can change what is visible)");
  }
  if (base.platform.os !== current.platform.os || base.platform.arch !== current.platform.arch) {
    ignored.push(`platform differs (${base.platform.os}/${base.platform.arch} vs ${current.platform.os}/${current.platform.arch})`);
  }
  if (stableStringify(base.tools) !== stableStringify(current.tools)) {
    if (opts.strict) {
      return { compatibility: "unknown", reasons: ["tool versions differ and strict mode forbids assuming they are equivalent"], ignored };
    }
    ignored.push(`tool versions differ (${stableStringify(base.tools)} vs ${stableStringify(current.tools)})`);
  }
  if (stableStringify(base.locale) !== stableStringify(current.locale)) {
    ignored.push("locale differs (output text may be translated)");
  }
  if (base.content_hash === current.content_hash) {
    return { compatibility: "same", reasons, ignored };
  }
  return { compatibility: "compatible", reasons, ignored };
}
