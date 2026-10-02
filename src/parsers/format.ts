/**
 * 파서 계약의 서브커맨드 해석.
 * 앞쪽 전역 옵션을 건너뛰고 서브커맨드 낱말로 계약을 고른다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ParserContract } from "./registry.js";

/** 서브커맨드 해석 결과 */
export interface ResolvedContract {
  /** 상위 계약에 서브커맨드 계약을 덧씌운 결과. subcommands는 포함하지 않는다. */
  contract:   ParserContract;
  /** 일치한 서브커맨드 키. 서브커맨드 선언이 없거나 일치하지 않으면 null */
  subcommand: string | null;
  /** 서브커맨드 낱말 다음부터의 인자 */
  rest:       string[];
}

/** 앞쪽 전역 옵션(leadingFlags)을 건너뛴 위치 */
function skipLeadingFlags(contract: ParserContract, args: string[]): number {
  const flags = contract.leadingFlags;
  if (!flags) return 0;
  let i = 0;
  while (i < args.length) {
    const arg  = args[i]!;
    const eq   = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const kind = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (!kind) break;
    i += kind === "value" && eq < 0 ? 2 : 1;
  }
  return Math.min(i, args.length);
}

/**
 * args에 맞는 서브커맨드 계약을 찾아 상위 계약에 덧씌운다.
 * 키는 공백으로 이은 낱말이며 낱말이 많은 키를 먼저 맞춘다. 빈 문자열 키는 서브커맨드 없이 실행한 경우다.
 */
export function resolveContract(contract: ParserContract, args: string[]): ResolvedContract {
  const { subcommands, ...base } = contract;
  const start = skipLeadingFlags(contract, args);
  if (!subcommands) return { contract: base, subcommand: null, rest: args.slice(start) };

  const keys = Object.keys(subcommands).filter(k => k !== "").sort((a, b) => b.split(" ").length - a.split(" ").length);
  for (const key of keys) {
    const words = key.split(" ");
    if (words.every((w, j) => args[start + j] === w)) {
      return { contract: { ...base, ...subcommands[key] }, subcommand: key, rest: args.slice(start + words.length) };
    }
  }
  const bare = args[start] === undefined || args[start]!.startsWith("-");
  if (bare && Object.hasOwn(subcommands, "")) {
    return { contract: { ...base, ...subcommands[""] }, subcommand: "", rest: args.slice(start) };
  }
  return { contract: base, subcommand: null, rest: args.slice(start) };
}
