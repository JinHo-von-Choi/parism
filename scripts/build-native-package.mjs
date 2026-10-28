#!/usr/bin/env node
/**
 * 네이티브 정규식 엔진 플랫폼 패키지 만들기.
 *
 * ## 하는 일
 *
 * 1. `packages/parism-regex-*` 8종의 `package.json` 을 만든다.
 * 2. 요청한 타깃의 Rust 바이너리를 빌드해서 그 패키지의 `bin/` 에 넣는다.
 *
 * ## 왜 스크립트인가
 *
 * 패키지 8종을 손으로 쓰면 **셋 중 하나가 조용히 어긋난다** —
 * 이름, 게이팅 필드, 담기는 바이너리. 한 곳에서 만들고 한 곳에서 읽는다.
 *
 * ## 쓰기
 *
 *   node scripts/build-native-package.mjs --all                  # package.json 8종만
 *   node scripts/build-native-package.mjs --target x86_64-unknown-linux-gnu
 *   node scripts/build-native-package.mjs --target x86_64-unknown-linux-musl --cross
 *
 * `--cross` 는 `cross` 로 컨테이너 안에서 빌드한다 (리눅스 크로스 타깃용).
 *
 * ## 산출물
 *
 *   packages/parism-regex-linux-x64-gnu/package.json
 *   packages/parism-regex-linux-x64-gnu/bin/parism-regex
 *
 * `bin/` 은 **커밋하지 않는다** — 빌드 산출물이다. CI 가 만들어 게시한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join }         from "node:path";
import { fileURLToPath }          from "node:url";

import { NATIVE_PLATFORMS, scopedName } from "./native-platforms.mjs";

const here     = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const pkgDir   = join(repoRoot, "packages");

/** 메인 패키지에서 버전을 읽는다 — 플랫폼 패키지는 같은 버전을 공유한다. */
function mainVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

const args = process.argv.slice(2);

/** `--target <cargo target>` */
function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const target = flagValue("--target");
const all    = args.includes("--all");
const cross  = args.includes("--cross");

if (!all && !target) {
  console.error("사용법: node scripts/build-native-package.mjs --all | --target <cargo-target> [--cross]");
  process.exit(1);
}

/** 플랫폼 패키지의 package.json 을 만든다. */
function writePackageJson(platform) {
  const dir = join(pkgDir, platform.package);
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: scopedName(platform),
    version: mainVersion(),
    description: "역추적 불가능 정규식 엔진 (parism 용). 사전 빌드된 바이너리.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/JinHo-von-Choi/parism.git",
    },
    /** 이 패키지는 실행 파일만 담는다 — Node 코드가 없다. */
    files: ["bin"],
    os: platform.os,
    cpu: platform.cpu,
    ...(platform.libc ? { libc: platform.libc } : {}),
    /** 이진 패키지는 압축 해제하지 않는다 — 설치가 실패할 이유를 늘리지 않는다. */
    preferUnplugged: true,
  };

  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return dir;
}

/** Rust 바이너리를 빌드해서 패키지 `bin/` 에 넣는다. */
function buildBinary(platform) {
  const dir = join(pkgDir, platform.package);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  const cargoArgs = ["build", "--release", "--manifest-path", join(repoRoot, "crates/parism-regex/Cargo.toml")];
  const explicitTarget = platform.target !== hostTarget();
  if (explicitTarget) cargoArgs.push("--target", platform.target);

  console.log(`빌드: ${platform.package} (${platform.target})`);
  if (cross) {
    execFileSync("cross", cargoArgs, { stdio: "inherit", cwd: repoRoot });
  } else {
    execFileSync("cargo", cargoArgs, { stdio: "inherit", cwd: repoRoot });
  }

  const extension = platform.os.includes("win32") ? ".exe" : "";
  /**
   * `--target` 을 명시하면 cargo 는 `target/<타깃>/release/` 에 낸다.
   * 명시하지 않으면 `target/release/` 에 낸다. 경로를 헷갈리면 복사가 조용히 실패한다.
   */
  const outputDir = explicitTarget
    ? join(repoRoot, "crates/parism-regex/target", platform.target, "release")
    : join(repoRoot, "crates/parism-regex/target", "release");
  const built = join(outputDir, `parism-regex${extension}`);
  const dest = join(bin, `parism-regex${extension}`);
  copyFileSync(built, dest);
  chmodSync(dest, 0o755);
  console.log(`  → ${dest}`);
}

/** 이 호스트의 Cargo 타깃. */
function hostTarget() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line   = output.split("\n").find(l => l.startsWith("host: "));
  return line ? line.slice("host: ".length).trim() : "";
}

if (all) {
  for (const platform of NATIVE_PLATFORMS) {
    writePackageJson(platform);
    console.log(`생성: packages/${platform.package}/package.json`);
  }
  process.exit(0);
}

const platform = NATIVE_PLATFORMS.find(p => p.target === target);
if (!platform) {
  console.error(`알 수 없는 타깃: ${target}`);
  console.error(`사용 가능한 타깃:\n  ${NATIVE_PLATFORMS.map(p => p.target).join("\n  ")}`);
  process.exit(1);
}

writePackageJson(platform);
buildBinary(platform);
