/**
 * 내장 파서별 supports() 규칙.
 * 각 파서가 실제로 처리하는 출력 형식을 args만으로 판정한다.
 *
 * @author 최진호
 * @date 2026-10-03
 */

/** "-la" 같은 단문자 옵션 묶음에서 문자 집합을 모은다. "--" 이후와 값 인자는 무시한다. */
function shortFlags(args: string[]): Set<string> {
  const flags = new Set<string>();
  for (const a of args) {
    if (a === "--") break;
    if (/^-[A-Za-z0-9]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
  }
  return flags;
}

/** 긴 옵션 존재 여부. "--name" 과 "--name=value" 모두 일치. */
function hasLong(args: string[], ...names: string[]): boolean {
  return args.some(a => names.some(n => a === n || a.startsWith(`${n}=`)));
}

/** 옵션 값 조회. "-o json", "-ojson", "--output json", "--output=json" 형태. */
function optionValue(args: string[], short: string, long: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === short || a === long) return args[i + 1] ?? "";
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (a.startsWith(short) && a.length > short.length && !a.startsWith("--")) return a.slice(short.length);
  }
  return null;
}

/** ls: 긴 형식(-l/-n/-g/-o)만 처리하며 사람이 읽는 크기(-h/--si)는 처리하지 않는다. */
export function supportsLs(args: string[]): boolean {
  const f    = shortFlags(args);
  const fmt  = args.find(a => a.startsWith("--format=")) ?? "";
  const long = ["l", "n", "g", "o"].some(c => f.has(c)) || /^--format=(long|verbose)$/.test(fmt);
  return long && !f.has("h") && !hasLong(args, "--human-readable", "--si");
}

/** ps: BSD 사용자 지향 형식(aux 등 u 포함 토큰)만 처리한다. */
export function supportsPs(args: string[]): boolean {
  const bsdU   = args.some(a => /^[A-Za-z]*u[A-Za-z]*$/.test(a));
  const custom = args.some(a => /^(-o|-O|o|O|--format|-F|-f|-l|-j)$/.test(a) || a.startsWith("--format="));
  return bsdU && !custom;
}

/** ss: Netid 열이 출력되는 경우(소켓 종류 필터가 정확히 1개가 아닐 때)만 처리한다. */
export function supportsSs(args: string[]): boolean {
  const f      = shortFlags(args);
  const kinds  = ["t", "u", "w", "x", "d", "S", "0", "M"].filter(c => f.has(c)).length
               + ["--tcp", "--udp", "--raw", "--unix", "--dccp", "--sctp", "--packet", "--mptcp"].filter(n => args.includes(n)).length;
  const custom = f.has("s") || f.has("A") || hasLong(args, "--summary", "--query");
  return kinds !== 1 && !custom;
}

/** free: 기본(KiB), -b/-k/-m/-g, -h 만 처리한다. 십진 단위와 wide 형식은 거부한다. */
export function supportsFree(args: string[]): boolean {
  const f = shortFlags(args);
  return !f.has("w") && !hasLong(args, "--kilo", "--mega", "--giga", "--tera", "--peta", "--si", "--wide");
}

/** kubectl get: 기본 표 형식(-o wide 포함), 단일 네임스페이스만 처리한다. */
export function supportsKubectl(args: string[]): boolean {
  const out = optionValue(args, "-o", "--output");
  const f   = shortFlags(args);
  return (out === null || out === "wide") && !f.has("A") && !f.has("w") && !hasLong(args, "--all-namespaces", "--watch", "--show-labels");
}

/** docker ps/stats: 기본 표 형식만 처리한다. */
export function supportsDocker(args: string[]): boolean {
  const f = shortFlags(args);
  return !f.has("q") && !f.has("s") && !hasLong(args, "--format", "--quiet", "--size");
}

/** helm list: 표 형식만 처리한다. */
export function supportsHelm(args: string[]): boolean {
  const out = optionValue(args, "-o", "--output");
  return (out === null || out === "table") && !shortFlags(args).has("q") && !hasLong(args, "--short");
}

/** dig: 기본 섹션 출력만 처리한다. */
export function supportsDig(args: string[]): boolean {
  return !args.some(a => /^\+(short|json|yaml|noall|nocmd|answer)$/.test(a));
}

/** curl: 헤더 전용 요청(-I/--head)만 처리한다. 그 외 본문은 native JSON 폴백에 맡긴다. */
export function supportsCurl(args: string[]): boolean {
  return shortFlags(args).has("I") || args.includes("--head");
}

/** wc: 단일 카운터 옵션만 처리한다. */
export function supportsWc(args: string[]): boolean {
  const f = shortFlags(args);
  return ["l", "w", "c", "m", "L"].filter(c => f.has(c)).length === 1;
}

/** id: 옵션 없는 전체 형식과 단일 값 형식(-u, -g, -G)만 처리한다. */
export function supportsId(args: string[]): boolean {
  return args.every(a => !a.startsWith("-") || a === "-u" || a === "-g" || a === "-G");
}

/** uname: -a 전체 형식만 처리한다. */
export function supportsUname(args: string[]): boolean {
  return shortFlags(args).has("a") || args.includes("--all");
}

/** df: 기본 6열 형식만 처리한다. */
export function supportsDf(args: string[]): boolean {
  const f = shortFlags(args);
  return !f.has("T") && !f.has("i") && !hasLong(args, "--print-type", "--inodes", "--output");
}

/** git: 서브커맨드별 처리 형식. */
export function supportsGit(args: string[]): boolean {
  const sub  = args[0];
  const rest = args.slice(1);
  const f    = shortFlags(rest);
  if (sub === "status") return !f.has("s") && !f.has("z") && !hasLong(rest, "--porcelain", "--short");
  if (sub === "log")    return (rest.includes("--oneline") || /^--(pretty|format)=oneline$/.test(rest.find(a => /^--(pretty|format)=/.test(a)) ?? "")) && !rest.includes("--graph");
  if (sub === "branch") return f.has("v") || rest.includes("--verbose");
  if (sub === "diff")   return !hasLong(rest, "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary", "--raw", "--no-prefix");
  return true;
}
