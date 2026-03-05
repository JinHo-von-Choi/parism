export interface DigRecord {
  name:  string;
  ttl:   number;
  class: string;
  type:  string;
  value: string;
}

export interface DigResult {
  query:         string;
  query_type:    string;
  answers:       DigRecord[];
  query_time_ms: number | null;
  server:        string | null;
}

export function parseDig(cmd: string, args: string[], raw: string): DigResult {
  const answers: DigRecord[] = [];
  let inAnswer      = false;
  let query         = "";
  let query_type    = "A";
  let query_time_ms: number | null = null;
  let server:        string | null = null;

  for (const line of raw.split("\n")) {
    if (line.includes("QUESTION SECTION"))   { inAnswer = false; continue; }
    if (line.includes("ANSWER SECTION"))     { inAnswer = true;  continue; }
    if (line.includes("AUTHORITY SECTION") || line.includes("ADDITIONAL SECTION")) {
      inAnswer = false; continue;
    }

    // QUESTION 파싱
    if (line.startsWith(";") && !line.startsWith(";;")) {
      const m = line.match(/^;\s*(\S+)\s+IN\s+(\S+)/);
      if (m) { query = m[1].replace(/\.$/, ""); query_type = m[2]; }
    }

    // ANSWER 파싱
    if (inAnswer && !line.startsWith(";") && line.trim()) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5) {
        answers.push({
          name:  cols[0].replace(/\.$/, ""),
          ttl:   parseInt(cols[1], 10),
          class: cols[2],
          type:  cols[3],
          value: cols.slice(4).join(" ").replace(/\.$/, ""),
        });
      }
    }

    // 메타 정보
    const timeMatch   = line.match(/Query time:\s+(\d+)\s+msec/);
    const serverMatch = line.match(/SERVER:\s+(\S+)/);
    if (timeMatch)   query_time_ms = parseInt(timeMatch[1], 10);
    if (serverMatch) server = serverMatch[1];
  }

  return { query, query_type, answers, query_time_ms, server };
}
