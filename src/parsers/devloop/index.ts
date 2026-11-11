/**
 * 개발 루프 명령(시험 러너, 컴파일러, 린터)의 파서와 형식 규칙.
 *
 * 러너를 직접 부른 실행만 다룬다: `vitest …`, `npx vitest …`.
 * `npm test`, `npm run <스크립트>`는 어떤 러너가 어떤 형식으로 출력할지 정해져 있지 않아 다루지 않는다.
 *
 * 러너마다 기계용 출력 형식이 있고, 그 형식으로 실행했을 때만 파싱한다.
 * machineFormatArgs()는 그 형식으로 실행하는 인자를 만든다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError, type ParseContext, type ParserContract, type ParserFn } from "../registry.js";
import type { HintDraft } from "../format.js";
import { parseJestReport } from "./jest-format.js";
import { parseTsc }        from "./tsc.js";
import { parseEslint }     from "./eslint.js";
import { CargoTestProgress, parseCargoBuild, parseCargoTest } from "./cargo.js";
import { parseJunitXml }   from "./junit.js";
import { GoTestProgress, parseGoTest } from "./gotest.js";
import { parseMypy, parseRuff } from "./python-lint.js";
import { cargoBuildEvidence, cargoTestEvidence, goTestEvidence, mypyEvidence, tscEvidence } from "./evidence.js";
import type { RawEvidence } from "../../engine/evidence.js";
import type { DevloopReport } from "./types.js";

export type { DevloopReport, TestReport, DiagnosticReport, TestFailure, Diagnostic } from "./types.js";

/**
 * 기계용 형식 인자.
 * args       -- 호출자 인자에 형식 플래그를 더한 인자. 가드 검사를 받고 응답에 실린다.
 * reportFlag -- 보고서를 파일로만 쓰는 러너에서, Parism이 정한 임시 파일 경로로 보고서를 받는 인자를 만든다.
 *               이 인자는 가드 검사 뒤 실행 직전에 붙이고, 실행이 끝나면 그 파일을 읽어 파싱한 뒤 지운다.
 */
export interface MachineArgs {
  args:        string[];
  reportFlag?: (file: string) => string[];
}

interface RunnerSpec {
  /** 결과의 행 배열 키 */
  rowsKey: "failures" | "diagnostics";
  /** rest가 파싱할 수 있는 기계용 형식으로 실행하는 인자인지 */
  supports(rest: readonly string[]): boolean;
  /**
   * rest를 기계용 형식으로 바꾼 인자. 이미 그 형식이면 그대로, 바꿀 수 없으면 null.
   */
  machine(rest: readonly string[]): MachineArgs | null;
  parse(raw: string, ctx?: ParseContext): DevloopReport | null;
  /** 실행 중 출력으로 진행 상태를 세는 추적기. 줄 단위로 결과를 내는 러너에만 있다. */
  progress?(): RunnerProgress;
  /** 결과의 값이 원문의 어느 구간에서 왔는지. 줄 단위 형식의 러너에만 있다(evidence.ts). */
  evidence?(raw: string): RawEvidence;
}

/** 실행 중인 러너의 진행 상태 추적기. 표준 출력 조각을 받아 지금까지의 결과를 센다. */
export interface RunnerProgress {
  push(text: string): void;
  snapshot(): unknown;
}

/** 플래그 값을 읽는다. `--name=값`과 `--name 값`을 모두 본다. 플래그가 없으면 undefined, 값이 없으면 "". */
function flagValues(args: readonly string[], ...names: string[]): string[] | undefined {
  const values: string[] = [];
  let   seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name) {
        seen = true;
        values.push(args[i + 1] !== undefined && !args[i + 1]!.startsWith("-") ? args[i + 1]! : "");
      } else if (arg.startsWith(`${name}=`)) {
        seen = true;
        values.push(arg.slice(name.length + 1));
      }
    }
  }
  return seen ? values : undefined;
}

function hasAny(args: readonly string[], ...names: string[]): boolean {
  return args.some(a => names.includes(a) || names.some(n => a.startsWith(`${n}=`)));
}

const VITEST: RunnerSpec = {
  rowsKey: "failures",
  supports(rest) {
    const reporters = flagValues(rest, "--reporter");
    return reporters !== undefined && reporters.length === 1 && reporters[0] === "json" && !hasAny(rest, "--outputFile");
  },
  machine(rest) {
    const reporters = flagValues(rest, "--reporter");
    if (reporters && (reporters.length !== 1 || reporters[0] !== "json")) return null;
    if (hasAny(rest, "--outputFile")) return null;
    return {
      args:       [...rest, ...(reporters ? [] : ["--reporter=json"])],
      /** vitest 5의 json 리포터는 표준 출력이 아니라 파일에 쓴다. 보고서를 임시 파일로 받는다. */
      reportFlag: file => [`--outputFile=${file}`],
    };
  },
  parse(raw) {
    const report = parseJestReport("vitest", raw);
    if (report === null && /JSON report written to /.test(raw)) {
      throw new UnrecognizedOutputError(
        "vitest wrote the JSON report to a file instead of stdout; run it with contract_version \"next\" and machine_format true",
      );
    }
    return report;
  },
};

