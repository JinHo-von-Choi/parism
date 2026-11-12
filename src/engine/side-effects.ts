/**
 * 명령의 부작용 등급.
 *
 *   read_only        파일, 프로세스, 저장소를 바꾸지 않는다
 *   local_state      작업 공간의 파일이나 로컬 저장소를 바꾼다(빌드 산출물, git 커밋, 패키지 설치)
 *   process_control  다른 프로세스나 서비스의 상태를 바꾼다
 *   network          네트워크로 요청을 보내거나 원격 상태를 바꾼다
 *
 * 같은 명령도 서브커맨드에 따라 등급이 다르다(git status는 read_only, git commit은 local_state).
 * 등급은 정책이 허용하는 범위에서 가장 큰 부작용이다. 정책이 막는 실행은 등급과 관계없이 실행되지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { GIT_MUTATING_SUBCOMMANDS } from "./policy.js";

export type SideEffect = "read_only" | "local_state" | "process_control" | "network";

const ORDER: Record<SideEffect, number> = { read_only: 0, local_state: 1, process_control: 2, network: 3 };

const BY_COMMAND: Record<string, SideEffect> = {
  ls: "read_only", find: "read_only", stat: "read_only", du: "read_only", df: "read_only", tree: "read_only",
  ps: "read_only", netstat: "read_only", lsof: "read_only", ss: "read_only", grep: "read_only", wc: "read_only",
  head: "read_only", tail: "read_only", cat: "read_only", env: "read_only", pwd: "read_only", which: "read_only",
  echo: "read_only", date: "read_only", uname: "read_only", hostname: "read_only", free: "read_only", id: "read_only",
  journalctl: "read_only", dir: "read_only", tasklist: "read_only", ipconfig: "read_only", systeminfo: "read_only",
  sort: "read_only", uniq: "read_only", diff: "read_only", file: "read_only", cut: "read_only", tr: "read_only",
  sha256sum: "read_only", md5sum: "read_only", basename: "read_only", dirname: "read_only", realpath: "read_only",
  ping: "network", curl: "network", dig: "network", wget: "network", gh: "network", helm: "network", kubectl: "network",
  docker: "process_control", systemctl: "process_control", kill: "process_control", pkill: "process_control", service: "process_control",
  npm: "local_state", pnpm: "local_state", yarn: "local_state", cargo: "local_state", terraform: "local_state",
  apt: "read_only", brew: "read_only", node: "local_state", npx: "local_state", python: "local_state", python3: "local_state",
  make: "local_state", cmake: "local_state", gcc: "local_state", "g++": "local_state", go: "local_state", rustc: "local_state",
  vitest: "local_state", jest: "local_state", tsc: "local_state", eslint: "read_only", pytest: "local_state", mypy: "read_only", ruff: "read_only",
  mkdir: "local_state", cp: "local_state", mv: "local_state", rm: "local_state", chmod: "local_state", touch: "local_state",
  ln: "local_state", sed: "local_state", tar: "local_state", unzip: "local_state", gzip: "local_state", patch: "local_state",
  pip: "network", pip3: "network", "apt-get": "network",
};

/** git 서브커맨드의 등급 */
/** 조회 서브커맨드 가운데 저장소를 바꾸는 하위 동사(git reflog expire, git worktree add) */
const GIT_WRITE_VERBS: Record<string, readonly string[]> = {
  reflog:   ["expire", "delete"],
  worktree: ["add", "remove", "prune", "move", "lock", "unlock", "repair"],
};

function gitEffect(sub: string | undefined, verb?: string): SideEffect {
  if (sub === undefined) return "read_only";
  if (verb !== undefined && Object.hasOwn(GIT_WRITE_VERBS, sub) && GIT_WRITE_VERBS[sub]!.includes(verb)) return "local_state";
  if (["push", "fetch", "pull", "clone"].includes(sub)) return "network";
  if (sub === "remote") return "local_state";
  return GIT_MUTATING_SUBCOMMANDS.has(sub) || sub === "config" ? "local_state" : "read_only";
}

/** 정책이 허용하는 서브커맨드 목록이 주어졌을 때 명령의 최대 부작용. 인자를 주면 그 실행 하나의 등급이다. */
export function sideEffectOf(cmd: string, args?: readonly string[], subcommands?: readonly string[]): SideEffect {
  if (cmd === "git") {
    if (args) {
      let i = 0;
      while (args[i] === "--no-pager") i++;
      return gitEffect(args[i], args[i + 1]);
    }
    return (subcommands ?? []).map(sub => gitEffect(sub)).reduce<SideEffect>((max, e) => (ORDER[e] > ORDER[max] ? e : max), "read_only");
  }
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
    const sub = args?.[0];
    if (args && sub !== undefined && ["ls", "list", "outdated", "view", "info", "why", "--version", "-v"].includes(sub)) return sub === "view" || sub === "info" || sub === "outdated" ? "network" : "read_only";
    if (args && sub === "audit") return "network";
  }
  if (cmd === "docker" && args) {
    return ["ps", "images", "inspect", "logs", "version", "info", "stats"].includes(args[0] ?? "") ? "read_only" : "process_control";
  }
  if (cmd === "systemctl" && args) {
    return ["list-units", "list-unit-files", "status", "is-active", "is-enabled", "is-failed", "show", "list-timers", "--version"].includes(args[0] ?? "") ? "read_only" : "process_control";
  }
  return BY_COMMAND[cmd] ?? "local_state";
}
