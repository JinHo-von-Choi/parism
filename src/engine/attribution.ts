/**
 * 실패 × 변경 교차 귀속.
 *
 * 시험·빌드·린트가 실패를 보고하면, 작업 트리에서 HEAD 이후 바뀐 줄과 대조해
 * 실패마다 "방금 고친 줄에서 났는가"를 붙인다.
 *
 *   modified_line  바뀐 헝크의 줄 범위 안에서 났다
 *   modified_file  바뀐 파일의 다른 줄에서 났다
 *   unmodified     작업 트리에서 건드리지 않은 파일에서 났다
 *
 * 실패의 file·line이 바뀌지 않은 파일을 가리켜도 메시지 안의 스택 프레임(`경로:줄`)이
 * 바뀐 줄을 가리키면 modified_line으로 보고 그 프레임을 attribution_frame에 적는다.
 *
 * 실패한 파일이 바뀌지 않았으면, 그 파일이 상대 경로로 가져오는 파일 가운데 바뀐 것을 imports_changed에 적는다.
 * 시험 파일의 assert에서 난 실패의 원인이 시험이 부르는 코드에 있는 경우를 가리킨다.
 *
 * 비교 대상은 `git diff --unified=0 HEAD`(커밋이 없으면 빈 트리)와 추적되지 않는 파일이다.
 * 추적되지 않는 파일은 모든 줄이 바뀐 줄이다. 저장소 설정의 외부 diff, textconv, hooks는 쓰지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { spawn }       from "node:child_process";
import { readFileSync } from "node:fs";
import path            from "node:path";
import { buildExecArgs } from "./policy.js";

export type Attribution = "modified_line" | "modified_file" | "unmodified";

interface Hunk {
  /** 새 파일 기준 시작 줄(1부터). 줄을 지우기만 한 헝크는 지운 자리 바로 앞 줄이다. */
  start:   number;
  /** 새 파일 기준 끝 줄(포함) */
  end:     number;
  /** 헝크의 바뀐 줄 앞부분(최대 3줄) */
  preview: string[];
}

export interface ChangedFile {
  hunks:      Hunk[];
  /** 추적되지 않는 새 파일이면 true. 모든 줄이 바뀐 줄이다. */
  untracked?: true;
}

export interface WorkingTreeChanges {
  /** 저장소 최상위 경로 */
  root:  string;
  /** 저장소 기준 경로 → 바뀐 내용 */
  files: Map<string, ChangedFile>;
}

/** git diff를 읽는 출력 상한. 넘으면 귀속을 하지 않는다. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const EMPTY_TREE     = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PREVIEW_LINES  = 3;
const PREVIEW_CHARS  = 160;

function git(args: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let child;
    try {
      child = spawn("git", buildExecArgs("git", args), {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      resolve({ ok: false, text: "" });
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_DIFF_BYTES) chunks.push(chunk);
    });
    child.on("error", () => resolve({ ok: false, text: "" }));
    child.on("close", code => resolve({ ok: code === 0 && size <= MAX_DIFF_BYTES, text: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** `git diff --unified=0`을 파일별 헝크로 읽는다 */
export function parseUnifiedDiff(text: string): Map<string, ChangedFile> {
  const files = new Map<string, ChangedFile>();
  let current: ChangedFile | undefined;
  let hunk:    Hunk | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target === "/dev/null") { current = undefined; continue; }
      const file = target.startsWith("b/") ? target.slice(2) : target;
      current = { hunks: [] };
      files.set(unquote(file), current);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("diff --git ")) { current = undefined; hunk = undefined; continue; }
    const header = /^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@/.exec(line);
    if (header && current) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      hunk = count === 0
        ? { start: Math.max(1, start), end: Math.max(1, start), preview: [] }
        : { start, end: start + count - 1, preview: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith("+") || line.startsWith("-")) && hunk.preview.length < PREVIEW_LINES) {
      hunk.preview.push(line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line);
    }
  }
  return files;
}

/** git이 따옴표로 감싼 경로("a\tb")를 푼다 */
function unquote(file: string): string {
  if (!file.startsWith("\"") || !file.endsWith("\"")) return file;
  try {
    return JSON.parse(file) as string;
  } catch {
    return file.slice(1, -1);
  }
}

/** cwd가 속한 저장소의 작업 트리 변경. git 저장소가 아니거나 읽지 못하면 undefined */
export async function workingTreeChanges(cwd: string): Promise<WorkingTreeChanges | undefined> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return undefined;
  const root = top.text.trim();
  if (root === "") return undefined;
  const head = await git(["rev-parse", "--verify", "HEAD"], root);
  const diff = await git(["diff", "--unified=0", "--no-color", "--no-renames", head.ok ? "HEAD" : EMPTY_TREE], root);
  if (!diff.ok) return undefined;
  const files = parseUnifiedDiff(diff.text);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  if (untracked.ok) {
    for (const file of untracked.text.split("\0")) if (file !== "") files.set(file, { hunks: [], untracked: true });
  }
  return { root, files };
}

