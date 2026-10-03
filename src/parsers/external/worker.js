// @ts-check
/**
 * 외부 ParserPack 워커.
 * 팩 모듈을 이 스레드에서 읽고, 메인 스레드가 보낸 요청(parse, 계약 함수 호출)을 처리한다.
 * 응답을 포트에 넣은 뒤 공유 신호를 REPLIED로 바꿔 Atomics.wait로 기다리는 메인 스레드를 깨운다.
 * 스레드가 끝날 때는 신호를 EXITED로 바꿔 메인 스레드가 시간 상한까지 기다리지 않게 한다.
 * 이 파일은 컴파일 없이 워커로 실행되므로 다른 소스 모듈을 가져오지 않는다. 신호 값과 표식 키는 host.ts와 같아야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import process          from "node:process";
import { Console }       from "node:console";
import { workerData }    from "node:worker_threads";
import { existsSync }    from "node:fs";
import { join }          from "node:path";
import { pathToFileURL } from "node:url";

/** 계약 안의 함수 자리를 나타내는 표식 키 */
const FN_MARKER      = "__parism_fn__";
const SIGNAL_REPLIED = 1;
const SIGNAL_EXITED  = 2;

/** ParserPack에서 계약 선언이 아닌 정의 필드 */
const DEFINITION_KEYS = new Set(["name", "parse", "schema", "fixtures", "meta"]);

/** @type {{ packDir: string; port: import("node:worker_threads").MessagePort; signal: SharedArrayBuffer }} */
const { packDir, port, signal } = workerData;
const state                     = new Int32Array(signal);

/** @param {number} value */
function wake(value) {
  Atomics.store(state, 0, value);
  Atomics.notify(state, 0);
}

process.on("exit", () => wake(SIGNAL_EXITED));

/** 팩의 console 출력이 stdio 프로토콜(stdout)과 섞이지 않도록 모두 stderr로 보낸다. */
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

/**
 * @param {unknown} err
 * @returns {{ name: string; message: string }}
 */
function errorOf(err) {
  return err instanceof Error ? { name: err.name, message: err.message } : { name: "Error", message: String(err) };
}

/**
 * 응답을 보내고 메인 스레드를 깨운다. 구조화 복제할 수 없는 값이면 그 사실을 오류로 보낸다.
 * @param {{ id: number } & Record<string, unknown>} message
 */
function reply(message) {
  try {
    port.postMessage(message);
  } catch (err) {
    port.postMessage({
      id:    message.id,
      ok:    false,
      error: { name: "Error", message: `Parser returned a value that cannot be passed between threads: ${errorOf(err).message}` },
    });
  }
  wake(SIGNAL_REPLIED);
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 계약 선언을 메인 스레드로 보낼 수 있는 값으로 바꾼다. 함수는 위치를 담은 표식으로 바꾼다.
 * @param {unknown} value
 * @param {(string | number)[]} path
 * @returns {unknown}
 */
function describeValue(value, path) {
  if (typeof value === "function") return { [FN_MARKER]: path };
  if (Array.isArray(value))        return value.map((item, i) => describeValue(item, [...path, i]));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(/** @type {object} */ (value)).map(([k, v]) => [k, describeValue(v, [...path, k])]));
  }
  return value;
}

/**
 * parser.js를 읽어 ParserPack 기본 내보내기를 돌려준다. 검사 규칙과 메시지는 cli/loader.ts와 같다.
 * @returns {Promise<Record<string, any>>}
 */
async function loadPack() {
  const parserPath = join(packDir, "parser.js");
  if (!existsSync(parserPath)) throw new Error(`parser.js not found in ${packDir}`);
  const mod  = await import(pathToFileURL(parserPath).href);
  const pack = mod.default;
  if (!pack || typeof pack.name !== "string" || typeof pack.parse !== "function") {
    throw new Error(`Invalid default export in ${parserPath} -- must be a ParserPack`);
  }
  return pack;
}

/**
 * 팩 스키마로 결과를 검사한다. 위반이면 메시지, 통과하거나 검사할 스키마가 없으면 undefined.
 * 메시지 형식은 registry.ts의 formatZodError와 같다.
 * @param {Record<string, any>} pack
 * @param {unknown} parsed
 * @returns {string | undefined}
 */
function schemaViolation(pack, parsed) {
  const schema = pack.schema;
  if (!schema || typeof schema.safeParse !== "function") return undefined;
  const result = schema.safeParse(parsed);
  if (result.success) return undefined;
  /** @type {{ path: (string | number)[]; message: string }[]} */
  const issues = result.error.issues;
  return issues.map(i => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");
}

/**
 * @param {Record<string, any>} pack
 * @param {{ id: number; args: string[]; raw: string; ctx?: unknown; strict: boolean }} request
 */
function runParse(pack, request) {
  try {
    const parsed    = pack.parse(request.raw, request.args, request.ctx);
    const violation = request.strict && parsed != null ? schemaViolation(pack, parsed) : undefined;
    return { id: request.id, ok: true, value: parsed, ...(violation !== undefined && { schemaViolation: violation }) };
  } catch (err) {
    return { id: request.id, ok: false, error: errorOf(err) };
  }
}

/**
 * 계약의 함수 선언을 위치로 찾아 호출한다.
 * @param {Record<string, any>} pack
 * @param {{ id: number; path: (string | number)[]; args: unknown[] }} request
 */
function runCall(pack, request) {
  try {
    /** @type {any} */
    let owner = pack;
    for (const key of request.path.slice(0, -1)) owner = owner[key];
    const fn = owner[request.path[request.path.length - 1]];
    if (typeof fn !== "function") throw new Error(`Contract entry ${request.path.join(".")} is not a function`);
    return { id: request.id, ok: true, value: fn.apply(owner, request.args) };
  } catch (err) {
    return { id: request.id, ok: false, error: errorOf(err) };
  }
}

try {
  const pack = await loadPack();
  /** @type {Record<string, unknown>} */
  const contract = {};
  for (const [key, value] of Object.entries(pack)) {
    if (!DEFINITION_KEYS.has(key)) contract[key] = describeValue(value, [key]);
  }
  port.on("message", (/** @type {any} */ request) => {
    reply(request.op === "parse" ? runParse(pack, request) : runCall(pack, request));
  });
  reply({ id: 0, ok: true, value: { name: pack.name, contract } });
} catch (err) {
  reply({ id: 0, ok: false, error: errorOf(err) });
  port.close();
}
