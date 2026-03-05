export interface CurlHeaders {
  status_code: number;
  status_text: string;
  headers:     Record<string, string>;
}

export function parseCurl(cmd: string, args: string[], raw: string): CurlHeaders | { raw: string } {
  if (!args.includes("-I") && !args.includes("--head")) {
    return { raw };
  }

  const lines      = raw.split("\n");
  const statusLine = lines[0]?.trim() ?? "";
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/);
  const headers: Record<string, string> = {};

  for (const line of lines.slice(1)) {
    const m = line.match(/^([^:]+):\s*(.+)/);
    if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
  }

  return {
    status_code: parseInt(statusMatch?.[1] ?? "0", 10),
    status_text: statusMatch?.[2] ?? "",
    headers,
  };
}
