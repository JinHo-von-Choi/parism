/**
 * `@nerdvana/parism/sdk` — 코드로 명령을 조합하는 에이전트를 위한 타입 있는 진입점.
 *
 * 도구 호출을 여러 번 주고받는 대신 짧은 스크립트 안에서 명령을 실행하고 파싱된 값을 바로 쓴다.
 * 실행은 ParismEngine을 거치므로 가드, 시크릿 리댁션, 영수증, 결과 보관이 MCP 서버와 같다.
 *
 *   import { sh } from "@nerdvana/parism/sdk";
 *   const status = await sh.git.status();            // ShResult<GitStatus>
 *   const busy   = await sh.ps({ where: [{ field: "cpu", op: "gt", value: 5 }], select: ["pid", "command"] });
 *   const tests  = await sh.vitest.run();            // 실패마다 attribution이 붙은 TestReport
 *   const lines  = await sh.exec("docker ps | grep healthy");
 *
 * 엔진은 처음 호출할 때 다층 설정(전역, 프로젝트, 환경 변수)으로 만든다. createShell로 설정 파일과 cwd를 정할 수 있다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { createEngine, type ParismEngine } from "../facade/engine.js";
import type { QueryResult, RunOptions }    from "../facade/envelope.js";
import type { FailureInfo, ResponseEnvelope } from "../types/envelope.js";
import type { GitStatus }                  from "../parsers/git/status.js";
import type { GitCommit }                  from "../parsers/git/log.js";
import type { GitDiffResult }              from "../parsers/git/diff.js";
import type { GitBranchEntry }             from "../parsers/git/branch.js";
import type { PsEntry }                    from "../parsers/process/ps.js";
import type { LsEntry }                    from "../parsers/fs/ls.js";
import type { DfEntry }                    from "../parsers/fs/df.js";
import type { DockerPsEntry }              from "../parsers/devops/docker.js";
import type { DiagnosticReport, TestFailure, TestReport, Diagnostic } from "../parsers/devloop/types.js";
import type { Attribution }                from "../engine/attribution.js";
import type { WhereCondition, SortSpec }   from "../engine/projection.js";

export type { GitStatus, GitCommit, GitDiffResult, GitBranchEntry, PsEntry, LsEntry, DfEntry, DockerPsEntry, TestReport, DiagnosticReport, Attribution };

/** 실패에 붙는 git 변경 귀속 */
export interface Attributed {
  attribution?:       Attribution;
  diff_hunk_preview?: string;
  attribution_frame?: string;
  imports_changed?:   string[];
}

/** 귀속이 붙은 시험 보고서 */
export type AttributedTestReport = Omit<TestReport, "failures"> & {
  failures:     (TestFailure & Attributed)[];
  attribution?: { modified_line: number; modified_file: number; unmodified: number; changed_files: number };
};

/** 귀속이 붙은 진단 보고서 */
export type AttributedDiagnosticReport = Omit<DiagnosticReport, "diagnostics"> & {
  diagnostics:  (Diagnostic & Attributed)[];
  attribution?: { modified_line: number; modified_file: number; unmodified: number; changed_files: number };
};

/** 실행 한 번의 결과 */
export interface ShResult<T> {
  ok:        boolean;
  exitCode:  number;
  /** 파싱한 값. 파서가 없거나 파싱에 실패하면 null이다. */
  data:      T | null;
  /** 파싱하지 못했거나 include_raw를 줬을 때의 표준 출력 */
  stdout:    string;
  stderr:    string;
  failure?:  FailureInfo;
  /** 결과 보관함의 식별자. 행이 많아 앞부분만 받았으면 query로 나머지를 읽는다. */
  result_id?: string;
  /** 엔진이 돌려준 응답 전체 */
  envelope:  ResponseEnvelope;
}

/** 행 배열 결과에 거는 투영 */
export interface RowQuery {
  where?:   WhereCondition[];
  select?:  string[];
  sort_by?: SortSpec;
  limit?:   number;
}

export interface ShellOptions {
  /** 설정 파일. 주지 않으면 전역·프로젝트·환경 변수 설정을 읽는다. */
  configPath?: string;
  /** 명령의 기본 작업 디렉터리 */
  cwd?:        string;
}

function toResult<T>(envelope: ResponseEnvelope): ShResult<T> {
  return {
    ok:       envelope.ok,
    exitCode: envelope.exitCode,
    data:     (envelope.stdout.parsed ?? null) as T | null,
    stdout:   envelope.stdout.raw,
    stderr:   envelope.stderr.raw,
    ...(envelope.failure && { failure: envelope.failure }),
    ...((envelope.result_id ?? envelope.review?.result_id) && { result_id: envelope.result_id ?? envelope.review!.result_id }),
    envelope,
  };
}

/** 셸 하나. 같은 셸에서 실행한 결과는 같은 결과 보관함을 쓴다. */
export class Shell {
  private engine?: Promise<ParismEngine>;

  constructor(private readonly options: ShellOptions = {}) {}

