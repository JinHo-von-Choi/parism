/**
 * fixture 정제 — 계획서 8장 "정제본" 요구와 "자동으로 사용자 원문을 서버에 업로드하지 않는다".
 *
 * ## 왜 이게 없었으면 위험한가
 *
 * `parism capture` 는 실행 출력을 **그대로** JSON 에 적어 디스크에 남겼다.
 * `kubectl get pods -o wide`, `systemctl status`, `df` 같은 출력에는 호스트명, 사용자 홈 경로,
 * 내부 IP, 심하면 토큰이 그대로 섞여 나온다. 그 파일을 이슈에 붙이거나 저장소에 커밋하는 순간
 * 원문이 그대로 퍼진다.
 *
 * 이 모듈은 저장하기 **전에** 정제하고, 무엇을 가렸는지를 manifest 에 남긴다.
 * 지운 흔적이 없으면 나중에 '원래 없던 것인지 가린 것인지' 구분할 수 없어 검증 자체가 무의미해진다.
 *
 * ## 가린 뒤에도 검증은 된다
 *
 * 민감한 값은 **형태는 남기고 값만 바꾼다**. 토큰의 앞뒤 문맥, 치환 표시자가 그대로여서
 * "이 fixture 가 정말 그 명령의 출력처럼 생겼는가" 를 눈으로 확인할 수 있다.
 * 통째로 지우면 fixture 가 조립된 것이 되어 검증 가치가 사라진다.
 *
 * 이 정제는 서버로 아무것도 보내지 않는다. 로컬 파일 안에서 끝난다.
 */

import { homedir } from "node:os";
import { REDACTED_TOKEN } from "../engine/mask-map.js";
import type { FixtureRedaction } from "./manifest.js";

/** 기본 가림 규칙. 순서가 의미다 — 먼저 걸린 규칙이 값을 차지한다. */
export interface SanitizeRule {
  kind:     FixtureRedaction["kind"];
  pattern:  string | RegExp;
  /** 치환 결과. 기본은 표시자 하나. */
  replace?: string;
}

export interface SanitizeOptions {
  /** 이 값은 절대 원문에 쓰이지 않는다 — 홈 경로는 여기서 온다. */
  home?:       string;
  /** 사용자 추가 규칙. 기본 규칙 뒤에 적용된다. */
  extraRules?: SanitizeRule[];
}

/**
 * 가린 구간 하나.
 *
 * `MaskedRange` 와 모양이 비슷하지만 다른 일을 한다 — 거기 `maskedLength` 는
 * 좌표 대응용이고, 여기 `replacement` 는 **무엇으로 바꿨는지** 다.
 * 정제된 텍스트를 되돌릴 수 있어야 출처를 눈으로 확인할 수 있다.
 */
export interface SanitizeRange {
  start:       number;
  end:         number;
  replacement: string;
}

