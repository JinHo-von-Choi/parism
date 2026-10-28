/**
 * 네이티브 정규식 엔진 플랫폼 패키지 목록.
 *
 * ## 왜 한 곳에 모아두는가
 *
 * 세 곳이 같은 목록을 알아야 한다.
 *
 * 1. **패키지 이름** — npm 에 게시되는 `@nerdvana/parism-regex-*` 8종.
 * 2. **Cargo 타깃** — 각 패키지가 담을 바이너리의 빌드 타깃.
 * 3. **게이팅 필드** — npm 이 어떤 호스트에 설치할지 정하는 `os`·`cpu`·`libc`.
 *
 * 셋 중 하나라도 어긋나면 **조용히** 설치가 빠진다 — 게다가 그 호스트에서
 * 정규식 엔진이 없는 것을 아무도 모른다. 그래서 한 파일에서 만든다.
 *
 * ## 이름 규칙
 *
 * `@nerdvana/parism-regex-<os>-<cpu>[-<libc>]`
 *
 * `src/engine/regex-native.ts` 의 `nativePackageName()` 이 **똑같은 규칙**으로 이름을 만든다.
 * 규칙이 바뀌면 양쪽 다 바뀌어야 한다 — 그게 이 파일이 존재하는 이유다.
 *
 * @typedef {object} NativePlatform
 * @property {string}   package  npm 패키지 이름 (`@nerdvana/` 제외).
 * @property {string}   target   Cargo 빌드 타깃.
 * @property {string[]} os       npm `os` 게이팅 필드.
 * @property {string[]} cpu      npm `cpu` 게이팅 필드.
 * @property {string[]} [libc]   npm `libc` 게이팅 필드. libc 가 없으면 이 필드 자체를 넣지 않는다.
 * @property {boolean}  local    이 호스트에서 개발 중 빌드로 얻을 수 있는지.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

/**
 * 8종 플랫폼 목록.
 *
 * `local: true` 인 것은 이 호스트에서 바로 빌드할 수 있다.
 * 나머지는 CI 크로스 빌드가 필요하고 **로컬에서는 만들 수 없다.**
 *
 * @type {NativePlatform[]}
 */
export const NATIVE_PLATFORMS = [
  {
    package: "parism-regex-darwin-arm64",
    target:  "aarch64-apple-darwin",
    os:      ["darwin"],
    cpu:     ["arm64"],
    local:   false,
  },
  {
    package: "parism-regex-darwin-x64",
    target:  "x86_64-apple-darwin",
    os:      ["darwin"],
    cpu:     ["x64"],
    local:   false,
  },
  {
    package: "parism-regex-linux-x64-gnu",
    target:  "x86_64-unknown-linux-gnu",
    os:      ["linux"],
    cpu:     ["x64"],
    libc:    ["glibc"],
    local:   true,
  },
  {
    package: "parism-regex-linux-x64-musl",
    target:  "x86_64-unknown-linux-musl",
    os:      ["linux"],
    cpu:     ["x64"],
    libc:    ["musl"],
    local:   false,
  },
  {
    package: "parism-regex-linux-arm64-gnu",
    target:  "aarch64-unknown-linux-gnu",
    os:      ["linux"],
    cpu:     ["arm64"],
    libc:    ["glibc"],
    local:   false,
  },
  {
    package: "parism-regex-linux-arm64-musl",
    target:  "aarch64-unknown-linux-musl",
    os:      ["linux"],
    cpu:     ["arm64"],
    libc:    ["musl"],
    local:   false,
  },
  {
    package: "parism-regex-win32-x64-msvc",
    target:  "x86_64-pc-windows-msvc",
    os:      ["win32"],
    cpu:     ["x64"],
    libc:    ["msvc"],
    local:   false,
  },
  {
    package: "parism-regex-win32-ia32-msvc",
    target:  "i686-pc-windows-msvc",
    os:      ["win32"],
    cpu:     ["ia32"],
    libc:    ["msvc"],
    local:   false,
  },
];

/**
 * npm 패키지 전체 이름.
 * @param {NativePlatform} platform
 * @returns {string}
 */
export function scopedName(platform) {
  return `@nerdvana/${platform.package}`;
}