  private get ready(): Promise<ParismEngine> {
    this.engine ??= createEngine(this.options.configPath ? { configPath: this.options.configPath } : undefined);
    return this.engine;
  }

  private async go<T>(command: string, opts: RunOptions = {}): Promise<ShResult<T>> {
    const engine = await this.ready;
    return toResult<T>(await engine.run("", { cwd: this.options.cwd ?? process.cwd(), ...opts, command }));
  }

  /** 명령 한 줄. 파이프 뒤 단계(grep, head, tail, wc, sort, uniq, cut)는 Parism 안에서 처리한다. */
  exec<T = unknown>(command: string, opts: RunOptions = {}): Promise<ShResult<T>> {
    return this.go<T>(command, opts);
  }

  /** 인자 배열로 실행한다. 따옴표를 생각하지 않아도 된다. */
  async run<T = unknown>(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<ShResult<T>> {
    const engine = await this.ready;
    return toResult<T>(await engine.run(cmd, { cwd: this.options.cwd ?? process.cwd(), ...opts, args }));
  }

  /** 보관된 결과를 다시 질의한다. 명령을 다시 실행하지 않는다. */
  async query(resultId: string, query: RowQuery & { aggregate?: RunOptions["aggregate"] }): Promise<QueryResult> {
    return (await this.ready).queryResult(resultId, { ...query });
  }

  readonly git = {
    status: (opts: RunOptions = {}) => this.run<GitStatus>("git", ["status"], opts),
    log:    (opts: { n?: number } & RunOptions = {}) => {
      const { n = 20, ...rest } = opts;
      return this.run<{ commits: GitCommit[] }>("git", ["log", "--format=%H%x09%an%x09%aI%x09%s", "-n", String(n)], rest);
    },
    diff:   (opts: { staged?: boolean } & RunOptions = {}) => {
      const { staged, ...rest } = opts;
      return this.run<GitDiffResult>("git", ["diff", ...(staged ? ["--cached"] : [])], rest);
    },
    branch: (opts: RunOptions = {}) => this.run<{ branches: GitBranchEntry[] }>("git", ["branch", "-vv"], opts),
  };

  ps(query: RowQuery = {}): Promise<ShResult<{ processes: PsEntry[] }>> {
    return this.run<{ processes: PsEntry[] }>("ps", ["aux"], { ...query });
  }

  ls(dir = ".", query: RowQuery = {}): Promise<ShResult<{ entries: LsEntry[] }>> {
    return this.run<{ entries: LsEntry[] }>("ls", ["-la", dir], { ...query });
  }

  df(query: RowQuery = {}): Promise<ShResult<{ filesystems: DfEntry[] }>> {
    return this.run<{ filesystems: DfEntry[] }>("df", ["-h"], { ...query });
  }

  readonly docker = {
    ps: (query: RowQuery = {}) => this.run<{ containers: DockerPsEntry[] }>("docker", ["ps"], { ...query }),
  };

  /** 시험 러너. 기계용 출력 형식으로 실행해 모든 실패를 받고, 실패마다 git 변경 귀속을 붙인다. */
  readonly vitest = {
    run: (opts: { args?: string[]; attribution?: boolean } = {}) =>
      this.run<AttributedTestReport>("npx", ["vitest", "run", ...(opts.args ?? [])], {
        contract_version: "next", machine_format: true, ...(opts.attribution === false && { attribution: false }),
      }),
  };

  readonly jest = {
    run: (opts: { args?: string[]; attribution?: boolean } = {}) =>
      this.run<AttributedTestReport>("npx", ["jest", ...(opts.args ?? [])], {
        contract_version: "next", machine_format: true, ...(opts.attribution === false && { attribution: false }),
      }),
  };

  readonly tsc = {
    check: (opts: { args?: string[]; attribution?: boolean } = {}) =>
      this.run<AttributedDiagnosticReport>("npx", ["tsc", "--noEmit", ...(opts.args ?? [])], {
        contract_version: "next", machine_format: true, ...(opts.attribution === false && { attribution: false }),
      }),
  };

  readonly eslint = {
    lint: (paths: string[] = ["."], opts: { attribution?: boolean } = {}) =>
      this.run<AttributedDiagnosticReport>("npx", ["eslint", ...paths], {
        contract_version: "next", machine_format: true, ...(opts.attribution === false && { attribution: false }),
      }),
  };

  readonly cargo = {
    test: (opts: { args?: string[] } = {}) => this.run<AttributedTestReport>("cargo", ["test", ...(opts.args ?? [])], { contract_version: "next", machine_format: true }),
    build: (opts: { args?: string[] } = {}) => this.run<AttributedDiagnosticReport>("cargo", ["build", ...(opts.args ?? [])], { contract_version: "next", machine_format: true }),
  };
}

/** 설정 파일과 작업 디렉터리를 정한 셸을 만든다 */
export function createShell(options: ShellOptions = {}): Shell {
  return new Shell(options);
}

/** 기본 셸. 처음 쓸 때 다층 설정으로 엔진을 만든다. */
export const sh = new Shell();