const JEST: RunnerSpec = {
  rowsKey: "failures",
  supports: rest => rest.includes("--json") && !hasAny(rest, "--outputFile"),
  machine:  rest => hasAny(rest, "--outputFile") ? null : { args: rest.includes("--json") ? [...rest] : [...rest, "--json"] },
  parse:    raw  => parseJestReport("jest", raw),
};

/** tsc의 --pretty 값. 값 없이 쓰면 켠 것이다. */
function prettyOn(rest: readonly string[]): boolean {
  const pretty = flagValues(rest, "--pretty");
  return pretty !== undefined && pretty.some(v => v !== "false");
}

const TSC: RunnerSpec = {
  rowsKey: "diagnostics",
  supports: rest => !prettyOn(rest) && !hasAny(rest, "--watch", "-w"),
  machine(rest) {
    if (hasAny(rest, "--watch", "-w") || prettyOn(rest)) return null;
    return { args: flagValues(rest, "--pretty") ? [...rest] : [...rest, "--pretty", "false"] };
  },
  parse: (raw, ctx) => parseTsc(raw, ctx),
  evidence: tscEvidence,
};

function eslintFormat(rest: readonly string[]): string[] | undefined {
  return flagValues(rest, "--format", "-f");
}

const ESLINT: RunnerSpec = {
  rowsKey: "diagnostics",
  supports(rest) {
    const format = eslintFormat(rest);
    return format !== undefined && format.every(f => f === "json") && !hasAny(rest, "--output-file", "-o");
  },
  machine(rest) {
    if (hasAny(rest, "--output-file", "-o")) return null;
    const format = eslintFormat(rest);
    if (format && !format.every(f => f === "json")) return null;
    return { args: format ? [...rest] : [...rest, "--format", "json"] };
  },
  parse: (raw, ctx) => parseEslint(raw, ctx),
};

/** libtest의 기본 텍스트 출력만 읽는다. 출력 형식을 바꾸는 인자가 있으면 받지 않는다. */
function cargoTestTextOutput(rest: readonly string[]): boolean {
  return !hasAny(rest, "--message-format", "--format", "-q", "--quiet", "--list", "--no-run");
}

const CARGO_TEST: RunnerSpec = {
  rowsKey:  "failures",
  supports: cargoTestTextOutput,
  machine:  rest => cargoTestTextOutput(rest) ? { args: [...rest] } : null,
  parse:    raw  => parseCargoTest(raw),
  progress: ()   => new CargoTestProgress(),
  evidence: cargoTestEvidence,
};

function cargoMessageFormat(rest: readonly string[]): string[] | undefined {
  return flagValues(rest, "--message-format");
}

const CARGO_BUILD: RunnerSpec = {
  rowsKey: "diagnostics",
  supports(rest) {
    const format = cargoMessageFormat(rest);
    return format !== undefined && format.every(f => f === "json");
  },
  machine(rest) {
    const format = cargoMessageFormat(rest);
    if (format && !format.every(f => f === "json")) return null;
    return { args: format ? [...rest] : [...rest, "--message-format=json"] };
  },
  parse: (raw, ctx) => parseCargoBuild(raw, ctx),
  evidence: cargoBuildEvidence,
};

/**
 * pytest는 표준 출력에 기계용 형식이 없다. 보고서를 JUnit XML 파일로 받는다.
 * 호출자가 --junitxml을 직접 줬으면 그 파일로 가므로 바꾸지 않는다.
 */
const PYTEST: RunnerSpec = {
  rowsKey:  "failures",
  supports: rest => !hasAny(rest, "--junitxml", "--junit-xml", "--collect-only", "--co"),
  machine:  rest => hasAny(rest, "--junitxml", "--junit-xml", "--collect-only", "--co")
    ? null : { args: [...rest], reportFlag: file => [`--junitxml=${file}`] },
  parse(raw) {
    const report = parseJunitXml("pytest", raw);
    if (report === null && raw.trim() !== "") {
      throw new UnrecognizedOutputError("pytest printed its text report; run it with contract_version \"next\" and machine_format true to get a parsed result");
    }
    return report;
  },
};

