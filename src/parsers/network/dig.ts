export interface DigRecord {
  name:  string;
  ttl:   number;
  class: string;
  type:  string;
  value: string;
}

export interface DigResult {
  query:         string;
  /** QUESTION 섹션이 없으면(+noquestion) 빈 문자열 */
  query_type:    string;
  answers:       DigRecord[];
  query_time_ms: number | null;
  server:        string | null;
}

/** 리소스 레코드 줄: 이름 TTL 클래스 타입 값 */
const RECORD = /^(\S+)\s+(\d+)\s+(IN|CH|HS)\s+(\S+)\s*(.*)$/;

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

export function parseDig(cmd: string, args: string[], raw: string): DigResult {
  const answers: DigRecord[] = [];
  let inAnswer      = false;
  let query         = "";
  let query_type    = "";
  let query_time_ms: number | null = null;
  let server:        string | null = null;

  /** +noall +answer는 섹션 머리말(주석)이 없고 레코드가 모두 답변이다. */
  const bare = args.includes("+noall");
  /** +multiline의 괄호로 이어지는 레코드 */
  let open: DigRecord | null = null;

  for (const line of raw.split("\n")) {
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
      if (m) { query = m[1]!.replace(/\.$/, ""); query_type = m[2]!; }
    }

    // ANSWER 파싱
    if ((inAnswer || bare) && !line.startsWith(";") && line.trim()) {
      const m = RECORD.exec(line.trim());
      if (m) {
        const record: DigRecord = {
          name:  m[1]!.replace(/\.$/, ""),
          ttl:   parseInt(m[2]!, 10),
          class: m[3]!,
          type:  m[4]!,
          value: stripComment(m[5]!).trim().replace(/\.$/, ""),
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
