/**
 * 로컬 git 쓰기 뒤의 상태 요약(_delta).
 *
 * `git add`, `git commit`, `git checkout` 같은 실행 뒤에 `git status`를 한 번 더 부르지 않아도
 * 브랜치, HEAD, 스테이징·수정·추적 안 됨 파일 수를 알 수 있게 응답에 싣는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { spawn }                                   from "node:child_process";
import { buildExecArgs, GIT_MUTATING_SUBCOMMANDS } from "./policy.js";

export interface GitDelta {
  /** 현재 브랜치. 분리된 HEAD면 "(detached)"다. */
  branch:           string;
  /** HEAD 커밋의 앞 12자. 커밋이 없으면 빈 문자열이다. */
  head:             string;
  staged_count:     number;
  modified_count:   number;
  untracked_count:  number;
  /** 충돌 중인 파일이 있을 때만 있다 */
  conflicted_count?: number;
  /** 업스트림이 있을 때만 있다 */
  ahead?:           number;
  behind?:          number;
}

/** 읽기만 하는 하위 동작. 서브커맨드는 쓰기여도 이 형태면 _delta를 붙이지 않는다. */
const READ_FORMS: Record<string, (rest: string[]) => boolean> = {
  branch: rest => !rest.some(a => !a.startsWith("-") || /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to)/.test(a)),
  tag:    rest => !rest.some(a => !a.startsWith("-") || /^-(d|a|m|f|s)$|^--(delete|annotate|message|force)/.test(a)),
  stash:  rest => rest[0] === "list" || rest[0] === "show",
};

/** 인자가 로컬 저장소를 바꾸는 git 실행인지 */
export function isMutatingGit(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === "--no-pager") i++;
  const sub = args[i];
  if (sub === undefined || !GIT_MUTATING_SUBCOMMANDS.has(sub)) return false;
  const read = READ_FORMS[sub];
  return read ? !read(args.slice(i + 1)) : true;
}

function runStatus(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn("git", buildExecArgs("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]), {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      resolve(undefined);
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(undefined));
    child.on("close", code => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined));
  });
}

/** `git status --porcelain=v2 --branch` 출력을 요약한다 */
export function summarizeStatus(text: string): GitDelta {
  const delta: GitDelta = { branch: "", head: "", staged_count: 0, modified_count: 0, untracked_count: 0 };
  let conflicted = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const name = line.slice(14);
      delta.branch = name === "(detached)" ? "(detached)" : name;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      delta.head = oid === "(initial)" ? "" : oid.slice(0, 12);
    } else if (line.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+([0-9]+) -([0-9]+)/.exec(line);
      if (m) { delta.ahead = Number(m[1]); delta.behind = Number(m[2]); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") delta.staged_count++;
      if (xy[1] !== ".") delta.modified_count++;
    } else if (line.startsWith("u ")) {
      conflicted++;
    } else if (line.startsWith("? ")) {
      delta.untracked_count++;
    }
  }
  if (conflicted > 0) delta.conflicted_count = conflicted;
  return delta;
}

/** cwd 저장소의 현재 상태 요약. git 저장소가 아니면 undefined */
export async function gitDelta(cwd: string): Promise<GitDelta | undefined> {
  const text = await runStatus(cwd);
  return text === undefined ? undefined : summarizeStatus(text);
}
