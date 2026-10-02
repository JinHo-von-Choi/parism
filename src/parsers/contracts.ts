/**
 * 내장 파서 계약.
 * 출력 모양(머리 줄, noise, 행 배열과 필드)과 처리할 수 있는 입력 범위를 명령별로 선언한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import type { ParserContract } from "./registry.js";
import { supportsLs, supportsPs, supportsSs, supportsFree, supportsKubectl, supportsDocker, supportsHelm,
         supportsDig, supportsCurl, supportsWc, supportsId, supportsUname, supportsDf, supportsGit } from "./supports.js";

const LS_FIELDS      = ["permissions", "links", "owner", "group", "size_bytes", "modified_at", "name", "type", "target"] as const;
const PS_FIELDS      = ["user", "pid", "cpu", "mem", "vsz", "rss", "tty", "stat", "start", "time", "command"] as const;
const SS_FIELDS      = ["netid", "state", "recv_q", "send_q", "local_address", "local_port", "peer_address", "peer_port"] as const;
const LSOF_FIELDS    = ["command", "pid", "user", "fd", "type", "device", "name", "state"] as const;
const DOCKER_PS      = ["container_id", "image", "command", "created", "status", "ports", "names"] as const;
const SYSTEMCTL_ROWS = ["name", "load", "active", "sub", "description", "job", "failed"] as const;

/** 명령별 내장 계약. 계약이 없는 명령은 입력 범위 제한 없이 파서를 실행한다. */
export const BUILTIN_CONTRACTS: Readonly<Record<string, ParserContract>> = {
  ls:         { supports: supportsLs, noise: /^total \d+|^\S.*:$/, rowsKey: "entries", rowFields: LS_FIELDS },
  find:       { rowsKey: "paths" },
  du:         { rowsKey: "entries", rowFields: ["size", "path"] },
  df:         { supports: supportsDf, headerLines: 1, rowsKey: "filesystems",
                rowFields: ["filesystem", "blocks_1k", "used", "available", "use_percent", "mounted_on"] },
  ps:         { supports: supportsPs, headerLines: 1, rowsKey: "processes", rowFields: PS_FIELDS },
  curl:       { supports: supportsCurl },
  netstat:    { headerLines: 2, rowsKey: "connections", rowLine: /^(tcp|udp)[46]?\s/i,
                rowFields: ["proto", "local_address", "foreign_address", "state"] },
  lsof:       { headerLines: 1, rowsKey: "entries", rowFields: LSOF_FIELDS },
  ss:         { supports: supportsSs, headerLines: 1, rowsKey: "connections", rowFields: SS_FIELDS },
  dig:        { supports: supportsDig },
  grep:       { rowsKey: "matches", rowFields: ["file", "line", "text"] },
  wc:         { supports: supportsWc, rowsKey: "entries", rowFields: ["count", "file"] },
  which:      { rowsKey: "paths" },
  free:       { supports: supportsFree },
  uname:      { supports: supportsUname },
  id:         { supports: supportsId },
  systemctl:  { noise: /^\s*UNIT\s+LOAD\s|^Legend:|^\s*(LOAD|ACTIVE|SUB)\s+(=|->)|loaded units listed|^To show all/,
                rowsKey: "units", rowFields: SYSTEMCTL_ROWS },
  journalctl: { noise: /^-- No entries --$/, rowsKey: "entries", rowFields: ["timestamp", "hostname", "unit", "pid", "message"] },
  tasklist:   { headerLines: 2 },
  kubectl:    { supports: supportsKubectl, headerLines: 1 },
  docker:     { supports: supportsDocker, headerLines: 1, subcommands: {
                ps:    { rowsKey: "containers", rowFields: DOCKER_PS },
                stats: { rowsKey: "stats",
                         rowFields: ["container_id", "name", "cpu_perc", "mem_usage", "mem_limit", "mem_perc", "net_io", "block_io", "pids"] },
              } },
  helm:       { supports: supportsHelm, headerLines: 1 },
  apt:        { noise: /^(Listing|나열 중)/, rowsKey: "packages", rowLine: /^[^\s/]+\/\S*\s/,
                rowFields: ["name", "suite", "version", "arch", "status"] },
  npm:        { rowsKey: "dependencies", rowLine: /^[\s│├└|`+─┬-]*[├└`+][─-]/, rowFields: ["name", "version", "depth"] },
  git:        { supports: supportsGit,
                leadingFlags: { "--no-pager": "bool", "-C": "value", "-c": "value", "--git-dir": "value", "--work-tree": "value", "--namespace": "value" },
                subcommands: {
                  log:    { rowsKey: "commits", rowFields: ["hash", "message"] },
                  branch: { rowsKey: "branches", rowFields: ["current", "name", "hash", "upstream", "ahead", "behind", "message"] },
                  diff:   { rowsKey: "files", rowLine: /^diff --git /, rowFields: ["path", "hunks"] },
                } },
};
