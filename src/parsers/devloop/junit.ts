/**
 * JUnit XML 보고서 파서. pytest의 `--junitxml` 출력을 읽는다.
 *
 * testsuite 요소의 failures, errors 속성 합계와 failure, error 자식을 가진 testcase 수가 다르면
 * 결과를 만들지 않는다. XML 전체를 다루는 파서가 아니라 JUnit 보고서에 나오는 요소만 읽는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { UnrecognizedOutputError } from "../registry.js";
import { clipMessage, type TestFailure, type TestReport } from "./types.js";

/** 여는 태그, 닫는 태그, 스스로 닫는 태그, CDATA 구간 */
const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** XML 문자 참조와 기본 엔티티를 푼다. 모르는 엔티티는 그대로 둔다. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#"))  return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
  });
}

function attributesOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTRIBUTE)) out[m[1]!] = decodeXml(m[2] ?? m[3] ?? "");
  return out;
}

interface Outcome {
  kind:    "failure" | "error" | "skipped";
  message: string;
  text:    string;
}

interface TestCase {
  classname: string;
  name:      string;
  outcomes:  Outcome[];
}

function countOf(attrs: Record<string, string>, name: string): number {
  const value = Number(attrs[name] ?? "0");
  if (!Number.isInteger(value) || value < 0) throw new UnrecognizedOutputError(`testsuite attribute '${name}' is not a count`);
  return value;
}

/** 실패 본문에서 마지막 "파일:줄:" 위치를 찾는다. pytest는 실패한 줄을 본문 끝에 적는다. */
function locationIn(text: string): { file: string; line: number } | undefined {
  const all = [...text.matchAll(/^([^\s:][^:\n]*\.py):(\d+): /gm)];
  const last = all.at(-1);
  return last ? { file: last[1]!, line: Number(last[2]) } : undefined;
}

/** JUnit XML을 TestReport로 바꾼다. testsuite 요소가 없으면 null이다. */
export function parseJunitXml(tool: string, raw: string): TestReport | null {
  if (!/<testsuite[\s>]/.test(raw)) return null;

  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const cases: TestCase[] = [];
  let   current: TestCase | undefined;
  let   open:    Outcome | undefined;
  let   textFrom = 0;

  for (const m of raw.matchAll(TOKEN)) {
    const [whole, cdata, closing, tag, attrSource, selfClosing] = m;
    const at = m.index;
    if (cdata !== undefined) continue;

    if (tag === "testsuite" && closing === "") {
      const attrs = attributesOf(attrSource ?? "");
      totals.tests    += countOf(attrs, "tests");
      totals.failures += countOf(attrs, "failures");
      totals.errors   += countOf(attrs, "errors");
      totals.skipped  += countOf(attrs, "skipped");
    } else if (tag === "testcase") {
      if (closing === "/") { current = undefined; continue; }
      const attrs = attributesOf(attrSource ?? "");
      const entry: TestCase = { classname: attrs.classname ?? "", name: attrs.name ?? "", outcomes: [] };
      cases.push(entry);
      current = selfClosing === "/" ? undefined : entry;
    } else if ((tag === "failure" || tag === "error" || tag === "skipped") && current) {
      if (closing === "/") {
        if (open) {
          /** CDATA 구간은 표식을 벗기고 그대로 쓰고, 나머지 본문은 엔티티를 푼다. */
          open.text = raw.slice(textFrom, at)
            .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
            .map(part => part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeXml(part))
            .join("");
          open = undefined;
        }
        continue;
      }
      const outcome: Outcome = { kind: tag, message: attributesOf(attrSource ?? "").message ?? "", text: "" };
      current.outcomes.push(outcome);
      if (selfClosing !== "/") {
        open     = outcome;
        textFrom = at + whole.length;
      }
    }
  }

  const failedCases = cases.filter(c => c.outcomes.some(o => o.kind === "failure"));
  const errorCases  = cases.filter(c => c.outcomes.some(o => o.kind === "error"));
  if (failedCases.length !== totals.failures || errorCases.length !== totals.errors) {
    throw new UnrecognizedOutputError(
      `the report counts ${totals.failures} failure(s) and ${totals.errors} error(s) but ${failedCases.length} and ${errorCases.length} test case(s) carry them`,
    );
  }

  const used = new Map<string, number>();
  const failures: TestFailure[] = [];
  let   filesFailed = 0;
  for (const c of cases) {
    const outcome = c.outcomes.find(o => o.kind === "failure") ?? c.outcomes.find(o => o.kind === "error");
    if (!outcome) continue;
    /** 시험 모듈을 가져오지 못한 오류. 시험이 하나도 실행되지 않았으므로 시험 실패와 따로 센다. */
    const collection = outcome.kind === "error" && c.classname === "";
    if (collection) filesFailed++;
    const name     = collection ? "(file)" : c.name;
    const base     = c.classname === "" ? c.name : `${c.classname}::${c.name}`;
    const seen     = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    const location = locationIn(outcome.text);
    failures.push({
      id:   seen === 1 ? base : `${base} #${seen}`,
      file: location?.file ?? "",
      name,
      ...(location && { line: location.line }),
      ...clipMessage([outcome.message, outcome.text].filter(Boolean).join("\n")),
    });
  }

  const failed = totals.failures + totals.errors - filesFailed;
  return {
    kind:         "test",
    tool,
    passed:       totals.tests - totals.failures - totals.errors - totals.skipped,
    failed,
    skipped:      totals.skipped,
    todo:         0,
    total:        totals.tests - filesFailed,
    files_failed: filesFailed,
    success:      failed === 0 && filesFailed === 0,
    failures,
  };
}
