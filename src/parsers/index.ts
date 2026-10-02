import { ParserRegistry }                                              from "./registry.js";
import { parseLs, parseFind, parseStat, parseDu, parseDf, parseTree } from "./fs/index.js";
import { parsePs, parseKill }                                          from "./process/index.js";
import { parsePing, parseCurl, parseNetstat, parseLsof, parseSs,
         parseDig }                                                    from "./network/index.js";
import { parseGrep, parseWc, parseHead, parseTail, parseCat }         from "./text/index.js";
import { parseGitStatus, parseGitLog, parseGitDiff, parseGitBranch }  from "./git/index.js";
import { parseEnv, parsePwd, parseWhich }                             from "./env/index.js";
import { parseFree, parseUname, parseId, parseSystemctl, parseJournalctl, parseApt, parseBrew } from "./system/index.js";
import { parseDir, parseTasklist, parseIpconfig, parseSysteminfo }    from "./windows/index.js";
import { parseKubectl, parseDocker, parseGh, parseHelm, parseTerraform } from "./devops/index.js";
import { parseNpm, parseCargo } from "./packages/index.js";
import { supportsLs, supportsPs, supportsSs, supportsFree, supportsKubectl, supportsDocker, supportsHelm,
         supportsDig, supportsCurl, supportsWc, supportsId, supportsUname, supportsDf, supportsGit } from "./supports.js";

/**
 * 44개 내장 파서가 등록된 새 ParserRegistry 인스턴스를 생성한다.
 * 호출할 때마다 새 인스턴스를 반환하므로, 테스트나 CLI에서 독립적으로 사용 가능.
 */
export function createRegistry(): ParserRegistry {
  const registry = new ParserRegistry();

  registry.register("ls",      parseLs,      { supports: supportsLs, noise: /^total \d+|^\S.*:$/ });
  registry.register("find",    parseFind);
  registry.register("stat",    parseStat);
  registry.register("du",      parseDu);
  registry.register("df",      parseDf,      { supports: supportsDf, headerLines: 1 });
  registry.register("tree",    parseTree);
  registry.register("ps",      parsePs,      { supports: supportsPs, headerLines: 1 });
  registry.register("kill",    parseKill);
  registry.register("ping",    parsePing);
  registry.register("curl",    parseCurl,    { supports: supportsCurl });
  registry.register("netstat", parseNetstat, { headerLines: 2 });
  registry.register("lsof",    parseLsof,    { headerLines: 1 });
  registry.register("ss",      parseSs,      { supports: supportsSs, headerLines: 1 });
  registry.register("dig",     parseDig,     { supports: supportsDig });
  registry.register("grep",    parseGrep);
  registry.register("wc",      parseWc,      { supports: supportsWc });
  registry.register("head",    parseHead);
  registry.register("tail",    parseTail);
  registry.register("cat",     parseCat);
  registry.register("env",     parseEnv);
  registry.register("pwd",     parsePwd);
  registry.register("which",   parseWhich);
  registry.register("free",       parseFree,       { supports: supportsFree });
  registry.register("uname",      parseUname,      { supports: supportsUname });
  registry.register("id",         parseId,         { supports: supportsId });
  registry.register("systemctl",  parseSystemctl,  { noise: /^\s*UNIT\s+LOAD\s|^Legend:|^\s*(LOAD|ACTIVE|SUB)\s+(=|->)|loaded units listed|^To show all/ });
  registry.register("journalctl", parseJournalctl, { noise: /^-- No entries --$/ });
  registry.register("dir",        parseDir);
  registry.register("tasklist",   parseTasklist,   { headerLines: 2 });
  registry.register("ipconfig",   parseIpconfig);
  registry.register("systeminfo", parseSysteminfo);
  registry.register("kubectl",    parseKubectl,    { supports: supportsKubectl, headerLines: 1 });
  registry.register("docker",     parseDocker,     { supports: supportsDocker, headerLines: 1 });
  registry.register("gh",         parseGh);
  registry.register("helm",       parseHelm,       { supports: supportsHelm, headerLines: 1 });
  registry.register("terraform",  parseTerraform);
  registry.register("apt",        parseApt,        { noise: /^(Listing|나열 중)/ });
  registry.register("brew",       parseBrew);
  registry.register("npm",       parseNpm);
  registry.register("pnpm",      parseNpm);
  registry.register("yarn",      parseNpm);
  registry.register("cargo",     parseCargo);

  // git은 서브커맨드 기반 — args[0]으로 파서를 선택
  registry.register("git", (cmd, args, raw) => {
    const sub = args[0];
    if (sub === "status") return parseGitStatus(cmd, args, raw);
    if (sub === "log")    return parseGitLog(cmd, args, raw);
    if (sub === "diff")   return parseGitDiff(cmd, args, raw);
    if (sub === "branch") return parseGitBranch(cmd, args, raw);
    return null;
  }, { supports: supportsGit });

  return registry;
}

/**
 * 하위 호환용 전역 싱글턴. 기존 server.ts import를 깨지 않기 위해 유지.
 * @deprecated 신규 코드는 createRegistry()를 사용할 것.
 */
export const defaultRegistry = createRegistry();
