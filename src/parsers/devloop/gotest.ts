/**
 * `go test -json` 출력 파서(test2json의 줄 단위 JSON 이벤트).
 *
 * 시험마다 pass, fail, skip 이벤트를 세고, 실패한 시험의 output 이벤트를 메시지로 모은다.
 * JSON이 아닌 줄이 섞였거나 시작한 패키지 가운데 끝난 이벤트가 없는 것이 있으면 결과를 만들지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError } from "../registry.js";
import { clipMessage, type TestFailure, type TestReport } from "./types.js";

interface GoEvent {
  Action?:  string;
  Package?: string;
  Test?:    string;
  Output?:  string;
}

const TERMINAL = new Set(["pass", "fail", "skip"]);
/** 러너가 덧붙이는 진행 표시 줄. 실패 메시지에는 싣지 않는다. */
const FRAMING  = /^(?:=== (?:RUN|PAUSE|CONT|NAME)\s|--- (?:PASS|FAIL|SKIP): )/;
const LOCATION = /^\s*([^\s:][^:\n]*\.go):(\d+): /m;

function readEvent(line: string): GoEvent | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" && typeof (value as GoEvent).Action === "string" ? value as GoEvent : null;
  } catch {
    return null;
  }
}

/** go test -json 출력을 TestReport로 바꾼다. 이벤트 줄이 하나도 없으면 null이다. */
export function parseGoTest(raw: string): TestReport | null {
  const counts   = { pass: 0, fail: 0, skip: 0 };
  const outputs  = new Map<string, string[]>();
  const failed:  { pkg: string; test: string }[] = [];
  const started  = new Set<string>();
  const finished = new Map<string, string>();
  const packagesWithFailedTests = new Set<string>();
  let   seen = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const event = readEvent(line);
    if (!event) {
      if (seen === 0) return null;
      throw new UnrecognizedOutputError(`a go test output line is not a JSON event: ${line.slice(0, 120)}`);
    }
    seen++;
    const pkg = event.Package ?? "";
    if (event.Action === "start") { started.add(pkg); continue; }

    if (event.Test === undefined) {
      if (event.Action === "output") outputs.set(pkg, [...(outputs.get(pkg) ?? []), event.Output ?? ""]);
      else if (TERMINAL.has(event.Action!)) finished.set(pkg, event.Action!);
      continue;
    }
    const key = `${pkg}\u0000${event.Test}`;
    if (event.Action === "output") {
      outputs.set(key, [...(outputs.get(key) ?? []), event.Output ?? ""]);
    } else if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") {
      counts[event.Action]++;
      if (event.Action === "fail") {
        failed.push({ pkg, test: event.Test });
        packagesWithFailedTests.add(pkg);
      }
    }
  }
  if (seen === 0) return null;
  const unfinished = [...started].filter(pkg => !finished.has(pkg));
  if (unfinished.length > 0) {
    throw new UnrecognizedOutputError(`go test output ended before package ${unfinished[0]} finished`);
  }

  const failures: TestFailure[] = failed.map(({ pkg, test }) => {
    const message  = (outputs.get(`${pkg}\u0000${test}`) ?? []).filter(l => !FRAMING.test(l)).join("").trimEnd();
    const location = LOCATION.exec(message);
    return {
      id:   `${pkg} > ${test}`,
      file: location ? location[1]! : "",
      name: test,
      ...(location && { line: Number(location[2]) }),
      ...clipMessage(message),
    };
  });

  /** 시험이 하나도 실패하지 않았는데 실패로 끝난 패키지(빌드 실패, TestMain 실패). 패키지 출력을 메시지로 싣는다. */
  let packagesFailed = 0;
  for (const [pkg, action] of finished) {
    if (action !== "fail" || packagesWithFailedTests.has(pkg)) continue;
    packagesFailed++;
    failures.push({
      id: `${pkg} > (package)`, file: "", name: "(package)",
      ...clipMessage((outputs.get(pkg) ?? []).join("").trimEnd()),
    });
  }

  return {
    kind:         "test",
    tool:         "go",
    passed:       counts.pass,
    failed:       counts.fail,
    skipped:      counts.skip,
    todo:         0,
    total:        counts.pass + counts.fail + counts.skip,
    files_failed: packagesFailed,
    success:      counts.fail === 0 && packagesFailed === 0,
    failures,
  };
}

/** 실행 중인 go test의 진행 상태 */
export interface GoTestProgressSnapshot {
  passed:       number;
  failed:       number;
  skipped:      number;
  failed_names: string[];
}

/** go test -json 출력을 조각 단위로 받아 지금까지 끝난 시험을 센다. */
export class GoTestProgress {
  private rest = "";
  private readonly state: GoTestProgressSnapshot = { passed: 0, failed: 0, skipped: 0, failed_names: [] };

  push(text: string): void {
    const lines = (this.rest + text).split(/\r?\n/);
    this.rest   = lines.pop() ?? "";
    for (const line of lines) {
      const event = readEvent(line);
      if (!event || event.Test === undefined) continue;
      if (event.Action === "pass")      this.state.passed++;
      else if (event.Action === "skip") this.state.skipped++;
      else if (event.Action === "fail") {
        this.state.failed++;
        this.state.failed_names.push(event.Test);
      }
    }
  }

  snapshot(): GoTestProgressSnapshot {
    return { ...this.state, failed_names: [...this.state.failed_names] };
  }
}
