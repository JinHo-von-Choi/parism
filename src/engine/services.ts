/**
 * 임시 서비스 lease.
 *
 * run(mode: "service")는 서버처럼 끝나지 않는 명령을 띄우고, 준비될 때까지 기다린 뒤 바로 돌려준다.
 * 준비 판정은 출력에 ready_pattern이 나오거나 로컬 포트 ready_port가 열리는 것이다. 둘 다 없으면
 * 프로세스가 1초 동안 끝나지 않은 것을 준비로 본다.
 *
 * 서비스는 lease_ms(최대 5분)가 지나거나 서버가 끝나면 프로세스 그룹째 SIGTERM, 2초 뒤 SIGKILL로 종료한다.
 * persist를 주면(호스트 설정 tasks.allow_persistent_services일 때만) 서버가 끝나도 lease_ms까지 남는다.
 * 이때 출력은 파일로 받고, 별도 감시 프로세스가 lease 끝에 그룹을 종료한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { spawn, type ChildProcess }                  from "node:child_process";
import { randomBytes }                               from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import net                                           from "node:net";
import path                                          from "node:path";
import type { PrismConfig }                          from "../config/loader.js";
import type { ResponseEnvelope }                     from "../types/envelope.js";
import { buildSanitizedEnv, trackProcessGroup, untrackProcessGroup } from "./executor.js";
import { buildExecArgs }                             from "./policy.js";
import { DEFAULT_OUTPUT_REDACT_PATTERNS, redact }   from "./redactor.js";
import type { TaskLookup, TaskSnapshot }             from "./tasks.js";

/** 서비스 lease 상한(ms) */
export const MAX_LEASE_MS = 300_000;
/** 준비를 기다리는 상한(ms) */
export const MAX_READY_WAIT_MS = 30_000;
/** 준비 조건이 없을 때 준비로 보는 생존 시간(ms) */
const SETTLE_MS = 1_000;
/** 종료 신호 사이의 유예(ms) */
const TERM_GRACE_MS = 2_000;
/** 상태에 싣는 최근 출력 바이트 */
const TAIL_BYTES = 4_096;
/** 끝난 서비스의 상태를 보관하는 시간(ms) */
const FINISHED_TTL_MS = 600_000;

export interface ServiceOptions {
  /** 출력(표준 출력과 표준 오류)에 이 정규식이 나오면 준비로 본다 */
  ready_pattern?: string;
  /** 127.0.0.1(또는 ::1)의 이 포트가 연결을 받으면 준비로 본다 */
  ready_port?:    number;
  /** 서비스를 유지하는 시간(ms). 기본값과 상한은 5분이다. */
  lease_ms?:      number;
  /** 준비를 기다리는 시간(ms). 기본값과 상한은 30초다. */
  ready_timeout_ms?: number;
  /** 서버가 끝나도 lease_ms까지 남긴다. tasks.allow_persistent_services일 때만 받는다. */
  persist?:       boolean;
}

interface ServiceEntry {
  id:         string;
  cmd:        string;
  args:       string[];
  cwd:        string;
  startedAt:  number;
  leaseUntil: number;
  finishedAt?: number;
  state:      "starting" | "ready" | "completed" | "cancelled";
  readyReason?: string;
  exitCode?:  number | null;
  signal?:    string | null;
  child:      ChildProcess;
  pgid?:      number;
  /** 메모리로 받는 출력의 뒷부분. persist면 로그 파일에서 읽는다. */
  tail:       string;
  logFile?:   string;
  persist:    boolean;
  leaseTimer?: NodeJS.Timeout;
  waiters:    Set<() => void>;
  patterns:   string[];
}

export type ServiceStart =
  | { ok: true; task: TaskSnapshot }
  | { ok: false; reason: "service_slots_full" | "invalid_service" | "persist_not_allowed" | "spawn_failed"; message: string };

function signalGroup(entry: ServiceEntry, signal: NodeJS.Signals): void {
  if (entry.pgid === undefined) {
    /** 프로세스 그룹이 없는 플랫폼(Windows)은 자식에게만 보낸다. pid가 없는 자식에게는 보내지 않는다. */
    if (entry.child.pid !== undefined) entry.child.kill(signal);
    return;
  }
  try {
    process.kill(-entry.pgid, signal);
  } catch {
    /** 그룹이 이미 없으면 할 일이 없다. */
  }
}

