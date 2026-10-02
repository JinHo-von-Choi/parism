export interface UnameResult {
  kernel_name:    string;
  hostname:       string;
  kernel_release: string;
  kernel_version: string;
  machine:        string;
  os:             string;
  raw:            string;
}

export function parseUname(cmd: string, args: string[], raw: string): UnameResult {
  const parts = raw.trim().split(/\s+/);

  if (args.includes("-a") || args.includes("--all")) {
    return parseUnameAll(parts, raw.trim());
  }

  return {
    kernel_name:    parts[0]  ?? "",
    hostname:       parts[1]  ?? "",
    kernel_release: parts[2]  ?? "",
    kernel_version: parts.slice(3, parts.length - 1).join(" "),
    machine:        parts[parts.length - 2] ?? "",
    os:             parts[parts.length - 1] ?? "",
    raw:            raw.trim(),
  };
}

/**
 * uname -a 출력을 앞의 세 값과 끝의 값부터 할당한다. kernel_version 은 공백을 포함하므로 나머지 전부다.
 * Linux 는 끝이 "machine [processor [platform]] os" 이고, 그 외 커널은 끝이 machine 이다.
 */
function parseUnameAll(parts: string[], raw: string): UnameResult {
  const tail = parts.slice(3);
  let os     = "";
  if (parts[0] === "Linux" && tail.length >= 2) os = tail.pop()!;

  const machine = tail.pop() ?? "";
  while (tail.length > 1 && tail[tail.length - 1] === machine) tail.pop();

  return {
    kernel_name:    parts[0] ?? "",
    hostname:       parts[1] ?? "",
    kernel_release: parts[2] ?? "",
    kernel_version: tail.join(" "),
    machine,
    os,
    raw,
  };
}
