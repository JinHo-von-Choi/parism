#!/usr/bin/env node
/**
 * 외부 파서 샌드박스의 시험용 게스트를 컴포넌트로 만든다.
 *
 * ## 왜 한 단계가 더 있는가
 *
 * 게스트는 `wasm32-wasip1` **모듈**로 빌드된다. Wasmtime의 컴포넌트 모델은
 * **컴포넌트**를 요구한다. 그 사이에 preview1 → preview2 어댑터가 있다.
 *
 * ## 필요한 도구
 *
 * | 도구 | 용도 | 없으면 |
 * |------|------|--------|
 * | `cargo` + `wasm32-wasip1` 타깃 | 게스트 모듈 빌드 | 여기서 멈춘다 |
 * | `wit-bindgen` | WIT 바인딩 생성 | cargo 가 실패한다 |
 * | `wasm-tools` | preview1 → 컴포넌트 | 여기서 멈춘다 |
 * | WASI 어댑터 | preview1 ABI 변환 | 여기서 멈춘다 |
 *
 * ## 쓰기
 *
 *   node scripts/build-sandbox-guest.mjs
 *   WASI_ADAPTER=/path/to/wasi_snapshot_preview1.reactor.wasm node scripts/build-sandbox-guest.mjs
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync }      from "node:fs";
import { dirname, join }              from "node:path";
import { fileURLToPath }               from "node:url";

const here     = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const crateDir = join(repoRoot, "crates", "parism-sandbox-guest");
const outFile  = join(repoRoot, "crates", "parism-sandbox", "tests", "fixtures", "sandbox-guest.component.wasm");

/** WASI preview1 → preview2 어댑터. */
const adapter = process.env.WASI_ADAPTER
  ?? join(process.env.HOME ?? "/root", ".cache", "parism", "wasi_snapshot_preview1.reactor.wasm");

/** 도구가 없으면 **조용히 지나가지 않는다** — 무엇이 없는지 알려 준다. */
function requireTool(name, hint) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
  } catch {
    console.error(`${name} 이(가) 없습니다. ${hint}`);
    process.exit(1);
  }
}

requireTool("cargo", "Rust 툴체인을 설치하세요 (https://rustup.rs).");
requireTool("wasm-tools", "wasm-tools 를 설치하세요 (https://github.com/bytecodealliance/wasm-tools/releases).");

/** 어댑터가 없으면 받아 온다. */
if (!existsSync(adapter)) {
  const url = "https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0/wasi_snapshot_preview1.reactor.wasm";
  console.log(`어댑터를 받는다: ${url}`);
  mkdirSync(dirname(adapter), { recursive: true });
  execFileSync("curl", ["-sL", "-o", adapter, url], { stdio: "inherit" });
}

console.log("게스트 모듈 빌드 (wasm32-wasip1)");
execFileSync("cargo", ["build", "--release", "--target", "wasm32-wasip1"], { cwd: crateDir, stdio: "inherit" });

const module = join(crateDir, "target", "wasm32-wasip1", "release", "parism_sandbox_guest.wasm");
if (!existsSync(module)) {
  console.error(`게스트 모듈이 없다: ${module}`);
  process.exit(1);
}

console.log("preview1 → preview2 어댑트 → 컴포넌트");
mkdirSync(dirname(outFile), { recursive: true });
execFileSync("wasm-tools", [
  "component", "new", module,
  "--adapt", `wasi_snapshot_preview1=${adapter}`,
  "-o", outFile,
], { stdio: "inherit" });

console.log(`컴포넌트: ${outFile}`);
