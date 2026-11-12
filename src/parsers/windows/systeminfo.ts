export interface SysteminfoResult {
  hostname:        string | null;
  os_name:         string | null;
  os_version:      string | null;
  os_build:        string | null;
  os_manufacturer: string | null;
  system_type:     string | null;
  processor:       string | null;
  total_memory_mb: number | null;
  available_memory_mb: number | null;
  domain:          string | null;
  logon_server:    string | null;
  hotfixes:        string[];
  network_cards:   string[];
  boot_device:     string | null;
  system_locale:   string | null;
  time_zone:       string | null;
  bios_version:    string | null;
}

/**
 * Parses Windows `systeminfo` command output.
 */
/** "16,384 MB"에서 수를 읽는다. 숫자가 없으면 null이다. */
function megabytes(value: string | null): number | null {
  const digits = (value ?? "").replace(/[^0-9]/g, "");
  return digits === "" ? null : parseInt(digits, 10);
}

type TextField = "hostname" | "os_name" | "os_version" | "os_build" | "os_manufacturer" | "system_type" | "processor"
  | "bios_version" | "boot_device" | "system_locale" | "time_zone" | "domain" | "logon_server";

/** 글자 그대로 담는 키 → 필드 */
const TEXT_FIELDS: Record<string, TextField> = {
  "Host Name": "hostname", "OS Name": "os_name", "OS Version": "os_version", "OS Build": "os_build",
  "OS Manufacturer": "os_manufacturer", "System Type": "system_type", "Processor(s)": "processor",
  "BIOS Version": "bios_version", "Boot Device": "boot_device", "System Locale": "system_locale",
  "Time Zone": "time_zone", "Domain": "domain", "Logon Server": "logon_server",
};

export function parseSysteminfo(_cmd: string, _args: string[], raw: string): SysteminfoResult {
  const lines = raw.split(/\r?\n/);

  const result: SysteminfoResult = {
    hostname:            null,
    os_name:             null,
    os_version:          null,
    os_build:            null,
    os_manufacturer:     null,
    system_type:         null,
    processor:           null,
    total_memory_mb:     null,
    available_memory_mb: null,
    domain:              null,
    logon_server:        null,
    hotfixes:            [],
    network_cards:       [],
    boot_device:         null,
    system_locale:       null,
    time_zone:           null,
    bios_version:        null,
  };

  let mode: "hotfix" | "nic" | null = null;

  for (const line of lines) {
    // Multi-line list items (indented with [N])
    const listItemM = line.match(/^\s+\[(\d+)\][:\s]+(.+)/);
    if (listItemM) {
      if (mode === "hotfix")  { result.hotfixes.push(listItemM[2].trim());      continue; }
      if (mode === "nic")     { result.network_cards.push(listItemM[2].trim()); continue; }
    }

    // Key: Value lines
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim() || null;

    mode = null; // reset list mode on new key

    /**
     * 키는 정확히 같은 이름으로 고른다. 부분 일치로 고르면 "BIOS Version"이 "OS Version"에,
     * "OS Build Type"이 "OS Build"에 맞아 값이 엉뚱한 필드에 들어간다.
     */
    const field = Object.hasOwn(TEXT_FIELDS, key) ? TEXT_FIELDS[key] : undefined;
    if (field) { result[field] = val; continue; }
    if (key === "Total Physical Memory")     { result.total_memory_mb     = megabytes(val); continue; }
    if (key === "Available Physical Memory") { result.available_memory_mb = megabytes(val); continue; }
    if (key === "Hotfix(s)")                 { mode = "hotfix"; continue; }
    if (key === "Network Card(s)")           { mode = "nic"; continue; }
  }

  /** 빌드 번호는 "OS Version: 10.0.22631 N/A Build 22631"의 끝에 있다. 따로 된 키가 없으면 거기서 읽는다. */
  if (result.os_build === null && result.os_version !== null) {
    const m = /Build ([0-9]+)/.exec(result.os_version);
    if (m) result.os_build = m[1]!;
  }

  return result;
}
