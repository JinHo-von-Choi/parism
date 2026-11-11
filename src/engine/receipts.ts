/**
 * 실행 영수증.
 *
 * 영수증은 "이 명령이 이 작업 공간 상태에서 이 결과로 끝났다"는 기록이다.
 * 하네스(Stop 훅, CI)가 `parism receipts check`로 완료 보고를 확인하는 데 쓴다.
 *
 * 영수증이 말하지 않는 것:
 * - 시험이 요구를 제대로 검사하는지
 * - .gitignore로 제외된 파일과 저장소 밖의 변화
 * 영수증 파일을 직접 고칠 수 있는 환경에서는 위조를 막지 못한다. 서명(key_file)은
 * Parism을 거치지 않고는 키 파일을 읽을 수 없는 환경에서만 위조를 막는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { spawn }                                        from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path                                             from "node:path";
import { buildExecArgs }                                from "./policy.js";
import { realPathOf }                                   from "./guard.js";

/** 영수증에 싣는 결과 요약. 파서가 시험·진단 보고서를 낸 실행에만 있다. */
export type ReceiptSummary =
  | { kind: "test";        passed: number; failed: number; skipped: number; files_failed: number }
  | { kind: "diagnostics"; errors: number; warnings: number };

/** 실행이 끝난 시점의 작업 공간 상태 */
export interface WorkspaceState {
  /** git 저장소 최상위 경로 */
  root:         string;
  git_head:     string;
  /** HEAD, 변경 목록, HEAD 대비 변경 내용, 추적되지 않는 파일 내용을 묶은 해시 */
  state_digest: string;
  /** state_digest에 들어간 범위 */
  covers:       ("tracked" | "staged" | "untracked_names" | "untracked_content")[];
  /** 추적되지 않는 파일이 한도를 넘어 내용 해시를 뺐을 때만 있다 */
  untracked_skipped?: { files: number; reason: string };
}

export interface Receipt {
  id:              string;
  cmd:             string;
  /** 실제로 실행한 인자 */
  args:            string[];
  /** 호출자가 준 인자. 실행 전 인자 변환(machine_format)으로 달라졌을 때만 있다. */
  args_requested?: string[];
  cwd:             string;
  exit_code:       number;
  started_at:      string;
  duration_ms:     number;
  summary?:        ReceiptSummary;
  /** 파싱한 출력(표준 출력, 또는 러너가 쓴 보고서)의 SHA-256 */
  output_sha256:   string;
  /** 출력이 수집 상한에서 잘렸을 때만 있다 */
  truncated?:      true;
  /** 실행 실패 사유(timeout, cancelled, spawn_failed 등). 정상 종료와 0이 아닌 종료 코드에는 없다. */
  failure_reason?: string;
  workspace?:      WorkspaceState;
  /** HMAC-SHA256 서명. 서명 키를 설정했을 때만 있다. */
  sig?:            string;
}

export interface WorkspaceLimits {
  untrackedMaxFiles: number;
  untrackedMaxBytes: number;
}

/** 파싱 결과에서 영수증 요약을 꺼낸다. 시험·진단 보고서가 아니면 undefined. */
export function summarize(parsed: unknown): ReceiptSummary | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  const n = (key: string): number | undefined => typeof r[key] === "number" ? r[key] as number : undefined;
  if (r.kind === "test" && n("passed") !== undefined && n("failed") !== undefined) {
    return { kind: "test", passed: n("passed")!, failed: n("failed")!, skipped: n("skipped") ?? 0, files_failed: n("files_failed") ?? 0 };
  }
  if (r.kind === "diagnostics" && n("errors") !== undefined) {
    return { kind: "diagnostics", errors: n("errors")!, warnings: n("warnings") ?? 0 };
  }
  return undefined;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function newReceiptId(): string {
  return `rcp_${randomBytes(9).toString("base64url")}`;
}

// ── 작업 공간 상태 ─────────────────────────────────────────────────────────

/** git을 실행해 표준 출력의 해시와 앞부분 텍스트를 얻는다. 저장소 설정의 외부 프로그램은 실행하지 않는다. */
function runGit(args: string[], cwd: string, keepText: boolean): Promise<{ ok: boolean; sha: string; text: string }> {
  return new Promise(resolve => {
    const hash   = createHash("sha256");
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn("git", buildExecArgs("git", args), {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      resolve({ ok: false, sha: "", text: "" });
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (keepText) chunks.push(chunk);
    });
    child.on("error", () => resolve({ ok: false, sha: "", text: "" }));
    child.on("close", code => resolve({
      ok: code === 0, sha: hash.digest("hex"), text: keepText ? Buffer.concat(chunks).toString("utf8") : "",
    }));
  });
}

