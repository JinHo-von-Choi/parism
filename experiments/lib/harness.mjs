/**
 * 실험 하네스 공통 — fixture 생성과 채점 규칙.
 *
 * 계획서 10장 "사용자 가치 실험" 의 조건을 그대로 옮긴다.
 *   실험 A: 큰 목록에서 조건에 맞는 대상 3개를 찾아 근거까지 제시
 *   실험 B: 전후 결과에서 새로 생긴 이상 1건과 해결된 1건을 근거로 제시
 *
 * 무엇이 측정값이고 무엇이 가설인지 이 파일의 주석이 구분한다.
 * 여기서 돌린 숫자는 **한 명의 운영자 측정**이다. 5~8명 실험의 결과가 아니다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 재현을 위해 고정 시드. 실행마다 다른 입력을 만들지 않는다. */
export const SEED = 20261005;

/** 결정론적 난수. Math.random 은 쓰지 않는다 — 같은 커밋에서 같은 입력이 나와야 재현된다. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 검사 결과를 누적해 한 번에 보고한다. */
export class Checks {
  label;
  failures = [];
  constructor(label) { this.label = label; }
  check(name, ok, detail = "") {
    if (!ok) this.failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  }
  get ok() { return this.failures.length === 0; }
  finish() {
    console.log(this.ok
      ? `\n[${this.label}] 전부 통과`
      : `\n[${this.label}] 실패 ${this.failures.length}건:\n  - ${this.failures.join("\n  - ")}`);
    return this.ok;
  }
}

/**
 * 실험 A 픽스처 저장소.
 * 200개 파일 가운데 조건에 맞는 것이 정확히 몇 개인지 알고 있어야 채점이 가능하다.
 * 기대값을 모르는 fixture로 정확도를 재는 것은 의미가 없다(계획서 10장).
 */
export function makeListRepo(root, count = 200) {
  const dir = path.join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const rand = rng(SEED);
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  const subdirs = ["src", "src/util", "test", "docs"];
  for (const d of subdirs) mkdirSync(path.join(dir, d), { recursive: true });
  writeFileSync(path.join(dir, "seed.txt"), "x\n");
  git("add", "-A"); git("commit", "-qm", "seed");

  const exts = ["ts", "js", "md", "json"];
  for (let i = 0; i < count; i++) {
    const sub  = subdirs[Math.floor(rand() * subdirs.length)];
    const ext  = exts[Math.floor(rand() * exts.length)];
    const size = 200 + Math.floor(rand() * 4000);
    const body = "a".repeat(size) + "\n";
    writeFileSync(path.join(dir, sub, `f${String(i).padStart(3, "0")}.${ext}`), body);
  }
  git("add", "-A"); git("commit", "-qm", "bulk");
  return { dir };
}

/**
 * 실험 A 의 정답.
 * "2KB 이상인 .ts 파일 3개" 같은 조건을 파일 시스템에서 직접 세어 기대값을 만든다.
 */
export function expectedTsOver(dir, bytes, limit) {
  const out = [];
  for (const sub of ["src", "src/util", "test", "docs"]) {
    const abs = path.join(dir, sub);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith(".ts")) continue;
      const st = statSync(path.join(abs, name));
      if (st.size >= bytes) out.push(`${sub}/${name}`);
    }
  }
  /** 크기 내림차순, 같은 크기면 경로 사전순 — 선택이 재현 가능해야 한다 */
  return out
    .map(p => ({ p, s: statSync(path.join(dir, p)).size }))
    .sort((a, b) => (b.s - a.s) || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map(x => x.p);
}

/**
 * 임시 루트를 만들고, fn 이 끝난 뒤 정리한다.
 *
 * fn 이 비동기(Promise)여도 **그 완료를 기다린 뒤** 지운다. await 없이 정리하면
 * 첫 실행 직후 fixture 가 사라져 이후 spawn 이 전부 ENOENT 가 된다.
 * 실제로 이 버그로 첫 실행만 통과하고 나머지가 spawn_failed 였다.
 */
export async function withTemp(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "parism-exp-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
