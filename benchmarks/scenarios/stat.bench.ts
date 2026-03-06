import { parseStat }  from "../../src/parsers/fs/stat.js";
import type { Scenario, ExtractionResult } from "../types.js";

/**
 * Linux stat 출력에서 파일 크기와 권한을 추출하는 regex 기반 시뮬레이터.
 */
function extractRawStatLinux(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    const sizeMatch = raw.match(/Size:\s*(\d+)/);
    const permMatch = raw.match(/Access:\s*\(\d+\/([^)]+)\)/);
    const inodeMatch = raw.match(/Inode:\s*(\d+)/);
    const fileMatch  = raw.match(/File:\s*(.+)/);

    if (!sizeMatch || !fileMatch) {
      return { success: false, data: null, timeMs: Date.now() - start, errorMsg: "could not parse size or filename" };
    }

    return {
      success: true,
      data: {
        file:        fileMatch[1]?.trim(),
        size_bytes:  parseInt(sizeMatch[1]!, 10),
        permissions: permMatch?.[1]?.trim() ?? "unknown",
        inode:       inodeMatch ? parseInt(inodeMatch[1]!, 10) : 0,
      },
      timeMs: Date.now() - start,
    };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

/**
 * macOS stat 출력 파싱 시뮬레이터.
 * macOS stat는 레이블 없이 단일 줄 공백 구분 출력 — 파서가 Linux와 완전히 달라야 함.
 * Linux 파서를 macOS에 적용하면 regex가 하나도 매칭되지 않는다.
 */
function extractRawStatMacos(raw: string): ExtractionResult {
  const start = Date.now();
  try {
    // macOS stat: 16777220 [inode] [mode] [links] [uid] [gid] [rdev] [size] ...
    // (actually the BSD stat -s / -f format is different — this simulates naive failure)
    // A parser written for Linux stat will fail completely on macOS format
    const sizeMatch = raw.match(/Size:\s*(\d+)/);     // won't match
    const permMatch = raw.match(/Access:\s*\(\d+\/([^)]+)\)/);  // won't match

    if (!sizeMatch) {
      return {
        success:  false,
        data:     null,
        timeMs:   Date.now() - start,
        errorMsg: "Linux stat parser failed on macOS output (no 'Size:' label found)",
      };
    }

    return { success: true, data: {}, timeMs: Date.now() - start };
  } catch (e) {
    return { success: false, data: null, timeMs: Date.now() - start, errorMsg: String(e) };
  }
}

export const statLinuxScenario: Scenario = {
  name:        "stat: Linux format",
  description: "파일 메타데이터 추출 (Linux stat 형식 — 레이블 있음)",
  fixturePath: "stat-linux.txt",
  extractRaw:  extractRawStatLinux,

  rawContextPrompt: `stat 명령 출력을 파싱하세요 (Linux 형식).
레이블 기반 형식: "File:", "Size:", "Inode:", "Access: (mode/perms)", "Access:", "Modify:", "Change:", "Birth:"
주의: "Access:"가 두 번 등장 — 첫 번째는 권한, 두 번째는 타임스탬프.
파일 경로, 크기(bytes), 권한, inode 번호, 수정 시각을 추출하세요.`,

  jsonContextPrompt: `stdout.parsed 객체를 사용하세요.
필드: file, size_bytes, permissions, inode, links, uid, gid, accessed_at, modified_at, changed_at, birth_at`,
};

export const statMacosScenario: Scenario = {
  name:        "stat: macOS format (OS mismatch edge case)",
  description: "macOS stat는 레이블 없는 단일 줄 형식 — Linux 파서 적용 시 완전 실패",
  fixturePath: "stat-macos.txt",
  extractRaw:  extractRawStatMacos,  // Linux parser fails on macOS format

  rawContextPrompt: `stat 명령 출력을 파싱하세요.
주의: 이 출력은 macOS 형식입니다 (레이블 없음, 단일 줄, 공백 구분).
Linux stat 파서는 이 형식에서 동작하지 않습니다.
macOS stat 출력 필드 순서: dev ino mode nlink uid gid rdev size atime mtime ctime btime blksize blocks flags path
파일 크기(인덱스 7)와 경로(마지막 필드)를 추출하세요.`,

  jsonContextPrompt: `stdout.parsed 객체를 사용하세요.
Parism은 OS 무관하게 동일 구조 반환: file, size_bytes, permissions, inode, accessed_at, modified_at`,
};
