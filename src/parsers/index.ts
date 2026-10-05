import { ParserRegistry, type ParserFn }                                from "./registry.js";
import { parseLs, parseFind, parseStat, parseDu, parseDf, parseTree } from "./fs/index.js";
import { parsePs, parsePsWithEvidence, parseKill }                     from "./process/index.js";
import { parsePing, parseCurl, parseNetstat, parseLsof, parseSs,
         parseDig }                                                    from "./network/index.js";
import { parseGrep, parseWc, parseHead, parseTail, parseCat }         from "./text/index.js";
import { parseGitStatus, parseGitLog, parseGitDiff, parseGitBranch }  from "./git/index.js";
import { parseGitStatusPorcelain, isPorcelainArgs }                        from "./git/status-porcelain.js";
import { parseEnv, parsePwd, parseWhich }                             from "./env/index.js";
import { parseFree, parseUname, parseId, parseSystemctl, parseJournalctl, parseApt, parseBrew } from "./system/index.js";
import { parseDir, parseTasklist, parseIpconfig, parseSysteminfo }    from "./windows/index.js";
import { parseKubectl, parseDocker, parseGh, parseHelm, parseTerraform } from "./devops/index.js";
import { parseNpm, parseCargo } from "./packages/index.js";
import { BUILTIN_CONTRACTS }                                         from "./contracts.js";
import { skipLeadingFlags }                                          from "./format.js";

/**
 * 44개 내장 파서가 등록된 새 ParserRegistry 인스턴스를 생성한다.
 * 호출할 때마다 새 인스턴스를 반환하므로, 테스트나 CLI에서 독립적으로 사용 가능.
 */
export function createRegistry(): ParserRegistry {
  const registry = new ParserRegistry();
  /** 내장 계약(BUILTIN_CONTRACTS)과 함께 파서를 등록한다. */
  const register = (cmd: string, fn: ParserFn): void => registry.register(cmd, fn, BUILTIN_CONTRACTS[cmd]);

  register("ls",      parseLs);
  register("find",    parseFind);
  register("stat",    parseStat);
  register("du",      parseDu);
  register("df",      parseDf);
  register("tree",    parseTree);
  register("ps",      parsePs);
  /** ps 는 열 위치가 고정이라 필드별 원문 구간을 정확히 가리킨다(계획서 5장 근거 조회 MVP). */
  registry.registerWithEvidence("ps", (args, raw, ctx) => parsePsWithEvidence("ps", args, raw, ctx).evidence);
  /** porcelain=v1 -z 는 레코드가 NUL 로 나뉘므로 경로에 개행이 있어도 구간이 정확하다. */
  registry.registerWithEvidence("git", (args, raw, ctx) => {
    const subArgs = args.slice(skipLeadingFlags(BUILTIN_CONTRACTS.git!, args));
    if (subArgs[0] !== "status" || !isPorcelainArgs(subArgs)) return {};
    return parseGitStatusPorcelain(subArgs, raw, { maxItems: ctx?.maxItems ?? 0 }).evidence;
  });
  register("kill",    parseKill);
  register("ping",    parsePing);
  register("curl",    parseCurl);
  register("netstat", parseNetstat);
  register("lsof",    parseLsof);
  register("ss",      parseSs);
  register("dig",     parseDig);
  register("grep",    parseGrep);
  register("wc",      parseWc);
  register("head",    parseHead);
  register("tail",    parseTail);
  register("cat",     parseCat);
  register("env",     parseEnv);
  register("pwd",     parsePwd);
  register("which",   parseWhich);
  register("free",       parseFree);
  register("uname",      parseUname);
  register("id",         parseId);
  register("systemctl",  parseSystemctl);
  register("journalctl", parseJournalctl);
  register("dir",        parseDir);
  register("tasklist",   parseTasklist);
  register("ipconfig",   parseIpconfig);
  register("systeminfo", parseSysteminfo);
  register("kubectl",    parseKubectl);
  register("docker",     parseDocker);
  register("gh",         parseGh);
  register("helm",       parseHelm);
  register("terraform",  parseTerraform);
  register("apt",        parseApt);
  register("brew",       parseBrew);
  register("npm",       parseNpm);
  register("pnpm",      parseNpm);
  register("yarn",      parseNpm);
  register("cargo",     parseCargo);

  /** git은 앞의 전역 옵션을 건너뛴 서브커맨드로 파서를 선택하고, 서브커맨드부터의 인자를 넘긴다. */
  register("git", (cmd, args, raw, ctx) => {
    const subArgs = args.slice(skipLeadingFlags(BUILTIN_CONTRACTS.git!, args));
    const sub     = subArgs[0];
    /**
     * porcelain=v1 형식은 long 형식과 모양이 다르다(행 배열 + NUL 레코드).
     * 한 파서가 두 형식을 섞어 읽으면 경로에 개행이 든 항목을 둘 중 하나에서 놓친다.
     */
    if (sub === "status" && isPorcelainArgs(subArgs)) {
      return parseGitStatusPorcelain(subArgs, raw, { maxItems: ctx?.maxItems ?? 0 }).parsed;
    }
    if (sub === "status") return parseGitStatus(cmd, subArgs, raw);
    if (sub === "log")    return parseGitLog(cmd, subArgs, raw);
    if (sub === "diff")   return parseGitDiff(cmd, subArgs, raw);
    if (sub === "branch") return parseGitBranch(cmd, subArgs, raw);
    return null;
  });

  return registry;
}

/**
 * 하위 호환용 전역 싱글턴. 기존 server.ts import를 깨지 않기 위해 유지.
 * @deprecated 신규 코드는 createRegistry()를 사용할 것.
 */
export const defaultRegistry = createRegistry();
