/**
 * Windows `systeminfo` 파서 시험. 실제 출력 형식(CRLF, 들여쓴 목록, 쉼표 있는 메모리 크기)을 쓴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { parseSysteminfo } from "../../src/parsers/windows/systeminfo.js";

const OUTPUT = [
  "",
  "Host Name:                 BUILD-01",
  "OS Name:                   Microsoft Windows 11 Pro",
  "OS Version:                10.0.22631 N/A Build 22631",
  "OS Manufacturer:           Microsoft Corporation",
  "OS Build Type:             Multiprocessor Free",
  "System Type:               x64-based PC",
  "Processor(s):              1 Processor(s) Installed.",
  "                           [01]: Intel64 Family 6 Model 154 Stepping 3 GenuineIntel ~2300 Mhz",
  "BIOS Version:              LENOVO N3HET82W (1.54 ), 2023-08-10",
  "Boot Device:               \\Device\\HarddiskVolume1",
  "System Locale:             ko;Korean",
  "Time Zone:                 (UTC+09:00) Seoul",
  "Total Physical Memory:     32,476 MB",
  "Available Physical Memory: 17,203 MB",
  "Domain:                    WORKGROUP",
  "Logon Server:              \\\\BUILD-01",
  "Hotfix(s):                 3 Hotfix(s) Installed.",
  "                           [01]: KB5034467",
  "                           [02]: KB5027397",
  "                           [03]: KB5034765",
  "Network Card(s):           2 NIC(s) Installed.",
  "                           [01]: Intel(R) Wi-Fi 6E AX211 160MHz",
  "                           [02]: Bluetooth Device (Personal Area Network)",
  "Hyper-V Requirements:      A hypervisor has been detected.",
  "",
].join("\r\n");

describe("parseSysteminfo", () => {
  it("키 값과 목록을 읽는다", () => {
    const r = parseSysteminfo("systeminfo", [], OUTPUT);
    expect(r).toMatchObject({
      hostname: "BUILD-01", os_name: "Microsoft Windows 11 Pro", os_build: "22631",
      os_version: "10.0.22631 N/A Build 22631", system_type: "x64-based PC",
      processor: "1 Processor(s) Installed.", total_memory_mb: 32476, available_memory_mb: 17203,
      domain: "WORKGROUP", logon_server: "\\\\BUILD-01", system_locale: "ko;Korean", time_zone: "(UTC+09:00) Seoul",
      bios_version: "LENOVO N3HET82W (1.54 ), 2023-08-10", boot_device: "\\Device\\HarddiskVolume1",
    });
    expect(r.hotfixes).toEqual(["KB5034467", "KB5027397", "KB5034765"]);
    expect(r.network_cards).toEqual(["Intel(R) Wi-Fi 6E AX211 160MHz", "Bluetooth Device (Personal Area Network)"]);
  });

  it("값이 없거나 수가 아닌 메모리는 null이고, 목록 밖의 들여쓴 줄은 목록에 넣지 않는다", () => {
    const r = parseSysteminfo("systeminfo", [], [
      "Host Name:", "Total Physical Memory:     N/A", "Processor(s):              1 Processor(s) Installed.",
      "                           [01]: CPU line belongs to no list",
    ].join("\n"));
    expect(r.hostname).toBeNull();
    expect(r.total_memory_mb).toBeNull();
    expect(r.hotfixes).toEqual([]);
    expect(r.network_cards).toEqual([]);
  });
});
