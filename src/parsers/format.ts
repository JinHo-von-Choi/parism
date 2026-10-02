/**
 * 파서 계약의 형식 선언 해석.
 * 앞쪽 전역 옵션을 건너뛰고 서브커맨드 낱말로 계약을 고른 뒤, 나머지 인자를
 * 허용 플래그(acceptedFlags)와 위치 인자 규칙(acceptedPositionals)으로 검사한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ParserContract } from "./registry.js";

/**
 * 플래그 값 방식.
 * bool: 값을 받지 않는다. value: 붙은 값(--x=v, -xv) 또는 다음 인자를 값으로 받는다.
 * attached: 붙은 값만 받으며 값 없이도 쓸 수 있다(--color=never, -U0).
 */
export type FlagArity = "bool" | "value" | "attached";

/** 위치 인자 규칙. 조건을 생략하면 제한하지 않는다. */
export interface PositionalRule {
  min?:     number;
  max?:     number;
  /** 모든 위치 인자가 일치해야 하는 패턴 */
  pattern?: RegExp;
}

/** 형식 검사 결과 */
export interface FormatVerdict {
  accepted: boolean;
  /** 서브커맨드를 반영한 유효 계약 */
  contract: ParserContract;
  /** 거부 사유. accepted=false일 때만 있다. */
  reason?:  string;
}

/** 숫자 축약 플래그(-5)의 선언 이름 */
export const NUMBER_FLAG = "-<number>";

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
export function skipLeadingFlags(contract: ParserContract, args: string[]): number {
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

/** 형식 선언(허용 플래그, 위치 인자 규칙, 서브커맨드)이 있는 계약인지 */
export function hasFormatDeclaration(contract: ParserContract): boolean {
  return contract.acceptedFlags !== undefined || contract.acceptedPositionals !== undefined || contract.subcommands !== undefined;
}

/** 인자에서 읽은 플래그 한 건 */
interface FlagUse {
  name:   string;
  value?: string;
}

/** 토큰화 결과. 선언 밖의 플래그를 만나면 rejected에 사유를 담고 멈춘다. */
interface Tokens {
  flags:       FlagUse[];
  positionals: string[];
  rejected?:   string;
}

function arityOf(flags: Readonly<Record<string, FlagArity>>, name: string): FlagArity | undefined {
  return Object.hasOwn(flags, name) ? flags[name] : undefined;
}

/**
 * 계약의 허용 플래그 표로 인자를 플래그와 위치 인자로 나눈다. 시간 복잡도는 인자 글자 수에 선형이다.
 * 단문자 묶음(-la)은 글자마다 나누고, 값을 받는 글자 뒤의 나머지는 그 값이다.
 */
function tokenize(contract: ParserContract, args: string[]): Tokens {
  const table  = contract.acceptedFlags ?? {};
  const out: Tokens = { flags: [], positionals: [] };
  const reject = (name: string): Tokens => ({ ...out, rejected: `flag '${name}' is not in the accepted set` });

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { out.positionals.push(...args.slice(i + 1)); break; }
    const plus = contract.plusFlags === true && arg.startsWith("+") && arg.length > 1;
    if (!plus && (!arg.startsWith("-") || arg === "-")) { out.positionals.push(arg); continue; }

    if (plus || arg.startsWith("--")) {
      const eq    = arg.indexOf("=");
      const name  = eq >= 0 ? arg.slice(0, eq) : arg;
      const value = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const arity = arityOf(table, name);
      if (!arity || (arity === "bool" && value !== undefined)) return reject(arg);
      if (arity === "value" && value === undefined) out.flags.push({ name, value: args[++i] });
      else out.flags.push({ name, value });
      continue;
    }
    const whole = arityOf(table, arg);
    if (whole) {
      out.flags.push({ name: arg, value: whole === "value" ? args[++i] : undefined });
      continue;
    }
    if (/^-[0-9]+$/.test(arg)) {
      if (!arityOf(table, NUMBER_FLAG)) return reject(arg);
      out.flags.push({ name: NUMBER_FLAG, value: arg.slice(1) });
      continue;
    }
    if (contract.singleDashLong) return reject(arg);
    for (let j = 1; j < arg.length; j++) {
      const name  = `-${arg[j]}`;
      const arity = arityOf(table, name);
      if (!arity) return reject(name);
      if (arity === "bool") { out.flags.push({ name }); continue; }
      const attached = arg.slice(j + 1);
      out.flags.push({ name, value: attached !== "" || arity === "attached" ? attached : args[++i] });
      break;
    }
  }
  return out;
}

/**
 * args가 계약이 선언한 출력 형식 범위 안인지 검사한다.
 * 선언(acceptedFlags, acceptedPositionals, subcommands)이 없으면 받는다. supports가 있으면 선언 검사를 통과한 뒤 추가로 적용한다.
 */
export function checkFormat(contract: ParserContract, args: string[]): FormatVerdict {
  const resolved = resolveContract(contract, args);
  const eff      = resolved.contract;
  const reject   = (reason: string): FormatVerdict => ({ accepted: false, contract: eff, reason });

  if (contract.subcommands && resolved.subcommand === null) {
    return reject(`subcommand '${resolved.rest[0] ?? "(none)"}' is not supported`);
  }
  if (hasFormatDeclaration(eff)) {
    const tokens = tokenize(eff, resolved.rest);
    if (tokens.rejected) return reject(tokens.rejected);

    for (const f of tokens.flags) {
      const pattern = eff.acceptedValues && Object.hasOwn(eff.acceptedValues, f.name) ? eff.acceptedValues[f.name] : undefined;
      if (pattern && !pattern.test(f.value ?? "")) return reject(`value '${f.value ?? ""}' of '${f.name}' is not in the accepted set`);
    }
    const seen = new Set(tokens.flags.map(f => f.name));
    if (eff.requiredFlags && !eff.requiredFlags.some(n => seen.has(n))) {
      return reject(`one of ${eff.requiredFlags.join(", ")} is required`);
    }
    if (eff.exclusiveFlags && eff.exclusiveFlags.filter(n => seen.has(n)).length > 1) {
      return reject(`at most one of ${eff.exclusiveFlags.join(", ")} is accepted`);
    }
    const rule  = eff.acceptedPositionals;
    const count = tokens.positionals.length;
    if (rule?.max !== undefined && count > rule.max) return reject(`${count} positional argument(s), at most ${rule.max} accepted`);
    if (rule?.min !== undefined && count < rule.min) return reject(`${count} positional argument(s), at least ${rule.min} required`);
    const odd = rule?.pattern ? tokens.positionals.find(p => !rule.pattern!.test(p)) : undefined;
    if (odd !== undefined) return reject(`positional argument '${odd}' is not in the accepted form`);
  }
  if (eff.supports && !eff.supports(args)) return reject("arguments are outside the parser's custom format rule");
  return { accepted: true, contract: eff };
}
