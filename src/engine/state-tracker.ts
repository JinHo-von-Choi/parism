import { readdir, stat } from "node:fs/promises";
import type { DiffField } from "../types/envelope.js";

/**
 * 디렉토리 내 파일 경로 → mtime(ms) 맵.
 */
export type FileSnapshot = Map<string, number>;

async function walk(dir: string, depth: number, out: FileSnapshot): Promise<void> {
  if (depth < 0) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 권한 없음 등
  }

  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    try {
      const s = await stat(full);
      out.set(full, s.mtimeMs);
      if (entry.isDirectory()) await walk(full, depth - 1, out);
    } catch {
      // 개별 항목 오류 무시
    }
  }
}

/**
 * cwd 기준 depth 단계까지 재귀 스캔하여 파일 스냅샷을 반환한다.
 */
export async function takeSnapshot(cwd: string, depth = 2): Promise<FileSnapshot> {
  const snap: FileSnapshot = new Map();
  await walk(cwd, depth, snap);
  return snap;
}

/**
 * 두 스냅샷을 비교하여 생성/삭제/수정된 경로 목록을 반환한다.
 */
export function computeDiff(before: FileSnapshot, after: FileSnapshot): DiffField {
  const created:  string[] = [];
  const deleted:  string[] = [];
  const modified: string[] = [];

  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined)  created.push(path);
    else if (prev !== mtime) modified.push(path);
  }

  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }

  return { created, deleted, modified };
}