function portOpen(port: number): Promise<boolean> {
  const attempt = (host: string) => new Promise<boolean>(resolve => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  return attempt("127.0.0.1").then(ok => ok || attempt("::1"));
}

/** 파일 끝의 maxBytes를 읽는다 */
function readTail(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size  = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf   = Buffer.alloc(size - start);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ServiceManager {
  private readonly entries = new Map<string, ServiceEntry>();

  constructor(private readonly limits: { maxConcurrency: number; allowPersistent: boolean; logDir: string }) {}

  has(id: string): boolean {
    return id.startsWith("svc_");
  }

  private get running(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === "starting" || e.state === "ready") n++;
    return n;
  }

  /** 서비스를 띄우고 준비되거나 끝나거나 준비 대기 시간이 지날 때까지 기다린다 */
  async start(meta: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }, config: PrismConfig, opts: ServiceOptions): Promise<ServiceStart> {
    this.prune();
    if (this.running >= this.limits.maxConcurrency) {
      return { ok: false, reason: "service_slots_full", message: `${this.running} service(s) are running and the limit is ${this.limits.maxConcurrency}; stop one with task(action='cancel')` };
    }
    if (opts.persist === true && !this.limits.allowPersistent) {
      return { ok: false, reason: "persist_not_allowed", message: "persist needs tasks.allow_persistent_services in the host config" };
    }
    if (opts.ready_port !== undefined && (!Number.isInteger(opts.ready_port) || opts.ready_port < 1 || opts.ready_port > 65535)) {
      return { ok: false, reason: "invalid_service", message: "ready_port must be an integer from 1 to 65535" };
    }
    let readyRe: RegExp | undefined;
    if (opts.ready_pattern !== undefined) {
      try {
        /** 출력의 끝부분 전체에 맞추므로 ^와 $가 줄마다 맞게 한다(`^Listening on`) */
        readyRe = new RegExp(opts.ready_pattern, "m");
      } catch (err) {
        return { ok: false, reason: "invalid_service", message: `ready_pattern is not a valid regular expression: ${(err as Error).message}` };
      }
    }
    const leaseMs = Math.min(Math.max(1_000, opts.lease_ms ?? MAX_LEASE_MS), MAX_LEASE_MS);
    const waitMs  = Math.min(Math.max(0, opts.ready_timeout_ms ?? MAX_READY_WAIT_MS), MAX_READY_WAIT_MS);
    const id      = `svc_${randomBytes(9).toString("base64url")}`;
    const persist = opts.persist === true;
    const env     = { ...buildSanitizedEnv(config.guard.secrets?.env_patterns ?? []), ...(meta.env ?? {}), GIT_TERMINAL_PROMPT: "0" };

    let logFile: string | undefined;
    let logFd:   number | undefined;
    if (persist) {
      mkdirSync(this.limits.logDir, { recursive: true, mode: 0o700 });
      logFile = path.join(this.limits.logDir, `${id}.log`);
      logFd   = openSync(logFile, "a", 0o600);
    }
    let child: ChildProcess;
    try {
      child = spawn(meta.cmd, buildExecArgs(meta.cmd, meta.args, config.guard), {
        cwd: meta.cwd, env, detached: process.platform !== "win32", windowsHide: true,
        stdio: persist ? ["ignore", logFd!, logFd!] : ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return { ok: false, reason: "spawn_failed", message: (err as Error).message };
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    const patterns = config.guard.secrets?.output_redaction_enabled === true
      ? config.guard.secrets.output_patterns ?? DEFAULT_OUTPUT_REDACT_PATTERNS
      : [];
    const entry: ServiceEntry = {
      id, cmd: meta.cmd, args: [...meta.args], cwd: meta.cwd, startedAt: Date.now(), leaseUntil: Date.now() + leaseMs,
      state: "starting", child, ...(child.pid !== undefined && process.platform !== "win32" && { pgid: child.pid }),
      tail: "", ...(logFile && { logFile }), persist, waiters: new Set(), patterns,
    };
    this.entries.set(id, entry);
    const wake = () => { for (const w of [...entry.waiters]) w(); };

    const spawnError = await new Promise<Error | undefined>(resolve => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", err => resolve(err));
    });
    if (spawnError) {
      this.entries.delete(id);
      return { ok: false, reason: "spawn_failed", message: spawnError.message };
    }

    if (entry.pgid !== undefined) {
      if (persist) {
        child.unref();
        this.spawnWatchdog(entry.pgid, leaseMs);
      } else {
        trackProcessGroup(entry.pgid);
      }
    }
    const onChunk = (chunk: Buffer) => {
      entry.tail = (entry.tail + chunk.toString("utf8")).slice(-TAIL_BYTES * 4);
      if (entry.state === "starting" && readyRe?.test(entry.tail)) {
        entry.state = "ready";
        entry.readyReason = `output matched ${opts.ready_pattern}`;
        wake();
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code, signal) => {
      entry.exitCode   = code;
      entry.signal     = signal;
      entry.finishedAt = Date.now();
      if (entry.state !== "cancelled") entry.state = "completed";
      if (entry.leaseTimer) clearTimeout(entry.leaseTimer);
      if (entry.pgid !== undefined && !persist) untrackProcessGroup(entry.pgid);
      wake();
    });
    entry.leaseTimer = setTimeout(() => this.stop(entry, "lease expired"), leaseMs);
    entry.leaseTimer.unref();

    await this.waitReady(entry, readyRe, opts.ready_port, waitMs);
    return { ok: true, task: await this.snapshot(entry) };
  }

  /** persist 서비스를 lease 끝에 종료하는 감시 프로세스. Parism 서버와 따로 산다. */
  private spawnWatchdog(pgid: number, leaseMs: number): void {
    const script = `setTimeout(()=>{try{process.kill(-${pgid},"SIGTERM")}catch{}setTimeout(()=>{try{process.kill(-${pgid},"SIGKILL")}catch{}process.exit(0)},${TERM_GRACE_MS})},${leaseMs})`;
    const dog = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", windowsHide: true });
    dog.unref();
  }

  private async waitReady(entry: ServiceEntry, readyRe: RegExp | undefined, port: number | undefined, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    const settleAt = entry.startedAt + SETTLE_MS;
    while (entry.state === "starting" && Date.now() < deadline) {
      if (entry.logFile && readyRe && readyRe.test(readTail(entry.logFile, TAIL_BYTES * 4))) {
        entry.state = "ready";
        entry.readyReason = `output matched ${readyRe.source}`;
        break;
      }
      if (port !== undefined && await portOpen(port)) {
        entry.state = "ready";
        entry.readyReason = `port ${port} accepts connections`;
        break;
      }
      if (!readyRe && port === undefined && Date.now() >= settleAt) {
        entry.state = "ready";
        entry.readyReason = `still running after ${SETTLE_MS} ms (no ready_pattern or ready_port given)`;
        break;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, 150);
        function done(): void { clearTimeout(timer); entry.waiters.delete(done); resolve(); }
        entry.waiters.add(done);
      });
    }
  }

  private stop(entry: ServiceEntry, why: string): void {
    if (entry.state === "completed" || entry.state === "cancelled") return;
    entry.state       = "cancelled";
    entry.readyReason = why;
    signalGroup(entry, "SIGTERM");
    const kill = setTimeout(() => signalGroup(entry, "SIGKILL"), TERM_GRACE_MS);
    kill.unref();
  }

  private async snapshot(entry: ServiceEntry): Promise<TaskSnapshot> {
    const raw  = entry.logFile ? readTail(entry.logFile, TAIL_BYTES) : entry.tail.slice(-TAIL_BYTES);
    const tail = entry.patterns.length > 0 ? await redact(raw, entry.patterns) : raw;
    const finished = entry.finishedAt !== undefined;
    const result: ResponseEnvelope | undefined = finished ? {
      ok: entry.exitCode === 0, exitCode: entry.exitCode ?? 1, cmd: entry.cmd, args: entry.args, cwd: entry.cwd,
      duration_ms: entry.finishedAt! - entry.startedAt,
      stdout: { raw: tail, parsed: null }, stderr: { raw: "", parsed: null }, diff: null,
      ...(entry.exitCode !== 0 && { failure: {
        kind: "exec" as const, reason: entry.state === "cancelled" ? "cancelled" : "non_zero_exit",
        message: `service ${entry.state === "cancelled" ? `stopped (${entry.readyReason})` : `exited with ${entry.exitCode ?? entry.signal}`}`,
      } }),
    } : undefined;
    return {
      task_id:      entry.id,
      state:        entry.state === "starting" || entry.state === "ready" ? "running" : entry.state,
      cmd:          entry.cmd,
      args:         entry.args,
      cwd:          entry.cwd,
      started_at:   new Date(entry.startedAt).toISOString(),
      elapsed_ms:   (entry.finishedAt ?? Date.now()) - entry.startedAt,
      stdout_bytes: 0,
      stderr_bytes: 0,
      service: {
        ready:        entry.state === "ready" || (entry.readyReason !== undefined && entry.state !== "starting" && !finished),
        ...(entry.readyReason && { ready_reason: entry.readyReason }),
        lease_until:  new Date(entry.leaseUntil).toISOString(),
        persist:      entry.persist,
        ...(entry.pgid !== undefined && { pid: entry.pgid }),
        output_tail:  tail,
      },
      ...(result && { result }),
    };
  }

  status(id: string): TaskLookup {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return { found: false, reason: "unknown_task", message: `service '${id}' is not known to this server` };
    return { found: true, task: this.syncSnapshot(entry) };
  }

  /**
   * 동기 상태 요약. 출력 끝의 마스킹은 비동기라서, 리댁션이 켜져 있으면 출력 끝을 비운다.
   * 출력 끝까지 보려면 wait(waitMs >= 0)를 쓴다. MCP task 도구는 항상 wait를 거친다.
   */
  private syncSnapshot(entry: ServiceEntry): TaskSnapshot {
    const raw = entry.patterns.length > 0 ? "" : entry.logFile ? readTail(entry.logFile, TAIL_BYTES) : entry.tail.slice(-TAIL_BYTES);
    return {
      task_id: entry.id, state: entry.state === "starting" || entry.state === "ready" ? "running" : entry.state,
      cmd: entry.cmd, args: entry.args, cwd: entry.cwd, started_at: new Date(entry.startedAt).toISOString(),
      elapsed_ms: (entry.finishedAt ?? Date.now()) - entry.startedAt, stdout_bytes: 0, stderr_bytes: 0,
      service: {
        ready: entry.state === "ready", ...(entry.readyReason && { ready_reason: entry.readyReason }),
        lease_until: new Date(entry.leaseUntil).toISOString(), persist: entry.persist,
        ...(entry.pgid !== undefined && { pid: entry.pgid }), output_tail: raw,
      },
    };
  }

  /** 서비스가 끝나거나 waitMs가 지날 때까지 기다린다 */
  async wait(id: string, waitMs: number): Promise<TaskLookup> {
    const entry = this.entries.get(id);
    if (!entry) return { found: false, reason: "unknown_task", message: `service '${id}' is not known to this server` };
    const limit = Math.min(Math.max(0, waitMs), MAX_READY_WAIT_MS);
    if (limit > 0 && entry.finishedAt === undefined) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, limit);
        function done(): void { clearTimeout(timer); entry!.waiters.delete(done); resolve(); }
        entry.waiters.add(done);
      });
    }
    return { found: true, task: await this.snapshot(entry) };
  }

  cancel(id: string): TaskLookup {
    const entry = this.entries.get(id);
    if (!entry) return { found: false, reason: "unknown_task", message: `service '${id}' is not known to this server` };
    this.stop(entry, "cancelled");
    return { found: true, task: this.syncSnapshot(entry) };
  }

  /** 서버가 끝날 때 부른다. persist 서비스는 감시 프로세스가 lease 끝에 정리한다. */
  stopAll(): void {
    for (const entry of this.entries.values()) if (!entry.persist) this.stop(entry, "server stopped");
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.finishedAt !== undefined && now - e.finishedAt > FINISHED_TTL_MS) this.entries.delete(id);
  }
}
