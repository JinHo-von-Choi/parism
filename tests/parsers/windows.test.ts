import { describe, it, expect } from "vitest";
import { parseDir }        from "../../src/parsers/windows/dir.js";
import { parseTasklist }   from "../../src/parsers/windows/tasklist.js";
import { parseIpconfig }   from "../../src/parsers/windows/ipconfig.js";
import { parseSysteminfo } from "../../src/parsers/windows/systeminfo.js";

describe("parseDir()", () => {
  const raw = [
    " Volume in drive C has no label.",
    " Volume Serial Number is A1B2-C3D4",
    "",
    " Directory of C:\\Users\\jinho",
    "",
    "01/15/2026  10:30 AM    <DIR>          .",
    "01/15/2026  10:30 AM    <DIR>          ..",
    "01/15/2026  10:30 AM    <DIR>          Desktop",
    "01/15/2026  10:31 AM             1,234 readme.txt",
    "               1 File(s)          1,234 bytes",
    "               3 Dir(s)  50,000,000 bytes free",
  ].join("\r\n");

  it("디렉토리 항목을 파싱한다", () => {
    const result = parseDir("dir", [], raw);
    expect(result.directory).toBe("C:\\Users\\jinho");
    // . and .. excluded
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ name: "Desktop", type: "directory", size_bytes: null });
    expect(result.entries[1]).toMatchObject({ name: "readme.txt", type: "file", size_bytes: 1234 });
    expect(result.total_files).toBe(1);
    expect(result.total_dirs).toBe(3);
    expect(result.free_bytes).toBe(50000000);
  });

  it("/b 배어 모드를 파싱한다", () => {
    const bare = ["Desktop", "readme.txt", ""].join("\r\n");
    const result = parseDir("dir", ["/b"], bare);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].name).toBe("Desktop");
  });
});

describe("parseTasklist()", () => {
  const raw = [
    "Image Name                     PID Session Name        Session#    Mem Usage",
    "========================= ======== ================ =========== ============",
    "System Idle Process              0 Services                   0         24 K",
    "notepad.exe                   1234 Console                    1     10,240 K",
    "",
  ].join("\r\n");

  it("프로세스 목록을 파싱한다", () => {
    const result = parseTasklist("tasklist", [], raw);
    expect(result.processes).toHaveLength(2);
    expect(result.processes[0]).toMatchObject({
      name:           "System Idle Process",
      pid:            0,
      session_name:   "Services",
      session_number: 0,
      mem_usage_kb:   24,
    });
    expect(result.processes[1]).toMatchObject({
      name:         "notepad.exe",
      pid:          1234,
      mem_usage_kb: 10240,
    });
  });

  it("CSV 형식(/fo csv)을 파싱한다", () => {
    const csv = [
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"notepad.exe","1234","Console","1","10,240 K"',
    ].join("\r\n");
    const result = parseTasklist("tasklist", ["/fo", "csv"], csv);
    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe("notepad.exe");
    expect(result.processes[0].pid).toBe(1234);
    expect(result.processes[0].mem_usage_kb).toBe(10240);
  });
});

describe("parseIpconfig()", () => {
  const raw = [
    "Windows IP Configuration",
    "",
    "   Host Name . . . . . . . . . . . : DESKTOP-ABC",
    "   Primary Dns Suffix  . . . . . . : ",
    "",
    "Ethernet adapter Ethernet:",
    "",
    "   Connection-specific DNS Suffix  . : home.local",
    "   Description . . . . . . . . . . . : Intel Ethernet",
    "   Physical Address. . . . . . . . . : AA-BB-CC-DD-EE-FF",
    "   DHCP Enabled. . . . . . . . . . . : Yes",
    "   IPv4 Address. . . . . . . . . . . : 192.168.1.100(Preferred)",
    "   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
    "   Default Gateway . . . . . . . . . : 192.168.1.1",
    "   DNS Servers . . . . . . . . . . . : 8.8.8.8",
    "",
  ].join("\r\n");

  it("네트워크 어댑터를 파싱한다", () => {
    const result = parseIpconfig("ipconfig", [], raw);
    expect(result.hostname).toBe("DESKTOP-ABC");
    expect(result.adapters).toHaveLength(1);
    const adapter = result.adapters[0];
    expect(adapter.name).toBe("Ethernet");
    expect(adapter.ipv4).toBe("192.168.1.100");
    expect(adapter.subnet_mask).toBe("255.255.255.0");
    expect(adapter.gateway).toBe("192.168.1.1");
    expect(adapter.mac_address).toBe("AA-BB-CC-DD-EE-FF");
    expect(adapter.dhcp_enabled).toBe(true);
    expect(adapter.dns_servers).toContain("8.8.8.8");
  });
});

describe("parseSysteminfo()", () => {
  const raw = [
    "Host Name:                 DESKTOP-ABC",
    "OS Name:                   Microsoft Windows 11 Pro",
    "OS Version:                10.0.22621 N/A Build 22621",
    "System Type:               x64-based PC",
    "Total Physical Memory:     16,384 MB",
    "Available Physical Memory: 8,192 MB",
    "Domain:                    WORKGROUP",
    "Hotfix(s):                 3 Hotfix(s) Installed.",
    "                           [01]: KB5012345",
    "                           [02]: KB5067890",
    "                           [03]: KB5011111",
    "",
  ].join("\r\n");

  it("시스템 정보를 파싱한다", () => {
    const result = parseSysteminfo("systeminfo", [], raw);
    expect(result.hostname).toBe("DESKTOP-ABC");
    expect(result.os_name).toBe("Microsoft Windows 11 Pro");
    expect(result.system_type).toBe("x64-based PC");
    expect(result.total_memory_mb).toBe(16384);
    expect(result.available_memory_mb).toBe(8192);
    expect(result.domain).toBe("WORKGROUP");
    expect(result.hotfixes).toHaveLength(3);
    expect(result.hotfixes[0]).toBe("KB5012345");
  });
});
