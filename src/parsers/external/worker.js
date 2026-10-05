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
/** 계약 안의 정규식 자리를 나타내는 표식 키. 메인 스레드는 이 값을 RegExp 로 되살리지 않는다. */
const RE_MARKER      = "__parism_regex__";
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

/**
 * 팩의 출력이 stdio 프로토콜(stdout)과 섞이지 않도록 console과 process.stdout.write를 모두 stderr로 보낸다.
 * process.stderr.write는 그대로 둔다. 파일 기술자 1에 직접 쓰는 출력은 막지 못한다.
 */
process.stdout.write = process.stderr.write.bind(process.stderr);
globalThis.console   = new Console({ stdout: process.stderr, stderr: process.stderr });

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
 * 정규식은 {source, flags} 서술자로 바꾼다. 메인 스레드가 이 값으로 RegExp 를 만들어 실행하면
 * 워커의 시간·메모리 상한을 우회해 서버 스레드를 멈출 수 있으므로, 실행은 이 워커 안에서만 한다.
 * @param {unknown} value
 * @param {(string | number)[]} path
 * @returns {unknown}
 */
function describeValue(value, path) {
  if (typeof value === "function") return { [FN_MARKER]: path };
  if (value instanceof RegExp)   return { [RE_MARKER]: { source: value.source, flags: value.flags } };
  if (Array.isArray(value))        return value.map((item, i) => describeValue(item, [...path, i]));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(/** @type {object} */ (value)).map(([k, v]) => [k, describeValue(v, [...path, k])]));
  }
  return value;
}

/**
 * 서브커맨드 계약과 outputFlags 를 반영한 유효 계약을 고른다.
 * 정규식이 필요 없는 선언만 다루므로 메인 스레드의 resolveContract 와 같은 규칙을 그대로 쓴다.
 * @param {Record<string, any>} pack
 * @param {string[]} args
 * @returns {Record<string, any>}
 */
function effectiveContract(pack, args) {
  /** @type {Record<string, any>} */
  let contract = pack;
  if (pack.subcommands) {
    let i = 0;
    while (pack.leadingFlags && Object.hasOwn(pack.leadingFlags, args[i] ?? "")) {
      i += pack.leadingFlags[args[i]] === "value" ? 2 : 1;
    }
    const sub = args[i];
    const table = pack.subcommands;
    if (sub === undefined || !Object.hasOwn(table, sub)) {
      // 서브커맨드가 없거나 모르는 서브커맨드면 상위 계약을 그대로 쓴다(메인 스레드가 형식을 거부한다).
      return pack;
    }
    contract = { ...pack, ...table[sub] };
    if (pack.outputFlags) {
      let shaped = contract;
      for (const key of Object.keys(pack.outputFlags)) {
        if (args.includes(key) || args.includes(key.split("=")[0])) {
          shaped = { ...shaped, ...pack.outputFlags[key] };
        }
      }
      contract = shaped;
    }
  }
  return contract;
}

/**
 * 머리 줄과 noise 패턴을 제외한 비공백 줄. invariants.ts 의 dataLines 와 같은 규칙이다.
 * 정규식 필터만 워커 안에서 돌리므로 메인 스레드는 이 패턴을 실행하지 않는다.
 * @param {string} raw
 * @param {Record<string, any>} contract
 * @returns {string[]}
 */
function dataLines(raw, contract) {
  const records = raw.split(contract.nulRecords ? "\0" : /\r?\n/);
  if (contract.blankRecords && records[records.length - 1] === "") records.pop();
  const lines = (contract.blankRecords ? records : records.filter((l) => l.trim())).slice(contract.headerLines ?? 0);
  return contract.noise instanceof RegExp ? lines.filter((l) => !contract.noise.test(l)) : lines;
}

/**
 * 데이터 줄 수와 행 줄 수를 워커 안에서 계산한다. 출력이 JSON 배열 문서면 원소 수가 행 수다.
 * @param {string} raw
 * @param {Record<string, any>} contract
 * @returns {{ dataLines: number, rowLines: number }}
 */
function lineCounts(raw, contract) {
  const lines = dataLines(raw, contract);
  let rowLines = contract.rowLine instanceof RegExp ? lines.filter((l) => contract.rowLine.test(l)).length : lines.length;
  try {
    const json = JSON.parse(raw);
    if (Array.isArray(json)) rowLines = json.length;
  } catch {
    /** JSON 배열 문서가 아니면 줄 수를 쓴다. */
  }
  return { dataLines: lines.length, rowLines };
}

/**
 * 플래그 값이 계약의 acceptedValues 를 만족하는지 워커 안에서 판정한다.
 * 판정 결과만 불리언으로 돌려주므로 정규식은 메인 스레드에 전파되지 않는다.
 * @param {Record<string, any>} contract
 * @param {Record<string, string>} values
 * @returns {Record<string, boolean>}
 */
function valueVerdicts(contract, values) {
  /** @type {Record<string, boolean>} */
  const out = {};
  const table = contract.acceptedValues;
  if (!table) return out;
  for (const [name, value] of Object.entries(values)) {
    const pattern = table[name];
    if (pattern instanceof RegExp) out[name] = pattern.test(value);
  }
  return out;
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
 * @param {{ id: number; args: string[]; raw: string; ctx?: unknown; strict: boolean, flagValues?: Record<string, string> }} request
 */
function runParse(pack, request) {
  try {
    const parsed    = pack.parse(request.raw, request.args, request.ctx);
    const violation = request.strict && parsed != null ? schemaViolation(pack, parsed) : undefined;
    const contract  = effectiveContract(pack, request.args);
    const facts     = {
      ...lineCounts(request.raw, contract),
      values: valueVerdicts(contract, request.flagValues ?? {}),
    };
    return { id: request.id, ok: true, value: parsed, facts, ...(violation !== undefined && { schemaViolation: violation }) };
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
    if (request.op === "parse") return reply(runParse(pack, request));
    if (request.op === "values") {
      /** 계약 정규식은 이 워커 안에서만 실행한다. 판정 결과만 메인 스레드로 보낸다. */
      return reply({ id: request.id, ok: true, value: valueVerdicts(effectiveContract(pack, request.args), request.flagValues ?? {}) });
    }
    reply(runCall(pack, request));
  });
  reply({ id: 0, ok: true, value: { name: pack.name, contract } });
} catch (err) {
  reply({ id: 0, ok: false, error: errorOf(err) });
  port.close();
}
