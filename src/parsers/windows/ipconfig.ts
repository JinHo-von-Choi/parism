export interface IpconfigAdapter {
  name:          string;
  description:   string | null;
  ipv4:          string | null;
  ipv6:          string | null;
  subnet_mask:   string | null;
  gateway:       string | null;
  dns_servers:   string[];
  mac_address:   string | null;
  dhcp_enabled:  boolean | null;
  dhcp_server:   string | null;
  media_state:   string | null;
}

export interface IpconfigResult {
  hostname:      string | null;
  dns_suffix:    string | null;
  adapters:      IpconfigAdapter[];
}

/**
 * Parses Windows `ipconfig` (or `ipconfig /all`) command output.
 */
export function parseIpconfig(_cmd: string, _args: string[], raw: string): IpconfigResult {
  const lines      = raw.split(/\r?\n/);
  const adapters:  IpconfigAdapter[] = [];
  let   hostname:  string | null = null;
  let   dnsSuffix: string | null = null;
  let   current:   IpconfigAdapter | null = null;

  const val = (line: string) => line.split(":").slice(1).join(":").trim() || null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Top-level fields (before any adapter)
    if (!current) {
      const hostM = line.match(/Host Name[. ]+:\s*(.+)/i);
      if (hostM) { hostname = hostM[1].trim(); continue; }
      const dnsM = line.match(/(?:Primary )?DNS Suffix[. ]+:\s*(.*)/i);
      if (dnsM) { dnsSuffix = dnsM[1].trim() || null; continue; }
    }

    // Adapter header: "Ethernet adapter Local Area Connection:"
    //                 "Wireless LAN adapter Wi-Fi:"
    //                 "Tunnel adapter isatap:"
    if (/^(?:Ethernet adapter|Wireless LAN adapter|Tunnel adapter|PPP adapter)\s+(.+):$/i.test(trimmed)) {
      if (current) adapters.push(current);
      const nameM = trimmed.match(/^(?:Ethernet adapter|Wireless LAN adapter|Tunnel adapter|PPP adapter)\s+(.+):$/i);
      current = {
        name:         nameM ? nameM[1] : trimmed,
        description:  null,
        ipv4:         null,
        ipv6:         null,
        subnet_mask:  null,
        gateway:      null,
        dns_servers:  [],
        mac_address:  null,
        dhcp_enabled: null,
        dhcp_server:  null,
        media_state:  null,
      };
      continue;
    }

    if (!current) continue;

    if (/Description/.test(line))                    { current.description  = val(line); continue; }
    if (/Physical Address/.test(line))               { current.mac_address  = val(line); continue; }
    if (/DHCP Enabled/.test(line))                   { current.dhcp_enabled = val(line)?.toLowerCase() === "yes"; continue; }
    if (/DHCP Server/.test(line))                    { current.dhcp_server  = val(line); continue; }
    if (/Media State/.test(line))                    { current.media_state  = val(line); continue; }
    if (/IPv4 Address/.test(line))                   { current.ipv4         = val(line)?.replace(/\(Preferred\)/, "").trim() ?? null; continue; }
    if (/IPv6 Address/.test(line))                   { current.ipv6         = val(line)?.replace(/\(Preferred\)/, "").trim() ?? null; continue; }
    if (/Subnet Mask/.test(line))                    { current.subnet_mask  = val(line); continue; }
    if (/Default Gateway/.test(line))                { current.gateway      = val(line) || null; continue; }
    if (/DNS Servers/.test(line)) {
      const v = val(line);
      if (v) current.dns_servers.push(v);
      continue;
    }
    // Continuation DNS server (indented value on next line)
    if (/^\s{20,}[\d.:a-f]+$/i.test(line) && current.dns_servers.length > 0) {
      current.dns_servers.push(trimmed);
    }
  }

  if (current) adapters.push(current);

  return { hostname, dns_suffix: dnsSuffix, adapters };
}