const GO_TEST: RunnerSpec = {
  rowsKey:  "failures",
  supports: rest => rest.includes("-json") && !hasAny(rest, "-c", "-list"),
  machine:  rest => hasAny(rest, "-c", "-list") ? null : { args: rest.includes("-json") ? [...rest] : ["-json", ...rest] },
  parse:    raw  => parseGoTest(raw),
  progress: ()   => new GoTestProgress(),
  evidence: goTestEvidence,
};

function outputFormat(rest: readonly string[], ...names: string[]): string[] | undefined {
  return flagValues(rest, ...names);
}

const RUFF_CHECK: RunnerSpec = {
  rowsKey: "diagnostics",
  supports(rest) {
    const format = outputFormat(rest, "--output-format");
    return format !== undefined && format.every(f => f === "json") && !hasAny(rest, "--output-file", "-o", "--watch", "-w");
  },
  machine(rest) {
    if (hasAny(rest, "--output-file", "-o", "--watch", "-w")) return null;
    const format = outputFormat(rest, "--output-format");
    if (format && !format.every(f => f === "json")) return null;
    return { args: format ? [...rest] : [...rest, "--output-format=json"] };
  },
  parse: (raw, ctx) => parseRuff(raw, ctx),
};

const MYPY: RunnerSpec = {
  rowsKey: "diagnostics",
  supports(rest) {
    const format = outputFormat(rest, "--output", "-O");
    return format !== undefined && format.every(f => f === "json");
  },
  machine(rest) {
    const format = outputFormat(rest, "--output", "-O");
    if (format && !format.every(f => f === "json")) return null;
    return { args: format ? [...rest] : [...rest, "--output=json"] };
  },
  parse: (raw, ctx) => parseMypy(raw, ctx),
  evidence: mypyEvidence,
};

const RUNNERS: Readonly<Record<string, RunnerSpec>> = {
  vitest: VITEST, jest: JEST, tsc: TSC, eslint: ESLINT, pytest: PYTEST, mypy: MYPY,
};

/** 서브커맨드로 러너를 정하는 명령 */
const SUBCOMMAND_RUNNERS: Readonly<Record<string, Readonly<Record<string, RunnerSpec>>>> = {
  cargo: { test: CARGO_TEST, build: CARGO_BUILD, check: CARGO_BUILD },
  go:    { test: GO_TEST },
  ruff:  { check: RUFF_CHECK },
};

const CARGO_SUBCOMMANDS = SUBCOMMAND_RUNNERS.cargo!;

/** 개발 루프 파서가 다루는 cargo 서브커맨드 */
export const DEVLOOP_CARGO_SUBCOMMANDS = Object.keys(CARGO_SUBCOMMANDS);

/**
 * 개발 루프 파서가 등록되는 명령 이름. npx는 첫 위치 인자가 러너일 때만, go와 ruff는 해당 서브커맨드일 때만 다룬다.
 * cargo는 기존 cargo 파서와 함께 등록하므로 여기에 넣지 않는다.
 */
export const DEVLOOP_COMMANDS = [...Object.keys(RUNNERS), "npx", "go", "ruff"] as const;

interface ResolvedRunner {
  name:   string;
  spec:   RunnerSpec;
  /** 러너 이름 앞의 인자(npx의 옵션과 러너 이름). 직접 실행이면 비어 있다. */
  prefix: string[];
  /** 러너에 넘어가는 인자 */
  rest:   string[];
}

/** cmd와 args가 가리키는 러너를 찾는다. npx는 옵션을 건너뛴 첫 위치 인자를 러너 이름으로 본다. */
export function resolveRunner(cmd: string, args: readonly string[]): ResolvedRunner | null {
  const subcommands = Object.hasOwn(SUBCOMMAND_RUNNERS, cmd) ? SUBCOMMAND_RUNNERS[cmd] : undefined;
  if (subcommands) {
    /** `+toolchain`과 옵션을 건너뛴 첫 낱말이 서브커맨드다. */
    const at = args.findIndex(a => !a.startsWith("-") && !a.startsWith("+"));
    if (at < 0) return null;
    const sub  = args[at]!;
    const spec = Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
    return spec ? { name: `${cmd} ${sub}`, spec, prefix: args.slice(0, at + 1), rest: args.slice(at + 1) } : null;
  }
  if (cmd !== "npx") {
    const spec = Object.hasOwn(RUNNERS, cmd) ? RUNNERS[cmd] : undefined;
    return spec ? { name: cmd, spec, prefix: [], rest: [...args] } : null;
  }
  const at = args.findIndex(a => !a.startsWith("-"));
  if (at < 0) return null;
  const name = args[at]!;
  const spec = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined;
  return spec ? { name, spec, prefix: args.slice(0, at + 1), rest: args.slice(at + 1) } : null;
}

