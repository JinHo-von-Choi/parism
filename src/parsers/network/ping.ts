export interface PingResult {
  target:              string;
  target_ip:           string;
  packets_transmitted: number;
  packets_received:    number;
  packet_loss_percent: number;
  rtt_min_ms:          number | null;
  rtt_avg_ms:          number | null;
  rtt_max_ms:          number | null;
}

export function parsePing(cmd: string, args: string[], raw: string): PingResult {
  const targetMatch = raw.match(/^PING\s+(\S+)\s+\(([^)]+)\)/m);
  const statsMatch  = raw.match(/(\d+) packets transmitted, (\d+) received, (\d+)% packet loss/);
  const rttMatch    = raw.match(/rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)/);

  return {
    target:              targetMatch?.[1] ?? "",
    target_ip:           targetMatch?.[2] ?? "",
    packets_transmitted: parseInt(statsMatch?.[1] ?? "0", 10),
    packets_received:    parseInt(statsMatch?.[2] ?? "0", 10),
    packet_loss_percent: parseInt(statsMatch?.[3] ?? "0", 10),
    rtt_min_ms:          rttMatch ? parseFloat(rttMatch[1]) : null,
    rtt_avg_ms:          rttMatch ? parseFloat(rttMatch[2]) : null,
    rtt_max_ms:          rttMatch ? parseFloat(rttMatch[3]) : null,
  };
}
