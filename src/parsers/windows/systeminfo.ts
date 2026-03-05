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

    switch (true) {
      case /Host Name/i.test(key):              result.hostname            = val; break;
      case /OS Name/i.test(key):                result.os_name             = val; break;
      case /OS Version/i.test(key):             result.os_version          = val; break;
      case /OS Build/i.test(key):               result.os_build            = val; break;
      case /OS Manufacturer/i.test(key):        result.os_manufacturer     = val; break;
      case /System Type/i.test(key):            result.system_type         = val; break;
      case /Processor\(s\)/i.test(key):         result.processor           = val; break;
      case /BIOS Version/i.test(key):           result.bios_version        = val; break;
      case /Boot Device/i.test(key):            result.boot_device         = val; break;
      case /System Locale/i.test(key):          result.system_locale       = val; break;
      case /Time Zone/i.test(key):              result.time_zone           = val; break;
      case /Domain/i.test(key):                 result.domain              = val; break;
      case /Logon Server/i.test(key):           result.logon_server        = val; break;
      case /Total Physical Memory/i.test(key):
        result.total_memory_mb = val ? parseInt(val.replace(/[^0-9]/g, ""), 10) : null;
        break;
      case /Available Physical Memory/i.test(key):
        result.available_memory_mb = val ? parseInt(val.replace(/[^0-9]/g, ""), 10) : null;
        break;
      case /Hotfix\(s\)/i.test(key):
        mode = "hotfix";
        break;
      case /Network Card\(s\)/i.test(key):
        mode = "nic";
        break;
    }
  }

  return result;
}