function hashFile(file: string): Promise<string | null> {
  return new Promise(resolve => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", chunk => hash.update(chunk))
      .on("error", () => resolve(null))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** porcelain v2 -z 출력에서 추적되지 않는 파일 경로를 꺼낸다. */
function untrackedPaths(statusZ: string): string[] {
  return statusZ.split("\0").filter(entry => entry.startsWith("? ")).map(entry => entry.slice(2)).sort();
}

/**
 * cwd가 속한 git 저장소의 현재 상태를 계산한다. git 저장소가 아니거나 git을 실행할 수 없으면 undefined.
 *
 * 포함하는 것: HEAD, 변경 목록(스테이징과 추적되지 않는 파일 이름 포함), HEAD 대비 변경 내용,
 * 추적되지 않는 파일의 내용(한도 안일 때).
 * 포함하지 않는 것: .gitignore로 제외된 파일, 서브모듈 안의 변경, 저장소 밖.
 */
export async function workspaceState(cwd: string, limits: WorkspaceLimits): Promise<WorkspaceState | undefined> {
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd, true);
  if (!top.ok) return undefined;
  const root = top.text.trim();
  if (root === "") return undefined;

  const head   = await runGit(["rev-parse", "--verify", "HEAD"], root, true);
  const status = await runGit(["status", "--porcelain=v2", "--untracked-files=all", "-z"], root, true);
  if (!status.ok) return undefined;

  /** 커밋이 하나도 없는 저장소에는 HEAD가 없다. 스테이징과 작업 트리의 변경을 따로 본다. */
  const diffs = head.ok
    ? [await runGit(["diff", "HEAD", "--binary"], root, false)]
    : [await runGit(["diff", "--cached", "--binary"], root, false), await runGit(["diff", "--binary"], root, false)];
  if (diffs.some(d => !d.ok)) return undefined;

  const covers: WorkspaceState["covers"] = ["tracked", "staged", "untracked_names"];
  const files  = untrackedPaths(status.text);
  const parts  = createHash("sha256");
  let   skipped: WorkspaceState["untracked_skipped"];

  if (files.length > limits.untrackedMaxFiles) {
    skipped = { files: files.length, reason: `more than ${limits.untrackedMaxFiles} untracked files` };
  } else {
    let total = 0;
    for (const rel of files) {
      const file = path.join(root, rel);
      let size: number;
      try {
        const info = statSync(file);
        if (!info.isFile()) continue;
        size = info.size;
      } catch {
        continue;
      }
      total += size;
      if (total > limits.untrackedMaxBytes) {
        skipped = { files: files.length, reason: `untracked files exceed ${limits.untrackedMaxBytes} bytes` };
        break;
      }
      parts.update(`${rel}\0${await hashFile(file) ?? "unreadable"}\0`);
    }
  }
  if (!skipped) covers.push("untracked_content");

  const digest = createHash("sha256")
    .update(head.ok ? head.text.trim() : "no-head").update("\0")
    .update(status.sha).update("\0")
    .update(diffs.map(d => d.sha).join(":")).update("\0")
    .update(skipped ? "untracked-content-skipped" : parts.digest("hex"))
    .digest("hex");

  return {
    root,
    git_head:     head.ok ? head.text.trim().slice(0, 12) : "",
    state_digest: digest,
    covers,
    ...(skipped && { untracked_skipped: skipped }),
  };
}

// ── 서명 ───────────────────────────────────────────────────────────────────

/** 서명 대상 문자열. sig를 뺀 영수증을 기록된 키 순서 그대로 직렬화한다. */
function signedBody(receipt: Receipt): string {
  const body: Partial<Receipt> = { ...receipt };
  delete body.sig;
  return JSON.stringify(body);
}

export function signReceipt(receipt: Receipt, key: Buffer): Receipt {
  return { ...receipt, sig: createHmac("sha256", key).update(signedBody(receipt)).digest("hex") };
}

export function signatureValid(receipt: Receipt, key: Buffer): boolean {
  if (typeof receipt.sig !== "string") return false;
  const expected = createHmac("sha256", key).update(signedBody(receipt)).digest();
  const given    = Buffer.from(receipt.sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 서명 키를 읽는다. 키 파일이 가드가 읽기를 허용한 경로 안에 있으면 쓰지 않는다.
 * 그 위치의 키는 Parism 명령으로 읽을 수 있어 서명이 의미를 잃는다.
 */
export function loadSigningKey(keyFile: string | undefined, allowedPaths: readonly string[]): { key?: Buffer; warning?: string } {
  if (!keyFile) return {};
  let real: string;
  try {
    real = realPathOf(keyFile);
  } catch {
    return { warning: `receipts.key_file ${keyFile} cannot be resolved; receipts are not signed` };
  }
  const inside = allowedPaths.some(root => {
    const base = realPathOf(root);
    return real === base || real.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
  if (inside || allowedPaths.length === 0) {
    return { warning: "receipts.key_file is inside guard.allowed_paths (or paths are unrestricted), so commands could read it; receipts are not signed" };
  }
  try {
    const key = readFileSync(real);
    if (key.length < 16) return { warning: "receipts.key_file is shorter than 16 bytes; receipts are not signed" };
    return { key };
  } catch (err) {
    return { warning: `receipts.key_file cannot be read (${(err as Error).message}); receipts are not signed` };
  }
}

// ── 보관 ───────────────────────────────────────────────────────────────────

export interface ReceiptRetention {
  maxEntries: number;
  maxAgeDays: number;
}

/** 줄 단위 JSON 파일에 영수증을 남긴다. 결과 본문은 남기지 않는다. */
export class ReceiptStore {
  readonly file: string;

  constructor(dir: string, private readonly retention: ReceiptRetention) {
    this.file = path.join(dir, "receipts.jsonl");
  }

  append(receipt: Receipt): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    this.prune();
  }

  /** 기록된 영수증을 오래된 순서로 읽는다. 읽을 수 없는 줄은 건너뛴다. */
  list(): Receipt[] {
    if (!existsSync(this.file)) return [];
    const out: Receipt[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const value = JSON.parse(line) as Receipt;
        if (typeof value.id === "string" && typeof value.cmd === "string" && Array.isArray(value.args)) out.push(value);
      } catch {
        /** 깨진 줄은 영수증이 아니다. */
      }
    }
    return out;
  }

  /** 보관 기간이 지났거나 개수를 넘은 영수증을 오래된 것부터 지운다. */
  private prune(): void {
    const all    = this.list();
    const cutoff = Date.now() - this.retention.maxAgeDays * 86_400_000;
    const fresh  = all.filter(r => !(Date.parse(r.started_at) < cutoff));
    const kept   = fresh.slice(Math.max(0, fresh.length - this.retention.maxEntries));
    if (kept.length === all.length) return;
    writeFileSync(this.file, kept.map(r => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : ""), { mode: 0o600 });
  }
}

// ── 검증 ───────────────────────────────────────────────────────────────────

export type CheckVerdict = "ok" | "missing" | "failed" | "stale" | "unverifiable" | "bad_signature";

export interface CheckItem {
  command: string[];
  verdict: CheckVerdict;
  detail:  string;
  receipt_id?: string;
}

export interface CheckReport {
  ok:    boolean;
  cwd:   string;
  items: CheckItem[];
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function describeFailure(receipt: Receipt): string | undefined {
  if (receipt.failure_reason) return `the run ended with ${receipt.failure_reason}`;
  if (receipt.exit_code !== 0) return `exit code ${receipt.exit_code}`;
  const s = receipt.summary;
  if (s?.kind === "test" && (s.failed > 0 || s.files_failed > 0)) return `${s.failed} failed test(s), ${s.files_failed} file(s) that did not run`;
  if (s?.kind === "diagnostics" && s.errors > 0) return `${s.errors} error(s)`;
  return undefined;
}

/**
 * 명령마다 가장 최근 영수증을 찾아 통과 여부를 판정한다.
 *
 *   missing       이 작업 공간에서 그 명령을 실행한 영수증이 없다
 *   bad_signature 서명 키가 있는데 서명이 맞지 않는다
 *   failed        종료 코드가 0이 아니거나 실패한 시험·오류가 있다
 *   unverifiable  영수증에 작업 공간 상태가 없다(git 저장소가 아니었다)
 *   stale         실행 뒤 작업 공간이 바뀌었다
 *
 * 명령을 다시 실행하지 않는다.
 */
export async function checkReceipts(input: {
  receipts: readonly Receipt[];
  commands: readonly (readonly string[])[];
  cwd:      string;
  limits:   WorkspaceLimits;
  key?:     Buffer;
}): Promise<CheckReport> {
  const current = await workspaceState(input.cwd, input.limits);
  const realCwd = realPathOf(input.cwd);
  const items: CheckItem[] = [];

  for (const command of input.commands) {
    const [cmd, ...args] = command;
    const matches = input.receipts.filter(r =>
      r.cmd === cmd
      && (sameArgs(r.args_requested ?? r.args, args) || sameArgs(r.args, args))
      && (current && r.workspace ? r.workspace.root === current.root : realPathOf(r.cwd) === realCwd));
    const latest = matches.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).at(-1);
    const item = (verdict: CheckVerdict, detail: string): void => {
      items.push({ command: [...command], verdict, detail, ...(latest && { receipt_id: latest.id }) });
    };

    if (!latest) { item("missing", "no receipt for this command in this workspace"); continue; }
    if (input.key && !signatureValid(latest, input.key)) { item("bad_signature", "the receipt signature does not match the signing key"); continue; }
    const failure = describeFailure(latest);
    if (failure) { item("failed", failure); continue; }
    if (!latest.workspace || !current) { item("unverifiable", "no workspace state to compare (not a git repository)"); continue; }
    if (latest.workspace.state_digest !== current.state_digest) { item("stale", `the workspace changed after the run at ${latest.started_at}`); continue; }
    item("ok", `passed at ${latest.started_at}`);
  }
  return { ok: items.every(i => i.verdict === "ok"), cwd: realCwd, items };
}
