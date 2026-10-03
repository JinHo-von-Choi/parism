export interface DigRecord {
  name:  string;
  ttl:   number;
  class: string;
  type:  string;
  value: string;
}

/** 응답 하나(질문 하나)의 결과 */
export interface DigQuery {
  query:         string;
  /** QUESTION 섹션이 없으면(+noquestion) 빈 문자열 */
  query_type:    string;
  answers:       DigRecord[];
  query_time_ms: number | null;
  server:        string | null;
}

/** 맨 위 필드는 첫 응답이다. 쿼리가 여럿이면(dig a.com b.org) queries에 응답마다의 결과가 있다. */
export interface DigResult extends DigQuery {
  queries?: DigQuery[];
}

/** 리소스 레코드 줄: 이름 TTL 클래스 타입 값 */
const RECORD = /^(\S+)\s+(\d+)\s+(IN|CH|HS)\s+(\S+)\s*(.*)$/;

/** 응답 하나의 시작 줄 */
const ANSWER_START = ";; Got answer:";

/** 값 안의 `;` 주석(+multiline의 "; serial")을 뗀다. 따옴표 안의 `;`은 건드리지 않는다. */
function stripComment(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\"" && text[i - 1] !== "\\") quoted = !quoted;
    else if (c === ";" && !quoted) return text.slice(0, i);
  }
  return text;
}

/** 이름 끝의 점(절대 이름 표시)을 뗀다. 루트 이름(.)과 "0 ."처럼 루트를 가리키는 값의 점은 남긴다. */
function stripTrailingDot(text: string): string {
  return /[^\s.]\.$/.test(text) ? text.slice(0, -1) : text;
}

/** 응답 하나의 줄을 읽는다. bare(+noall +answer)면 섹션 머리말이 없고 레코드가 모두 답변이다. */
function parseResponse(lines: readonly string[], bare: boolean): DigQuery {
  const answers: DigRecord[] = [];
  let inAnswer      = false;
  let query         = "";
  let query_type    = "";
  let query_time_ms: number | null = null;
  let server:        string | null = null;

  /** +multiline의 괄호로 이어지는 레코드 */
  let open: DigRecord | null = null;

  for (const line of lines) {
    if (open) {
      const body = stripComment(line).trim();
      open.value = `${open.value} ${body.replace(/\)\s*$/, "").trim()}`.trim();
      if (/\)\s*$/.test(body)) {
        open.value = `${open.value} )`;
        open = null;
      }
      continue;
    }
    if (line.includes("QUESTION SECTION"))   { inAnswer = false; continue; }
    if (line.includes("ANSWER SECTION"))     { inAnswer = true;  continue; }
    if (line.includes("AUTHORITY SECTION") || line.includes("ADDITIONAL SECTION")) {
      inAnswer = false; continue;
    }

    // QUESTION 파싱
    if (line.startsWith(";") && !line.startsWith(";;")) {
      const m = line.match(/^;\s*(\S+)\s+(?:IN|CH|HS)\s+(\S+)/);
      if (m) { query = stripTrailingDot(m[1]!); query_type = m[2]!; }
    }

    // ANSWER 파싱
    if ((inAnswer || bare) && !line.startsWith(";") && line.trim()) {
      const m = RECORD.exec(line.trim());
      if (m) {
        const record: DigRecord = {
          name:  stripTrailingDot(m[1]!),
          ttl:   parseInt(m[2]!, 10),
          class: m[3]!,
          type:  m[4]!,
          value: stripTrailingDot(stripComment(m[5]!).trim()),
        };
        answers.push(record);
        if (/\(\s*$/.test(record.value)) {
          record.value = record.value.replace(/\s*\(\s*$/, " (");
          open = record;
        }
      }
    }

    // 메타 정보
    const timeMatch   = line.match(/Query time:\s+(\d+)\s+msec/);
    const serverMatch = line.match(/SERVER:\s+(\S+)/);
    if (timeMatch)   query_time_ms = parseInt(timeMatch[1]!, 10);
    if (serverMatch) server = serverMatch[1]!;
  }

  return { query, query_type, answers, query_time_ms, server };
}

/**
 * dig 출력 파싱. 응답은 ";; Got answer:" 줄로 나뉘며, 쿼리가 여럿이면 응답마다 따로 읽어 queries에 담는다.
 */
export function parseDig(cmd: string, args: string[], raw: string): DigResult {
  const bare   = args.includes("+noall");
  const blocks: string[][] = [[]];
  for (const line of raw.split("\n")) {
    const current = blocks[blocks.length - 1]!;
    if (line.startsWith(ANSWER_START) && current.some(l => l.startsWith(ANSWER_START))) blocks.push([line]);
    else current.push(line);
  }
  const responses = blocks.map(b => parseResponse(b, bare));
  return responses.length > 1 ? { ...responses[0]!, queries: responses } : responses[0]!;
}