/**
 * 러너를 기계용 형식으로 실행하는 인자를 만든다.
 * 러너가 아니거나 바꿀 수 없으면(다른 형식을 이미 지정함, 결과를 파일로 보냄) null이다.
 */
export function machineFormatArgs(cmd: string, args: readonly string[]): MachineArgs | null {
  const runner = resolveRunner(cmd, args);
  if (!runner) return null;
  const machine = runner.spec.machine(runner.rest);
  return machine ? { args: [...runner.prefix, ...machine.args], ...(machine.reportFlag && { reportFlag: machine.reportFlag }) } : null;
}

/** 이 실행의 결과 종류. 러너가 아니면 undefined. */
export function devloopRowsKey(cmd: string, args: readonly string[]): "failures" | "diagnostics" | undefined {
  return resolveRunner(cmd, args)?.spec.rowsKey;
}

/** 이 실행 결과의 필드 근거. 근거를 내지 않는 러너거나 러너가 아니면 빈 표다. */
export function devloopEvidence(cmd: string, args: readonly string[], raw: string): RawEvidence {
  return resolveRunner(cmd, args)?.spec.evidence?.(raw) ?? {};
}

/** 이 실행의 진행 상태 추적기. 진행 중 파싱을 지원하지 않는 러너면 undefined. */
export function progressFor(cmd: string, args: readonly string[]): RunnerProgress | undefined {
  return resolveRunner(cmd, args)?.spec.progress?.();
}

/**
 * cargo 서브커맨드(test, build, check)의 형식 계약. 내장 cargo 계약의 subcommands에 넣는다.
 * supports는 전체 인자를, hint는 서브커맨드 다음 인자를 받는다(format.ts의 규칙).
 */
export function cargoSubcommandContract(sub: string): ParserContract {
  const spec = CARGO_SUBCOMMANDS[sub]!;
  return {
    supports(args: string[]): boolean {
      const runner = resolveRunner("cargo", args);
      return runner ? runner.spec.supports(runner.rest) : false;
    },
    hint(rest: string[]): HintDraft | null {
      const machine = spec.machine(rest);
      return machine ? { args: machine.args, reason: "run with the tool's machine-readable output format so the result can be parsed (machine_format true adds it for you)" } : null;
    },
  };
}

/** 개발 루프 명령의 파서. 러너가 아닌 npx 실행은 null을 돌려 파서가 없는 것으로 둔다. */
export const parseDevloop: ParserFn = (cmd, args, raw, ctx) => {
  const runner = resolveRunner(cmd, args);
  return runner ? runner.spec.parse(raw, ctx) : null;
};

/**
 * cmd의 형식 계약. 러너를 기계용 형식 밖의 인자로 실행하면 unsupported_format이고,
 * 안내(hint)는 기계용 형식 인자를 알려 준다. 러너가 아닌 npx 실행은 형식 검사를 그대로 통과한다.
 */
export function devloopContract(cmd: string): ParserContract {
  return {
    supports(args: string[]): boolean {
      const runner = resolveRunner(cmd, args);
      return runner ? runner.spec.supports(runner.rest) : true;
    },
    hint(args: string[]): HintDraft | null {
      const machine = machineFormatArgs(cmd, args);
      if (!machine) return null;
      return {
        args:   machine.args,
        reason: machine.reportFlag
          ? "run with contract_version \"next\" and machine_format true so the result is machine-readable and can be parsed"
          : "run with the tool's machine-readable output format so the result can be parsed (machine_format true adds it for you)",
      };
    },
  };
}

/**
 * 보고서의 파일 경로, 식별자, 메시지에서 작업 디렉터리 접두사를 뺀다.
 * 러너는 절대 경로를 내는데, 같은 접두사가 실패마다 되풀이되어 응답이 길어진다.
 * 작업 디렉터리 밖의 경로는 그대로 둔다. 입력은 바꾸지 않는다.
 */
export function relativizeReport<T>(report: T, cwd: string): T {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return report;
  const prefix = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd : `${cwd}/`;
  if (prefix.length < 2) return report;
  const strip = (text: unknown): unknown => typeof text === "string" ? text.split(prefix).join("") : text;
  const source = report as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of ["failures", "diagnostics"]) {
    const rows = source[key];
    if (!Array.isArray(rows)) continue;
    out[key] = rows.map(row => {
      if (row === null || typeof row !== "object") return row;
      const r = row as Record<string, unknown>;
      return {
        ...r,
        ...(r.id !== undefined && { id: strip(r.id) }),
        ...(r.file !== undefined && { file: strip(r.file) }),
        ...(r.message !== undefined && { message: strip(r.message) }),
      };
    });
  }
  return out as T;
}
