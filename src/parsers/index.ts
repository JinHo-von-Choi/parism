import { ParserRegistry }                                              from "./registry.js";
import { parseLs, parseFind, parseStat, parseDu, parseDf, parseTree } from "./fs/index.js";
import { parsePs, parseKill }                                          from "./process/index.js";
import { parsePing, parseCurl, parseNetstat, parseLsof, parseSs,
         parseDig }                                                    from "./network/index.js";
import { parseGrep, parseWc, parseHead, parseTail, parseCat }         from "./text/index.js";
import { parseGitStatus, parseGitLog, parseGitDiff, parseGitBranch }  from "./git/index.js";
import { parseEnv, parsePwd, parseWhich }                             from "./env/index.js";
import { parseFree, parseUname, parseId }                             from "./system/index.js";
import { parseDir, parseTasklist, parseIpconfig, parseSysteminfo }    from "./windows/index.js";
import { parseKubectl, parseDocker, parseGh }                         from "./devops/index.js";

/**
 * 전역 싱글턴 Parser Registry. 서버 시작 시 한 번 초기화된다.
 */
export const defaultRegistry = new ParserRegistry();

defaultRegistry.register("ls",      parseLs);
defaultRegistry.register("find",    parseFind);
defaultRegistry.register("stat",    parseStat);
defaultRegistry.register("du",      parseDu);
defaultRegistry.register("df",      parseDf);
defaultRegistry.register("tree",    parseTree);
defaultRegistry.register("ps",      parsePs);
defaultRegistry.register("kill",    parseKill);
defaultRegistry.register("ping",    parsePing);
defaultRegistry.register("curl",    parseCurl);
defaultRegistry.register("netstat", parseNetstat);
defaultRegistry.register("lsof",    parseLsof);
defaultRegistry.register("ss",      parseSs);
defaultRegistry.register("dig",     parseDig);
defaultRegistry.register("grep",    parseGrep);
defaultRegistry.register("wc",      parseWc);
defaultRegistry.register("head",    parseHead);
defaultRegistry.register("tail",    parseTail);
defaultRegistry.register("cat",     parseCat);
defaultRegistry.register("env",     parseEnv);
defaultRegistry.register("pwd",     parsePwd);
defaultRegistry.register("which",   parseWhich);
defaultRegistry.register("free",       parseFree);
defaultRegistry.register("uname",      parseUname);
defaultRegistry.register("id",         parseId);
defaultRegistry.register("dir",        parseDir);
defaultRegistry.register("tasklist",   parseTasklist);
defaultRegistry.register("ipconfig",   parseIpconfig);
defaultRegistry.register("systeminfo", parseSysteminfo);
defaultRegistry.register("kubectl",    parseKubectl);
defaultRegistry.register("docker",     parseDocker);
defaultRegistry.register("gh",         parseGh);

// git은 서브커맨드 기반 — args[0]으로 파서를 선택
defaultRegistry.register("git", (cmd, args, raw) => {
  const sub = args[0];
  if (sub === "status") return parseGitStatus(cmd, args, raw);
  if (sub === "log")    return parseGitLog(cmd, args, raw);
  if (sub === "diff")   return parseGitDiff(cmd, args, raw);
  if (sub === "branch") return parseGitBranch(cmd, args, raw);
  return null;
});
