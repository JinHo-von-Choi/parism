import { UnrecognizedOutputError } from "../registry.js";

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

/**
 * 통계 줄: "3 packets transmitted, 2 received, +1 errors, 33% packet loss" 또는 macOS의 "3 packets received, 33.3% packet loss".
 * 오류나 중복 개수 구획(+N errors, +N duplicates)은 건너뛴다.
 */
const STATS_LINE = /(\d+) packets transmitted, (\d+) (?:packets )?received,(?: \+\d+ (?:errors|duplicates),)* ([\d.]+)% packet loss/;
const RTT_LINE   = /(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)/;

/** 통계 줄이 없으면(이름을 풀지 못했거나 중간에 끊김) 결과를 만들지 않는다. */
export function parsePing(cmd: string, args: string[], raw: string): PingResult {
  const targetMatch = raw.match(/^PING\s+(\S+)\s+\(([^)]+)\)/m);
  const statsMatch  = raw.match(STATS_LINE);
  const rttMatch    = raw.match(RTT_LINE);
  if (!statsMatch) throw new UnrecognizedOutputError("ping output has no statistics line");

  return {
    target:              targetMatch?.[1] ?? "",
    target_ip:           targetMatch?.[2] ?? "",
    packets_transmitted: parseInt(statsMatch[1]!, 10),
    packets_received:    parseInt(statsMatch[2]!, 10),
    packet_loss_percent: parseFloat(statsMatch[3]!),
    rtt_min_ms:          rttMatch ? parseFloat(rttMatch[1]) : null,
    rtt_avg_ms:          rttMatch ? parseFloat(rttMatch[2]) : null,
    rtt_max_ms:          rttMatch ? parseFloat(rttMatch[3]) : null,
  };
}
