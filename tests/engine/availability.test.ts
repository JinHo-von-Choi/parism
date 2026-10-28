/**
 * 환경 인식 계층 시험.
 *
 * 명령이 이 호스트에 있는지 없는지를 **실행 없이** 판정하는지,
 * 그리고 그 판정을 다음 행동(설치 명령·대체 명령)으로 바꿀 수 있는지 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir }     from "node:os";
import path           from "node:path";
import {
  probeCommand,
  probeCommandFor,
  probeAll,
  clearProbeCache,
  buildAvailabilityFailure,
  COMMAND_ALTERNATIVES,
  PROBE_TTL_MS,
} from "../../src/engine/availability.js";
import { resolveInstallHint, INSTALL_HINTS } from "../../src/engine/install-hints.js";

const isWindows = process.platform === "win32";

/** 시험용 임시 디렉터리. PATH 에 넣었다가 되돌린다. */
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "parism-avail-"));
  clearProbeCache();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  clearProbeCache();
});

/** 지정한 디렉터리에 실행 파일을 하나 만든다. */
function makeExecutableIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

/** 시험용 임시 디렉터리에 실행 파일을 만든다. */
function makeExecutable(name: string, mode = 0o755): string {
  const file = path.join(sandbox, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return file;
}

describe("probeCommand", () => {
  it("PATH 에 있는 실행 파일을 installed로 판정한다", () => {
    const file = makeExecutable("prism-probe-ok");
    const result = probeCommand("prism-probe-ok", { PATH: sandbox });
    expect(result.status).toBe("installed");
    if (result.status === "installed") expect(result.path).toBe(file);
  });

  it("PATH 에 없는 명령을 missing으로 판정한다", () => {
    const result = probeCommand("prism-probe-absent", { PATH: sandbox });
    expect(result.status).toBe("missing");
  });

  it("PATH 가 비어 있으면 missing으로 판정한다", () => {
    const result = probeCommand("prism-probe-absent", {});
    expect(result.status).toBe("missing");
  });

  it("심볼릭 링크는 대상 경로로 확정한다", () => {
    if (isWindows) return;
    const target = makeExecutable("prism-probe-target");
    const link   = path.join(sandbox, "prism-probe-link");
    symlinkSync(target, link);
    const result = probeCommand("prism-probe-link", { PATH: sandbox });
    expect(result.status).toBe("installed");
    if (result.status === "installed") expect(result.path).toBe(target);
  });

  it("실행 권한이 없는 파일만 있으면 not_executable로 판정한다", () => {
    if (isWindows) return;
    const file = makeExecutable("prism-probe-noexec", 0o644);
    const result = probeCommand("prism-probe-noexec", { PATH: sandbox });
    expect(result.status).toBe("not_executable");
    if (result.status === "not_executable") expect(result.path).toBe(file);
  });

  it("PATH 앞쪽의 권한 없는 파일은 뒤쪽 실행 파일을 가리지 않는다", () => {
    /**
     * 셸의 execvp 규칙이다. 실행할 수 없는 파일을 만나면 **다음 PATH 항목으로 간다.**
     * 가린다고 판단하면 실제로는 실행되는 명령을 "없다"고 말하게 된다.
     */
    if (isWindows) return;
    const front = path.join(sandbox, "front");
    const back  = path.join(sandbox, "back");
    mkdirSync(front);
    mkdirSync(back);
    writeFileSync(path.join(front, "prism-probe-shadow"), "x");
    chmodSync(path.join(front, "prism-probe-shadow"), 0o644);
    makeExecutableIn(back, "prism-probe-shadow");

    const result = probeCommand("prism-probe-shadow", { PATH: `${front}${path.delimiter}${back}` });
    expect(result.status).toBe("installed");
  });

  it("PATH 순서를 따른다", () => {
    const front = path.join(sandbox, "front");
    const back  = path.join(sandbox, "back");
    mkdirSync(front);
    mkdirSync(back);
    makeExecutableIn(front, "prism-probe-order");
    makeExecutableIn(back, "prism-probe-order");

    const result = probeCommand("prism-probe-order", { PATH: `${front}${path.delimiter}${back}` });
    expect(result.status).toBe("installed");
    if (result.status === "installed") expect(result.path.startsWith(front)).toBe(true);
  });

  it("PATH 의 빈 항목은 현재 디렉터리로 해석한다", () => {
    if (isWindows) return;
    const cwd  = process.cwd();
    const file = path.join(cwd, "prism-probe-cwd");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    try {
      const result = probeCommand("prism-probe-cwd", { PATH: path.delimiter });
      expect(result.status).toBe("installed");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("60초 안에 같은 조회를 캐시에서 돌려준다", () => {
    const file = makeExecutable("prism-probe-cache");
    const first = probeCommand("prism-probe-cache", { PATH: sandbox });
    /** 파일을 지워도 캐시가 살아 있으면 installed 로 답해야 한다. */
    rmSync(file, { force: true });
    const second = probeCommand("prism-probe-cache", { PATH: sandbox });
    expect(second).toEqual(first);
    expect(PROBE_TTL_MS).toBe(60_000);
  });

  it("PATH 가 바뀌면 캐시를 다시 쓴다", () => {
    makeExecutable("prism-probe-key");
    const first = probeCommand("prism-probe-key", { PATH: sandbox });
    const other = mkdtempSync(path.join(tmpdir(), "parism-avail2-"));
    try {
      const second = probeCommand("prism-probe-key", { PATH: other });
      expect(second.status).toBe("missing");
      expect(first.status).toBe("installed");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("probeCommandFor (플랫폼 규칙)", () => {
  it("Windows 는 PATHEXT 확장자를 붙여 찾는다", () => {
    const file = path.join(sandbox, "prism-probe.exe");
    writeFileSync(file, "x");
    /**
     * POSIX 호스트에서 windows 규칙을 흉내 내는 시험이라 실행 권한이 있어야 한다.
     * 실제 windows 에서는 X_OK 가 존재 확인으로 동작한다.
     */
    chmodSync(file, 0o755);
    const result = probeCommandFor("prism-probe", { PATH: sandbox, PATHEXT: ".COM;.EXE;.BAT" }, "win32");
    expect(result.status).toBe("installed");
    if (result.status === "installed") expect(result.path).toBe(file);
  });

  it("Windows 는 PATHEXT 에 없는 확장자를 붙이지 않는다", () => {
    writeFileSync(path.join(sandbox, "prism-probe.sh"), "x");
    const result = probeCommandFor("prism-probe", { PATH: sandbox, PATHEXT: ".COM;.EXE" }, "win32");
    expect(result.status).toBe("missing");
  });

  it("Windows 는 ; 를 PATH 구분자로 쓴다", () => {
    const front = path.join(sandbox, "front");
    const back  = path.join(sandbox, "back");
    mkdirSync(front);
    mkdirSync(back);
    makeExecutableIn(front, "prism-probe-win");
    const result = probeCommandFor("prism-probe-win", { PATH: `${front};${back}`, PATHEXT: ".EXE" }, "win32");
    expect(result.status).toBe("installed");
  });

  it("POSIX 규칙에서는 확장자를 붙이지 않는다", () => {
    writeFileSync(path.join(sandbox, "prism-probe.exe"), "x");
    const result = probeCommandFor("prism-probe", { PATH: sandbox, PATHEXT: ".EXE" }, "linux");
    expect(result.status).toBe("missing");
  });
});

describe("probeAll", () => {
  it("여러 명령을 한 번에 판정한다", () => {
    makeExecutable("prism-probe-one");
    const results = probeAll(["prism-probe-one", "prism-probe-two"], { PATH: sandbox });
    expect(results.get("prism-probe-one")?.status).toBe("installed");
    expect(results.get("prism-probe-two")?.status).toBe("missing");
    expect(results.size).toBe(2);
  });
});

describe("resolveInstallHint", () => {
  it("표에 없는 명령은 undefined를 돌려준다", () => {
    expect(resolveInstallHint("prism-not-in-table", process.platform)).toBeUndefined();
  });

  it("표에 있는 명령은 그 플랫폼의 설치 명령을 돌려준다", () => {
    const hint = resolveInstallHint("terraform", "linux");
    expect(hint).toBeDefined();
    /** 고른 관리자가 표에 적은 명령과 일치해야 한다. */
    expect(hint!.command).toBe(INSTALL_HINTS.terraform!.managers[hint!.manager]!.command);
    expect(hint!.package).toBe(INSTALL_HINTS.terraform!.managers[hint!.manager]!.package);
    expect(["apt", "dnf", "yum", "pacman", "apk"]).toContain(hint!.manager);
  });

  it("그 관리자 바이너리가 없으면 undefined를 돌려준다", () => {
    const hint = resolveInstallHint("terraform", "linux", () => false);
    expect(hint).toBeUndefined();
  });

  it("사용 가능한 관리자를 고른다", () => {
    const hint = resolveInstallHint("kubectl", "linux", manager => manager === "apt");
    expect(hint?.manager).toBe("apt");
    expect(hint?.command).toBe("apt install -y kubernetes-client");
  });

  it("이 플랫폼에 없는 관리자는 고르지 않는다", () => {
    /** brew 는 linux 항목이 없다. 설치 방법을 추측하지 않는다. */
    const hint = resolveInstallHint("tree", "linux");
    expect(hint?.manager).not.toBe("brew");
  });

  it("설치 표의 모든 항목에 패키지 이름이 있다", () => {
    for (const [cmd, hint] of Object.entries(INSTALL_HINTS)) {
      expect(Object.keys(hint.managers).length, cmd).toBeGreaterThan(0);
      for (const [manager, entry] of Object.entries(hint.managers)) {
        expect(entry.package, `${cmd}/${manager}`).toBeTruthy();
        expect(entry.command, `${cmd}/${manager}`).toBeTruthy();
      }
    }
  });

  it("패키지 이름은 관리자마다 다를 수 있다", () => {
    /** kubectl 의 apt 패키지명은 kubernetes-client 이고 dnf 에서는 kubectl 다. */
    expect(INSTALL_HINTS.kubectl!.managers.apt!.package).toBe("kubernetes-client");
    expect(INSTALL_HINTS.kubectl!.managers.dnf!.package).toBe("kubectl");
  });

  it("자기 자신으로 설치되는 항목은 없다", () => {
    /** apt 와 brew 는 자기 자신으로 설치되지 않는다. */
    expect(INSTALL_HINTS.apt).toBeUndefined();
    expect(INSTALL_HINTS.brew).toBeUndefined();
  });
});

/** 지정한 명령만 가드를 통과시키는 판정 함수. 인자는 보지 않는다. */
function allowOnly(...cmds: string[]): (cmd: string) => boolean {
  return cmd => cmds.includes(cmd);
}

describe("buildAvailabilityFailure", () => {
  it("명령이 있으면 undefined를 돌려준다", () => {
    makeExecutable("prism-probe-installed");
    const failure = buildAvailabilityFailure("prism-probe-installed", [], allowOnly("prism-probe-installed"), { PATH: sandbox });
    expect(failure).toBeUndefined();
  });

  it("없는 명령은 status=missing과 설치 지시를 채운다", () => {
    /** apt 바이너리가 이 호스트에 있는 것으로 본다. */
    makeExecutable("apt");
    const failure = buildAvailabilityFailure("kubectl", [], allowOnly("kubectl"), { PATH: sandbox });
    expect(failure?.status).toBe("missing");
    expect(failure?.install?.package).toBe("kubernetes-client");
    expect(failure?.install?.manager).toBe("apt");
    expect(failure?.install?.command).toBe("apt install -y kubernetes-client");
  });

  it("관리자를 못 찾으면 install 없이 status만 돌려준다", () => {
    /** PATH 가 sandbox 뿐이라 apt 등 관리자 바이너리를 찾지 못한다. */
    const failure = buildAvailabilityFailure("terraform", [], allowOnly("terraform"), { PATH: sandbox });
    expect(failure?.status).toBe("missing");
    expect(failure?.install).toBeUndefined();
  });

  it("설치 표에 없는 명령은 install 없이 status만 돌려준다", () => {
    makeExecutable("apt");
    const failure = buildAvailabilityFailure("prism-unknown-cmd", [], allowOnly("prism-unknown-cmd"), { PATH: sandbox });
    expect(failure?.status).toBe("missing");
    expect(failure?.install).toBeUndefined();
  });

  it("not_executable 면 install 을 붙이지 않는다", () => {
    if (isWindows) return;
    makeExecutable("prism-probe-noexec2", 0o644);
    const failure = buildAvailabilityFailure("prism-probe-noexec2", [], allowOnly("prism-probe-noexec2"), { PATH: sandbox });
    expect(failure?.status).toBe("not_executable");
    expect(failure?.install).toBeUndefined();
  });

  it("대체 명령은 allowlist 안에 있는 것만 싣는다", () => {
    const failure = buildAvailabilityFailure("netstat", [], allowOnly("netstat"), { PATH: sandbox });
    expect(failure?.status).toBe("missing");
    expect(failure?.alternatives).toBeUndefined();
  });

  it("대체 명령이 allowlist 안에 있으면 싣는다", () => {
    const failure = buildAvailabilityFailure("netstat", [], allowOnly("netstat", "ss"), { PATH: sandbox });
    expect(failure?.status).toBe("missing");
    expect(failure?.alternatives).toHaveLength(1);
    expect(failure?.alternatives?.[0]?.cmd).toBe("ss");
    expect(failure?.alternatives?.[0]?.reason).toBeTruthy();
  });

  it("인자에 따라 다른 대안을 고른다", () => {
    const listed    = buildAvailabilityFailure("helm", ["list"], allowOnly("helm", "kubectl"), { PATH: sandbox });
    const installed = buildAvailabilityFailure("helm", ["install", "x"], allowOnly("helm", "kubectl"), { PATH: sandbox });
    expect(listed?.alternatives?.[0]?.cmd).toBe("kubectl");
    expect(installed?.alternatives).toBeUndefined();
  });

  it("pnpm 대안은 원래 하위 명령을 같은 뜻의 npm 하위 명령으로 옮긴다", () => {
    const listed = buildAvailabilityFailure("pnpm", ["list", "--depth", "0"], allowOnly("pnpm", "npm"), { PATH: sandbox });
    const added  = buildAvailabilityFailure("pnpm", ["add", "lodash"], allowOnly("pnpm", "npm"), { PATH: sandbox });
    expect(listed?.alternatives).toEqual([expect.objectContaining({ cmd: "npm", args: ["list", "--depth", "0"] })]);
    expect(added?.alternatives).toEqual([expect.objectContaining({ cmd: "npm", args: ["install", "lodash"] })]);
  });

  it("뜻이 같다고 확인되지 않은 pnpm 하위 명령과 옵션은 npm 으로 옮기지 않는다", () => {
    const unknownVerb = buildAvailabilityFailure("pnpm", ["dlx", "x"], allowOnly("pnpm", "npm"), { PATH: sandbox });
    const unknownFlag = buildAvailabilityFailure("pnpm", ["install", "--frozen-lockfile"], allowOnly("pnpm", "npm"), { PATH: sandbox });
    const noVerb      = buildAvailabilityFailure("pnpm", [], allowOnly("pnpm", "npm"), { PATH: sandbox });
    expect(unknownVerb?.alternatives).toBeUndefined();
    expect(unknownFlag?.alternatives).toBeUndefined();
    expect(noVerb?.alternatives).toBeUndefined();
  });

  it("가드가 대체 명령의 인자를 거절하면 그 대안을 싣지 않는다", () => {
    const permits = (cmd: string, args: readonly string[]) => cmd === "npm" && !args.includes("install");
    const failure = buildAvailabilityFailure("pnpm", ["install"], permits, { PATH: sandbox });
    expect(failure?.alternatives).toBeUndefined();
  });

  it("대체 표의 모든 명령은 기본 allowlist 안에 있다", () => {
    const allowed = new Set([
      "ls", "find", "stat", "du", "df", "tree", "ps",
      "ping", "curl", "netstat", "lsof", "ss", "dig",
      "grep", "wc", "head", "tail", "cat",
      "git", "env", "pwd", "which", "echo", "date", "uname", "hostname",
      "free", "id", "kubectl", "docker", "gh", "systemctl", "journalctl",
      "helm", "terraform", "apt", "brew", "npm", "pnpm", "cargo",
    ]);
    for (const [cmd, alts] of Object.entries(COMMAND_ALTERNATIVES)) {
      for (const alt of alts) {
        expect(allowed.has(alt.cmd), `${cmd} -> ${alt.cmd}`).toBe(true);
      }
    }
  });
});