export interface SanitizeResult {
  text:       string;
  redactions: FixtureRedaction[];
  ranges:     SanitizeRange[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 기본 규칙.
 *
 * 집에 따라서 값이 달라져야 한다 — 그래야 같은 fixture 를 여러 사람이 돌려도 결과가 같다.
 * 홈 경로는 사용자 이름이 새 기회에 새 정보가 되므로 `~` 로 접는다.
 */
export function defaultRules(home: string): SanitizeRule[] {
  return [
    /** 1. 시크릿성 토큰. 값만 `[REDACTED]` 로 바꾸고 앞뒤 문맥은 남긴다. */
    {
      kind: "secret",
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9\-_]{16,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g,
    },
    /** 2. 사용자 홈 경로. */
    { kind: "home_path", pattern: escapeRegExp(home), replace: "~" },
    /** 3. `--token=값` 류. 인자에 붙은 시크릿은 따로 표시한다 — '인자에 시크릿이 있었나'가 알려야 한다. */
    { kind: "argv_secret", pattern: /\b(--?(?:token|password|passwd|secret|api[-_]?key|auth)(?:=|\s+))(\S+)/gi, replace: `$1${REDACTED_TOKEN}` },
  ];
}

/** 원문 문자열에서 규칙이 맞는 구간을 전부 찾는다. */
function findRanges(text: string, rule: SanitizeRule): SanitizeRange[] {
  const source = typeof rule.pattern === "string" ? escapeRegExp(rule.pattern) : rule.pattern.source;
  const flags  = typeof rule.pattern === "string" ? "g" : (rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
  const re     = new RegExp(source, flags);
  const found: SanitizeRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    /** 빈 문자열 매치는 무한 루프가 된다 — 한 칸 밀고 계속한다. */
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    found.push({ start: m.index, end: m.index + m[0].length, replacement: rule.replace ?? REDACTED_TOKEN });
  }
  return found;
}

/** 같은 규칙이 같은 표시자로 몇 번 가렸는지 접는다. */
function tally(ranges: readonly SanitizeRange[], kind: FixtureRedaction["kind"]): FixtureRedaction[] {
  const counts = new Map<string, number>();
  for (const r of ranges) counts.set(r.replacement, (counts.get(r.replacement) ?? 0) + 1);
  return [...counts.entries()].map(([pattern, count]) => ({ kind, pattern, count }));
}

/**
 * 문자열 하나를 정제한다.
 *
 * **모든 규칙을 원문 기준으로 찾는다.** 앞에서 바꾼 문자열을 다음 규칙이 보면
 * 오프셋이 밀려 근거 span 이 어긋난다. 겹치는 구간에서는 앞선 규칙이 이긴다
 * (시크릿 문자열 안에 홈 경로가 들어 있는 경우처럼).
 */
export function sanitizeText(text: string, options: SanitizeOptions = {}): SanitizeResult {
  const home  = options.home ?? homedir();
  const rules = [...defaultRules(home), ...(options.extraRules ?? [])];

  const accepted: SanitizeRange[] = [];
  const redactions: FixtureRedaction[] = [];
  for (const rule of rules) {
    const hits = findRanges(text, rule).filter(c => !accepted.some(t => c.start < t.end && t.start < c.end));
    if (hits.length === 0) continue;
    accepted.push(...hits);
    redactions.push(...tally(hits, rule.kind));
  }

  /** 겹치지 않게 정렬한 뒤 **뒤에서부터** 바꾼다 — 앞쪽 오프셋이 밀리지 않는다. */
  const ordered = [...accepted].sort((a, b) => a.start - b.start);
  let out = text;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
  }

  return { text: out, redactions, ranges: ordered };
}

/**
 * argv 를 정제한다.
 *
 * 계획서 7장: "digest 도 비밀이 존재를 유출할 수 있으므로 보호된 세션 내부 식별과 표시용 마스킹을 분리한다."
 * argv 는 비교 키(identity)에도 들어가므로 **값을 지우면 비교가 깨진다**.
 * 그래서 시크릿으로 보이는 값은 원문을 `<redacted:길이>` 로 바꾸되 **길이를 남겨** 구별은 유지하고,
 * 어떤 인자가 가려졌는지는 표시만 남긴다. argv 전체를 해시로 대체하지는 않는다 —
 * 그러면 '무엇이 달라졌는지' 를 사람이 볼 수 없다.
 */
export function sanitizeArgs(args: readonly string[]): { args: string[]; redacted: boolean; redactions: FixtureRedaction[] } {
  const SECRETY = /^(?:--?(?:token|password|passwd|secret|api[-_]?key|auth)(?:=|$)|gh[pousr]_|glpat-|AKIA|eyJ)/i;
  const out: string[] = [];
  let count = 0;

  for (const a of args) {
    if (!SECRETY.test(a)) { out.push(a); continue; }
    count += 1;
    /** `=` 앞부분은 남긴다 — 어떤 옵션이었는지는 알아야 하고 값만 가린다. */
    const eq = a.indexOf("=");
    out.push(eq >= 0 ? `${a.slice(0, eq + 1)}<redacted:${a.length - eq - 1}>` : `<redacted:${a.length}>`);
  }
  return { args: out, redacted: count > 0, redactions: count > 0 ? [{ kind: "argv_secret", pattern: "argv", count }] : [] };
}
