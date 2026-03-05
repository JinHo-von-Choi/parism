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
  return {
    kernel_name:    parts[0]  ?? "",
    hostname:       parts[1]  ?? "",
    kernel_release: parts[2]  ?? "",
    kernel_version: parts.slice(3, parts.lastIndexOf("x86_64") >= 0 ? parts.lastIndexOf("x86_64") : parts.length - 1).join(" "),
    machine:        parts[parts.length - 2] ?? "",
    os:             parts[parts.length - 1] ?? "",
    raw:            raw.trim(),
  };
}
