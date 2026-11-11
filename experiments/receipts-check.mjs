#!/usr/bin/env node
/**
 * 실행 영수증 실험 -- `parism receipts check`가 완료 보고를 맞게 가리는가.
 *
 * 예제 프로젝트에서 에이전트 세션이 밟을 만한 순서(시험 실행, 파일 수정, 커밋)를 그대로 실행하고,
 * 세션 끝에 "시험이 통과했다"고 보고해도 되는지를 `receipts check`의 판정과 비교한다.
 * 시험은 실제 vitest로 돌리고, 영수증은 엔진이 남긴 것을 쓴다.
 *
 *   보고해도 되는 세션 -- 지금 작업 공간의 내용으로 시험 전체가 통과한 적이 있다
 *   보고하면 안 되는 세션 -- 시험이 실패했거나, 돌리지 않았거나, 통과한 뒤 내용이 달라졌다
 *
 * 재는 값:
 *   틀린 보고를 막은 비율 -- 보고하면 안 되는 세션 가운데 check가 실패로 끝난 비율
 *   맞는 보고를 막은 비율 -- 보고해도 되는 세션 가운데 check가 실패로 끝난 비율
 *
 * 사용:
 *   npm run build
 *   node experiments/receipts-check.mjs
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir }       from "node:os";
import path             from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const HOME = mkdtempSync(path.join(tmpdir(), "parism-receipts-home-"));
process.env.PARISM_HOME = HOME;
process.env.PATH = `${path.join(REPO, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`;

const { ParismEngine }   = await import("../dist/facade/engine.js");
const { DEFAULT_CONFIG } = await import("../dist/config/loader.js");
const { createRegistry } = await import("../dist/parsers/index.js");
const { receiptsCheck }  = await import("../dist/cli/receipts.js");

const VERIFY = ["vitest", "run"];
const HOST_CONFIG = path.join(HOME, "host.json");
writeFileSync(HOST_CONFIG, JSON.stringify({ receipts: { enabled: true }, verify: { commands: [VERIFY] } }));

const GOOD_SOURCE = "export const add = (a, b) => a + b;\n";
const BAD_SOURCE  = "export const add = (a, b) => a - b;\n";

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

/** 시험 두 파일이 있는 예제 프로젝트를 만든다. */
function createProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "parism-receipts-"));
  symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", type: "module", private: true }));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "add.js"), GOOD_SOURCE);
  writeFileSync(path.join(dir, "src", "add.test.js"),
    'import { expect, it } from "vitest";\nimport { add } from "./add.js";\nit("adds", () => expect(add(2, 3)).toBe(5));\n');
  writeFileSync(path.join(dir, "src", "other.test.js"),
    'import { expect, it } from "vitest";\nit("holds", () => expect(1).toBe(1));\n');
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function engineFor(dir) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [dir];
  config.guard.allowed_commands.push("vitest");
  config.guard.timeout_ms = 120_000;
  config.receipts = { ...config.receipts, enabled: true };
  config.verify   = { commands: [VERIFY] };
  return new ParismEngine(config, createRegistry());
}

/** 세션에서 쓰는 동작 */
const step = {
  test:      ctx => ctx.engine.run("vitest", { args: ["run"], cwd: ctx.dir, contract_version: "next", machine_format: true }),
  testOne:   ctx => ctx.engine.run("vitest", { args: ["run", "src/other.test.js"], cwd: ctx.dir, contract_version: "next", machine_format: true }),
  breakCode: ctx => writeFileSync(path.join(ctx.dir, "src", "add.js"), BAD_SOURCE),
  fixCode:   ctx => writeFileSync(path.join(ctx.dir, "src", "add.js"), GOOD_SOURCE),
  comment:   ctx => writeFileSync(path.join(ctx.dir, "src", "add.js"), `${GOOD_SOURCE}// note\n`),
  newFile:   ctx => writeFileSync(path.join(ctx.dir, "src", "extra.js"), "export const extra = 1;\n"),
  removeTest: ctx => unlinkSync(path.join(ctx.dir, "src", "add.test.js")),
  stage:     ctx => git(ctx.dir, "add", "-A"),
  commit:    ctx => { git(ctx.dir, "add", "-A"); git(ctx.dir, "commit", "-q", "-m", "work"); },
};

/** 세션 목록. mayReport는 세션 끝에 "시험이 통과했다"고 보고해도 되는지다. */
const SESSIONS = [
  { name: "시험 통과, 그 뒤 변경 없음",                 steps: ["test"],                                   mayReport: true  },
  { name: "수정 → 시험 통과",                           steps: ["comment", "test"],                        mayReport: true  },
  { name: "시험 실패 → 수정 → 다시 시험 통과",          steps: ["breakCode", "test", "fixCode", "test"],   mayReport: true  },
  { name: "시험 통과 → 수정 → 원래 내용으로 되돌림",    steps: ["test", "breakCode", "fixCode"],           mayReport: true  },
  { name: "수정 → 시험 통과 → 스테이징",                steps: ["comment", "test", "stage"],               mayReport: true  },
  { name: "수정 → 시험 통과 → 커밋",                    steps: ["comment", "test", "commit"],              mayReport: true  },
  { name: "새 파일 → 시험 통과 → 커밋",                 steps: ["newFile", "test", "commit"],              mayReport: true  },
  { name: "시험을 돌리지 않음",                         steps: ["comment"],                                mayReport: false },
  { name: "시험 실패",                                  steps: ["breakCode", "test"],                      mayReport: false },
  { name: "시험 통과 → 코드 수정",                      steps: ["test", "breakCode"],                      mayReport: false },
  { name: "시험 통과 → 새 파일 추가",                   steps: ["test", "newFile"],                        mayReport: false },
  { name: "시험 통과 → 시험 파일 삭제",                 steps: ["test", "removeTest"],                     mayReport: false },
  { name: "시험 통과 → 코드 수정 → 커밋",               steps: ["test", "breakCode", "commit"],            mayReport: false },
  { name: "시험 파일 하나만 실행",                      steps: ["comment", "testOne"],                     mayReport: false },
  { name: "시험 실패 → 수정했지만 다시 돌리지 않음",    steps: ["breakCode", "test", "fixCode", "comment"], mayReport: false },
];

const rows = [];
for (const session of SESSIONS) {
  const dir = createProject();
  const ctx = { dir, engine: engineFor(dir) };
  try {
    for (const name of session.steps) await step[name](ctx);
    const report = await receiptsCheck({ cwd: dir, config: HOST_CONFIG });
    rows.push({ ...session, allowed: report.ok === true, verdict: "items" in report ? report.items.map(i => i.verdict).join(",") : report.error });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
rmSync(HOME, { recursive: true, force: true });

for (const row of rows) {
  const right = row.allowed === row.mayReport;
  console.log(`${right ? "일치  " : "불일치"} ${row.mayReport ? "보고 가능" : "보고 불가"}  check=${(row.allowed ? "통과" : "실패").padEnd(2)} (${row.verdict})  ${row.name}`);
}

const wrong   = rows.filter(r => !r.mayReport);
const correct = rows.filter(r => r.mayReport);
console.log(`\n틀린 보고를 막은 비율: ${wrong.filter(r => !r.allowed).length}/${wrong.length}`);
console.log(`맞는 보고를 막은 비율: ${correct.filter(r => !r.allowed).length}/${correct.length}`);
process.exit(rows.every(r => r.allowed === r.mayReport) ? 0 : 1);