/** 메시지 안의 `경로:줄` 스택 프레임 */
const FRAME = /((?:[A-Za-z]:)?[A-Za-z0-9_@./\\-]+\.[A-Za-z0-9]{1,5}):([0-9]+)(?::[0-9]+)?/g;

interface Located {
  file?:    unknown;
  line?:    unknown;
  message?: unknown;
}

interface Verdict {
  attribution:        Attribution;
  diff_hunk_preview?: string;
  attribution_frame?: string;
  /** 실패한 파일이 바뀌지 않았을 때, 그 파일이 상대 경로로 가져오는 파일 가운데 바뀐 것 */
  imports_changed?:   string[];
}

/** 소스 파일의 상대 경로 import·require 대상 */
const IMPORT = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"];

/**
 * 파일이 가져오는 바뀐 파일. 실패가 시험 파일의 assert에서 났어도 원인은 그 시험이 부르는 코드에 있는 경우가 많다.
 * .js로 적은 import가 .ts 원본을 가리키는 경우(NodeNext)도 찾는다.
 */
function changedImports(file: string, cwd: string, changes: WorkingTreeChanges): string[] {
  let text: string;
  try {
    text = readFileSync(path.resolve(cwd, file), "utf8");
  } catch {
    return [];
  }
  if (text.length > 512 * 1024) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1]!;
    const base = path.resolve(path.dirname(path.resolve(cwd, file)), spec);
    const bases = [base, base.replace(/\.(m|c)?js$/, "")];
    for (const b of bases) {
      for (const ext of EXTENSIONS) {
        const rel = path.relative(changes.root, b + ext).split(path.sep).join("/");
        if (changes.files.has(rel)) out.add(path.relative(cwd, b + ext).split(path.sep).join("/"));
      }
    }
  }
  return [...out].sort();
}

/** 실패 하나를 귀속한다. 파일이 없는 실패(프로젝트 전체 진단 등)는 undefined다. */
function attributeOne(item: Located, cwd: string, changes: WorkingTreeChanges): Verdict | undefined {
  const lookup = (file: string): ChangedFile | undefined => {
    const rel = path.relative(changes.root, path.resolve(cwd, file)).split(path.sep).join("/");
    return rel.startsWith("..") ? undefined : changes.files.get(rel);
  };
  const lineHit = (changed: ChangedFile, line: number): Hunk | "all" | undefined =>
    changed.untracked ? "all" : changed.hunks.find(h => line >= h.start && line <= h.end);

  let verdict: Verdict | undefined;
  if (typeof item.file === "string" && item.file !== "") {
    const changed = lookup(item.file);
    if (!changed) {
      const imported = changedImports(item.file, cwd, changes);
      verdict = { attribution: "unmodified", ...(imported.length > 0 && { imports_changed: imported }) };
    }
    else {
      const hit = typeof item.line === "number" ? lineHit(changed, item.line) : undefined;
      verdict = hit === undefined
        ? { attribution: "modified_file" }
        : { attribution: "modified_line", ...(hit !== "all" && hit.preview.length > 0 && { diff_hunk_preview: hit.preview.join("\n") }) };
    }
  }
  if (verdict?.attribution === "modified_line") return verdict;

  /** 실패 위치가 바뀐 줄이 아니면 스택 프레임에서 바뀐 줄을 찾는다. */
  if (typeof item.message === "string") {
    for (const m of item.message.matchAll(FRAME)) {
      const changed = lookup(m[1]!);
      if (!changed) continue;
      const hit = lineHit(changed, Number(m[2]));
      if (hit === undefined) continue;
      return {
        attribution: "modified_line",
        attribution_frame: `${m[1]}:${m[2]}`,
        ...(hit !== "all" && hit.preview.length > 0 && { diff_hunk_preview: hit.preview.join("\n") }),
      };
    }
  }
  return verdict;
}

export interface AttributionSummary {
  modified_line: number;
  modified_file: number;
  unmodified:    number;
}

/**
 * 시험·진단 보고서의 failures[] 또는 diagnostics[]에 귀속을 붙인 사본을 돌려준다.
 * 실패가 없거나 git 저장소가 아니면 입력을 그대로 돌려준다.
 */
export async function attributeReport<T>(report: T, cwd: string): Promise<T> {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return report;
  const source = report as Record<string, unknown>;
  const key    = Array.isArray(source.failures) ? "failures" : Array.isArray(source.diagnostics) ? "diagnostics" : undefined;
  if (!key || (source[key] as unknown[]).length === 0) return report;
  const changes = await workingTreeChanges(cwd);
  if (!changes) return report;

  const summary: AttributionSummary = { modified_line: 0, modified_file: 0, unmodified: 0 };
  const rows = (source[key] as unknown[]).map(row => {
    if (row === null || typeof row !== "object") return row;
    const verdict = attributeOne(row as Located, cwd, changes);
    if (!verdict) return row;
    summary[verdict.attribution]++;
    return { ...(row as Record<string, unknown>), ...verdict };
  });
  return { ...source, [key]: rows, attribution: { ...summary, changed_files: changes.files.size } } as T;
}
