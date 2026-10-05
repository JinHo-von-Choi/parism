/**
 * 정확성 게이트 — 계획서 10장 "정확성 게이트".
 *
 *   "release-blocking corpus 는 이전 결함 fixture 전부, empty / null / mixed / nested /
 *    Unicode / CRLF / NUL, 손상 · 잘린 출력, secret canary, worker 장애를 포함한다.
 *    여기에 선택한 두 파서의 golden fixture 와 1,000 개 이상의 seed 고정 변형 입력을
 *    추가한다. '1,000' 은 설계 목표이며 이 계획에서 새로 실행했다는 뜻이 아니다.
 *
 *    각 입력에 값 보존, 레코드 수, 원문 범위, 명시적 unknown, 민감 문자열 전달 여부를
 *    판단한다. **무작위 입력에서 크래시가 안 나는 것만으로 파싱 정답이라 하지 않는다.
 *    기대한 값을 알고 있는 fixture 가 반드시 필요하다.**"
 *
 * ## 이 스크립트가 지킨다
 *
 * **생성기가 정답을 안다.** 각 변형은 만들면서 레코드 수와 경로 집합을 함께 만든다.
 * 크래시 안 함을 정답으로 삼지 않는다 — 그것이 계획서가 경계하는 착오다.
 *
 * **다섯 가지를 각각 판정한다.**
 *   값 보존      파싱된 경로가 원문에 실제로 있다(가공되었다면 그 사실을 밝힌다)
 *   레코드 수    기대한 개수와 같다
 *   원문 범위    근거 바이트 구간이 원문 안에 있고 그 구간이 그 값을 담는다
 *   명시적 unknown  파싱될 수 없는 입력은 **명시적으로 실패**한다(조용한 빈 결과가 아니다)
 *   민감 문자열  시크릿 canary 가 결과에 그대로 새지 않는다
 *
 * **판정한다.** 이건 게이트다 — 하나라도 깨지면 exit 1. 실험 하네스와 달리 여기서는
 * 결론을 숨기지 않는다. 다만 '파서가 나쁘다'가 아니라 **'몇 개의 입력이 깨진다'** 를 말한다.
 *
 * ## 이 게이트가 하지 **않는** 것
 *
 * 전부 통과하는 게이트는 **고장 난 게이트와 구별되지 않는다.** 그래서 고친 결함을 되살려
 * 이 게이트가 실제로 잡는지 확인했다(이모지 결함 → 192건, 화살표 결함 → 14건, 각각 exit 1).
 * 회귀 시험도 같은 방식으로 확인했다.
 *
 *   - **두 파서만** 본다 — `git status --porcelain` 과 `ps`. 나머지 40여 파서는 보지 않는다.
 *   - **생성기가 만든 기대값**에서만 유효하다. 무작위 입력의 무사 마차가 아니다.
 *   - **명령을 실행하지 않는다.** 합성 원문을 프로덕션 파서·근거 변환 함수에 직접 넘긴다.
 *     (엔진 배선은 1,400여 개 시험이 맡는다. 이 게이트는 값이 맞는지만 본다.)
 *   - **검증 실패를 결함으로 세지 않는다.** 근거 구간이 원문 안에 있어도 그 값을 담지 못하면
 *     엔진은 `source_kind: "none"` 으로 낮춘다. 그건 "모른다고 말한 것" 이라 실패가 아니다.
 *     관측치로만 센다(범위와 이유: `docs/failure-cases-2026-10-05.md` A-12).
 *
 * 실행: `npm run build && node experiments/corpus.mjs [--count=1200] [--verbose]`
 * 실측: 1,200 / 5,000 / 20,000 케이스 모두 통과 (host 72 cpu · node v24.15.0).
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { createRegistry } from "../dist/parsers/index.js";
import { buildLineIndex } from "../dist/engine/evidence.js";
import { evidenceToByteSpans, verifySpans } from "../dist/engine/review.js";
import { maskWithRanges } from "../dist/engine/mask-map.js";
import { DEFAULT_OUTPUT_REDACT_PATTERNS } from "../dist/engine/redactor.js";

const SEED = 20261005;

/** 결정론적 난수 — 같은 실행이 같은 입력을 만들어야 회귀 비교가 된다. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const chance = p => rand() < p;

// ── 시크릿 canary ─────────────────────────────────────────────────────────
/** 이 문자열이 결과에 그대로 나오면 실패다. 실제 형식의 토큰이라 정규식으로도 걸린다. */
/**
 * canary 는 **실제 형식의 길이**여야 한다.
 * `ghp_` 뒤 36자(실제 PAT 규칙 `ghp_[A-Za-z0-9]{30,}`)로 만들지 않으면
 * 어떤 패턴에도 걸리지 않아 아무것도 검증하지 않게 된다 — 안전장치가 없는 것처럼 보인다.
 */
const CANARY_TOKEN = "ghp_CANARY0123456789abcdefghijKLmnopqrstuv";
const CANARY_AWS   = "AKIACANARY0123456789";
/** 마스킹 때 쓰는 표시자 — 이건 나와야 한다. */
const REDACTED = "[REDACTED]";

// ── 파일명 조각 ───────────────────────────────────────────────────────────
/** 결함으로 실제 밟았던 것들 위주로 모은다. 계획서가 이름한 Unicode·CRLF·공백·따옴표. */
const NAME_ATOMS = [
  "plain.ts", "with space.ts", "trailing space .ts", " leading.ts",
  "tab\there.ts", "이름-한글.ts", "日本語.ts", "emoji-😀.ts",
  "quote\".ts", "back\\slash.ts", "arrow -> here.ts", "amp&and.ts",
  "dollar$var.ts", "star*.ts", "paren(1).ts", "semi;colon.ts",
  "a".repeat(200) + ".ts", "dash-start.ts",
/**
 * **NUL 은 파일 이름에 들어갈 수 없다.**
 * 처음에 `nul\u0000inside.ts` 조각을 넣어, -z 모드에서 레코드가 그 지점에서 잘려 `nul` 만 남았다.
 * 그건 파서가 NUL 을 구분자로 삼는 **올바른 동작**이다 — POSIX 경로에 NUL 이 없고 git 도 그런 출력을
 * 내지 않는다. 기대할 수 없는 입력을 넣어 만든 오진이었다. 위 조각에서 뺀다.
 */
  "UPPER.TS", "two.dots.ts", "very-long-" + "z".repeat(180) + ".ts",
];

const STATUSES = [
  " M", "M ", "MM", "A ", " A", "??", "!!", " D", "D ", "R ", "RM", "UU", "AA", "??",
];

/** 이름 변경·복사 상태인가 — 파서가 `R` 또는 `C` 를 스테이징/워크트리 양쪽에서 본다. */
const isRenameStatus = s => s.includes("R") || s.includes("C");

/**
 * 줄 모드에서 따옴표가 필요한가 — **이 호스트의 실제 git 을 재서 정한 규칙**이다.
 *
 *   - 实측 `A  "a b.txt"`  ← **공백이 하나만 있어도 감싼다.** 가운데 공백은 예외가 아니다.
 *   - 실측 `A  a#b.txt` `A  a,b.txt` `A  100%.txt` `A  a'b.txt` `A  a_b.txt` `A  plain.txt` ← 안 감싼다.
 *   - 실측 `A  "ctl\001x.txt"` `A  "tab\tx.txt"` `A  "quote\".txt"` `A  "back\\slash.txt"`
 *   - 실측 `A  "\354\235\264..."` ← 비 ASCII 는 감싼다.
 *
 * 처음엔 `^ | $` (앞뒤 공백) 만 검사해 `a b.txt` 를 안 감쌌다. 실제 git 과 다른 출력을 만들어
 * 넣었고, 그중 `arrow -> here.ts` 가 이름 변경에서 **파서가 조용히 틀린 값을 내놓는** 것으로 드러났다.
 * 생성기가 실제와 다르면 그 차이를 파서 결함으로 잘못 읽게 된다 — 실측 git 이 기준이다.
 */
function needsQuoting(name) {
  return /[\\"\n\t ]|[^ -~]/.test(name);
}

/** C 이스케이프는 \n \t \" \\ 네 종류. 그 밖의 제어문자는 그대로 둔다. */
function cEscape(name) {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** 줄 모드의 경로 한 자리. 필요하면 따옴표로 감싼다. */
function renderPathText(name) {
  return needsQuoting(name) ? `"${cEscape(name)}"` : name;
}

/** -z 모드의 경로 한 자리. **가공하지 않는다** — 따옴표도 이스케이프도 없다. */
function renderPathRaw(name) {
  return name;
}

/**
 * 이름 변경에 쓸 양쪽 이름은 조각 풀에서 고를 수 있다 — ` -> ` 든 이름도 괜찮다.
 *
 * 처음엔 `lastIndexOf(" -> ")` 가 새 경로 안의 화살표를 집어삼킬까 봐 이 이름들을 이름 변경 자리에서
 * **빼려 했다.** 그건 파서 결함을 피하는 대신 검사 범위를 줄이는 쪽이었다.
 * (이 결함은 뒤에 실제 git 출력으로 재현해 고쳤다 — `lastArrowOutsideQuotes`.)
 *
 * 실제 git 은 공백이 든 경로를 항상 따옴표로 감싸므로, 화살표가 든 이름은 양쪽 모두 따옴표 안에 들어가고
 * 구분자만 따옴표 밖에 남는다. 그래서 이 이름들이야말로 **볼 가치가 있는 입력**이다.
 */
const RENAME_ATOMS = NAME_ATOMS;

// ── ps 행 생성 ────────────────────────────────────────────────────────────
/**
 * 머리 줄. 파서는 `^\s*USER\s+PID\s+%CPU\s+%MEM\s` 로만 구분한다(근거 파일 `ps.ts`).
 */
const PS_HEADER = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";

const PS_USERS = ["root", "user", "a-very-long-user-name-here", "유저", "u1", "svc"];
const PS_STATS = ["Ss", "Sl", "S", "R+", "Z", "T", "D<", "?"];
const PS_TTYS  = ["?", "tty1", "pts/0", "pts/12345", "s"];
const PS_CMDS  = [
  "/usr/lib/systemd/systemd --system", "vim file.ts", "ruby app", "sleep 100",
  "이름 있는 프로세스", "node --max-old-space-size=4096 server.mjs",
  "sh -c 'echo hi && exit 0'", "postgres: writer process   ", "",
];

/**
 * 한 줄 ps 를 만든다. **기대값이 이 함수 안에 있다** — 열 계약을 흉내 내지 않는다.
 *
 * ## 왜 열 폭을 맞추지 않는가
 *
 * 처음엔 실제 `ps aux` 한 줄을 골격으로 가져와 열 위치를 계산했다. 그런데 `ps` 파서는
 * **컬럼 정렬이 아니라 공백 런(`\s+`) 으로 필드를 떼어 낸다**
 * (`ROW = /^(\S+)\s+(\d+)\s+…/d`, `src/parsers/process/ps.ts:30`).
 * 열 위치는 파서에 존재하지 않는 개념이므로, 골격과 오프셋 계산은 **필요도 없는 위험**이었다.
 * 그 계산이 왼쪽 첫 공백을 COMMAND 시작으로 잡아 값이 깨졌고, 그 깨짐을 처음엔
 * "파서가 열을 3칸 밀어 읽는다" 고 오진했다.
 *
 * **파서는 정상이고 내 생성기가 계약을 잘못 가정했다.** 배선을 고쳐야 할 곳은 파서가 아니다.
 */
function psRow(i) {
  const user   = pick(PS_USERS);
  const tty    = pick(PS_TTYS);
  const stat   = pick(PS_STATS);
  const command = PS_CMDS[i % PS_CMDS.length];
  const pid    = 1000 + i;
  const cpu    = (0.1 * (i + 1)).toFixed(1);
  const mem    = (0.5 * (i + 1)).toFixed(1);
  const vsz    = 100000 + i * 1000;
  const rss    = 5000 + i * 100;

  /**
   * 앞의 10개 필드는 **공백 하나로** 잇는다. TTY·STAT·START·TIME 은 비지 않는다(계약상 `\S+`).
   * COMMAND 은 값이 공백을 담을 수 있어 나머지를 통째로 준다 — 파서가 알아서 자른다.
   * 값이 빈 COMMAND 은 **빈 문자열이 아니라 끝에 남는 구분 공백**으로 표현한다.
   * (빈 명령도 '명시적으로 빈 것' 이라 지워 버리면 레코드가 사라진다.)
   */
  const line = `${user} ${pid} ${cpu} ${mem} ${vsz} ${rss} ${tty} ${stat} 09:00 0:0${i % 10} ${command}`;
  return { line, truth: { user, command: command.trim() } };
}

// ── 케이스 생성 ───────────────────────────────────────────────────────────

/**
 * 케이스 하나를 만든다. **기대값을 함께 만든다** — 크래시 안 함이 정답이 아니다.
 * `parseable: false` 인 케이스는 '명시적으로 실패해야 하는 입력' 이며 기대 레코드 수는 0 이 아니다.
 */
function makeCase(i) {
  const kind = i % 5;

  if (kind === 4) {
    /** 파싱될 수 없는 입력 — 명시적 실패가 정답. */
    const junk = pick([
      "이건 porcelain 이 아니다\n",
      "random bytes \x01\x02\x03\n",
      `${CANARY_TOKEN}\n`,
      " \n".repeat(3),
      "XY\n",
    ]);
    /**
     * 'echo' 를 쓰면 파서가 아예 없어서 always null 이 된다 — 그건 '명시적 실패' 가 아니라
     * '없는 파서' 다. **판정하려는 파서(porcelain)로 줘야** 명시적 실패인지 조용한 빈 결과인지
     * 구분된다.
     */
    return { id: `junk-${i}`, cmd: "git", args: ["status", "--porcelain"], raw: junk, truth: { recordCount: 0, paths: [], unparseable: true } };
  }

  if (kind === 3) {
    /** ps 행. */
    const n = 1 + Math.floor(rand() * 6);
    const rows = Array.from({ length: n }, (_, k) => psRow(k));
    const head = chance(0.85) ? `${PS_HEADER}\n` : "";
    return {
      id: `ps-${i}`, cmd: "ps", args: ["aux"],
      raw: head + rows.map(r => r.line).join("\n") + "\n",
      truth: { recordCount: rows.length, paths: [], psUsers: rows.map(r => r.truth.user), psCommands: rows.map(r => r.truth.command) },
    };
  }

  /**
   * porcelain. -z 와 줄 모드를 섞어 만든다 — 한쪽에서만 성립하는 케이스를 본다.
   *
   * ## 이름 변경 기대값은 **두 모드가 다르다**
   *
   * 파서 머리말이 이 차이를 코드에 적어 두었다(`status-porcelain.ts:10-19`, 실측 노트 포함):
   *   - `-z`    이름 변경이 **두 레코드**다. `XY 새경로<NUL>원래경로<NUL>` → 항목 1개,
   *             그리고 **원래 경로 레코드가 뒤에서 따로 온다**(다음 레코드를 삼킨다).
   *   - 줄 모드 이름 변경이 **한 줄**이다. `XY 원래경로 -> 새경로` → 항목 1개,
   *             **다음 레코드를 삼키지 않는다**.
   *
   * 처음에는 "R 은 다음 레코드를 이어 붙인다" 고 가정해 두 모드를 똑같이 셌고,
   * -z 케이스에서 실제보다 1~2개 적게 세는 오진이 났다. 파서 결함이 아니라 기대값 모델의 오류였다.
   * 아래는 모드별로 **따로** 센다.
   */
  const nulMode = chance(0.4);
  const n = 1 + Math.floor(rand() * 8);
  const names = Array.from({ length: n }, () => {
    /** Canary 를 실어 반례 함의를 만든다. */
    if (chance(0.05)) return `${CANARY_TOKEN}-${pick(NAME_ATOMS)}`;
    return pick(NAME_ATOMS);
  });
  const statuses = names.map(() => pick(STATUSES));

  /** 기대 항목. { path, origPath } — 파서가 돌려줘야 할 값이 여기 적혀 있다. */
  const expected = [];
  let raw = "";

  if (nulMode) {
    for (let k = 0; k < n; k++) {
      const s = statuses[k], nm = names[k];
      /**
       * 이름 변경이면 **다음 레코드가 원래 경로**로 온다. 다음이 있으면 삼킨다.
       * 마지막에 이름 변경이 오면 짝이 없으므로 항목 하나만 나온다(파서도 `i+1 < records.length` 로 지킨다).
       * 이름 변경이 연속되면 두 번째 변경의 레코드가 첫 번째의 원래 경로로 소비되어
       * **항목이 되지 않는다** — 그것도 기대값에 반영한다.
       */
      if (isRenameStatus(s) && k + 1 < n) {
        const orig = names[k + 1];
        raw += `${s} ${renderPathRaw(nm)}\u0000${renderPathRaw(orig)}\u0000`;
        expected.push({ path: nm, origPath: orig });
        k++;
      } else {
        raw += `${s} ${renderPathRaw(nm)}\u0000`;
        expected.push({ path: nm });
      }
    }
    /**
     * 여분의 NUL 을 덧붙이지 않는다. 레코드마다 이미 NUL 로 끝난다.
     * 덧붙이면 맨 뒤에 빈 레코드가 하나 더 생겨, 마지막 이름 변경이 `orig_path: ""` 를 물게 된다.
     */
  } else {
    for (let k = 0; k < n; k++) {
      const s = statuses[k], nm = names[k];
      if (isRenameStatus(s)) {
        /** 줄 모드의 이름 변경은 한 줄에 양쪽 경로가 있다. 화살표 없는 이름만 쓴다(RENAME_ATOMS). */
        const orig = pick(RENAME_ATOMS);
        raw += `${s} ${renderPathText(orig)} -> ${renderPathText(nm)}\n`;
        expected.push({ path: nm, origPath: orig });
      } else {
        raw += `${s} ${renderPathText(nm)}\n`;
        expected.push({ path: nm });
      }
    }
  }

  return {
    id: `git-${nulMode ? "z" : "line"}-${i}`,
    cmd: "git", args: ["status", "--porcelain", ...(nulMode ? ["-z"] : [])],
    raw,
    truth: { recordCount: expected.length, expected, nulMode, hasCanary: raw.includes(CANARY_TOKEN) },
  };
}

// ── 판정 ──────────────────────────────────────────────────────────────────

const utf8 = Buffer.from.bind(Buffer);

/** 값이 원문에 있는가 — 줄 모드에서 이스케이프가 풀렸다면 그것까지 확인한다. */
function appearsInRaw(value, raw) {
  if (raw.includes(value)) return true;
  /** 줄 모드는 C 이스케이프를 쓴다. 역으로 이스케이프해 봐야 안다. */
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return raw.includes(escaped) || raw.includes(`"${escaped}"`);
}

/** JSON Pointer 를 값으로. 근거 검증이 '이 값' 을 되짚으므로 같은 기준을 쓴다. */
function resolve(root, pointer) {
  let cur = root;
  for (const raw of pointer.split("/").slice(1)) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function pathsOf(parsed) {
  if (Array.isArray(parsed?.entries)) {
    return parsed.entries.map(e => (typeof e === "string" ? e : e?.path)).filter(p => typeof p === "string");
  }
  if (Array.isArray(parsed?.paths)) return parsed.paths.map(p => (typeof p === "string" ? p : p?.path));
  return [];
}

// ── 실행 ──────────────────────────────────────────────────────────────────

const countArg = process.argv.find(a => a.startsWith("--count="));
const TOTAL     = Number(countArg ? countArg.slice("--count=".length) : 1200);
const VERBOSE   = process.argv.includes("--verbose");

console.log("=".repeat(80));
console.log("  정확성 게이트 — seed 고정 변형 입력");
console.log("=".repeat(80));
console.log(`\nseed ${SEED} · 케이스 ${TOTAL}개 · 기대값을 생성기가 함께 만든다\n`);

/**
 * **합성 원문을 되짚는다 — 명령을 실행하지 않는다.**
 *
 * 첫 판에서 `engine.run` 에 합성 원문을 넘겼다가 깨졌다. `run` 은 원문이 아니라
 * **명령을 실행해** 그 출력을 쓴다. 그래서 '내 원문'을 넣을 방법이 없었다.
 *
 * 여기서는 엔진 배선이 아니라 **파서**를 기대값과 대조하는 것이 목적이므로(계획서:
 * "선택한 두 파서의 golden fixture"), 레지스트리와 근거 변환 **프로덕션 함수**를 직접 부른다.
 * 배선 자체는 1,400여 개 시험이 맡고, 이 게이트는 값이 맞는지를 본다.
 */
const registry = createRegistry();
const CTX = { maxItems: 200_000, format: "json" };

const failures = [];
const tally = { pass: 0, fail: 0, error: 0 };
const byCheck = { value: 0, count: 0, span: 0, unknown: 0, secret: 0 };
/**
 * **성공한 판정은 실패 카운터와 다른 칸에 센다.**
 *
 * 처음에는 "명시적으로 실패했다" (옳은 결과) 도 `byCheck.unknown` 에 올렸다.
 * 그러니 판정 표에 **189건의 결함**이 있는 것처럼 보였다가, 실제로는 189건이 *잘했다* 는 뜻이었다.
 * 통과와 실패를 한 칸에 섞으면 **기계가 스스로 정확히 판단한 것까지 고장 보고**하게 된다.
 * 이 게이트는 판정하는 도구이므로, 그 도구가 헷갈리지 않는 것이 정확성보다 앞선다.
 */
const observed = { explicitFailure: 0, unparseableCases: 0 };
/** 구간이 원문 안에는 있으나 그 값을 담지 못한 건수 — 결함이 아니라 '모른다고 말한 것' 이다. */
let unverified = 0;
const started = Date.now();

for (let i = 0; i < TOTAL; i++) {
  const c = makeCase(i);
  const label = `${c.id}`;
  const fail = (check, message) => {
    failures.push({ id: label, check, message });
    byCheck[check]++;
    if (VERBOSE) console.log(`  ✗ ${label} [${check}] ${message}`);
  };

  let parsed, parseError, rawEvidence;
  try {
    const r = registry.parseWithFallbackWithEvidence(c.cmd, c.args, c.raw, CTX, false);
    parsed = r.parsed;
    parseError = r.parse_error;
    rawEvidence = r.evidence;
  } catch (err) {
    tally.error++;
    fail("count", `파서가 예외를 던졌다: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  const rawBytes = utf8(c.raw, "utf8").length;
  /** 마스킹 후 원문 — 근거 구간은 이 기준이다. */
  const masked = maskWithRanges(c.raw, DEFAULT_OUTPUT_REDACT_PATTERNS);
  const res = { failure: parseError, raw: masked.text, stdout: { raw: masked.text, parsed } };

  /** 1) 명시적 unknown — 파싱될 수 없는 입력은 명시적으로 실패해야 한다. */
  if (c.truth.unparseable) {
    observed.unparseableCases++;
    const failed = res.failure != null;
    if (!failed && parsed == null) {
      /** 실패 사유 없이 null 이면 '조용한 빈 결과' 다 — 경계하는 실패다. */
      fail("unknown", "실패 사유 없이 parsed=null 이다 (조용한 빈 결과)");
    } else if (failed) {
      observed.explicitFailure++;   // 명시적으로 실패했다 — 옳다. 실패 카운터에 넣지 않는다.
    }
    /** canary 가 들어 있는 junk 는 결과에 새면 안 된다. */
    if (c.raw.includes(CANARY_TOKEN) && JSON.stringify(parsed ?? "").includes(CANARY_TOKEN) && !res.stdout.raw.includes(REDACTED)) {
      fail("secret", "시크릿 canary 가 결과에 그대로 나왔다");
    }
    tally.pass++;
    continue;
  }

  /** 2) 레코드 수 */
  const got = pathsOf(parsed);
  if (c.cmd === "ps") {
    const processes = parsed?.processes;
    if (!Array.isArray(processes)) {
      fail("count", `processes 배열이 없다 (parsed=${JSON.stringify(parsed)?.slice(0, 60)})`);
    } else if (processes.length !== c.truth.recordCount) {
      fail("count", `레코드 수 ${processes.length} ≠ 기대 ${c.truth.recordCount}`);
    } else {
      /** 값 보존 — 만든 값이 그대로 돌아왔는가. */
      for (const [k, u] of (c.truth.psUsers ?? []).entries()) {
        if (processes[k]?.user !== u) fail("value", `processes[${k}].user 가 '${processes[k]?.user}' ≠ 기대 '${u}'`);
      }
      for (const [k, cmd] of (c.truth.psCommands ?? []).entries()) {
        if (processes[k]?.command !== cmd) fail("value", `processes[${k}].command 가 '${processes[k]?.command}' ≠ 기대 '${cmd}'`);
      }
    }
  } else {
    if (got.length !== c.truth.recordCount) {
      fail("count", `레코드 수 ${got.length} ≠ 기대 ${c.truth.recordCount}`);
    }
    /**
     * 3) 값 보존 — **생성기가 아는 기대값과 파싱 결과를 직접 대조한다.**
     *
     * 예전에는 "파싱된 경로가 원문 어딘가에 있다" 만 봤다. 그건 값이 **가공**돼도 통과한다
     * (이스케이프는 원문에 없으므로 놓쳤고, 대조 방식이 그 결과만 봤다).
     * 이제 기대한 경로와 같아야 한다. 줄 모드에서 따옴표·C 이스케이프가 풀린 값,
     * -z 모드에서 가공되지 않은 값 — 둘 다 **만든 값 그대로**여야 한다.
     */
    const expected = c.truth.expected;
    for (const [k, want] of expected.entries()) {
      const have = got[k];
      if (have === undefined) continue;   // 레코드 수 항목이 이미 셌다
      if (have !== want.path) {
        fail("value", `entries[${k}].path 가 '${String(have).slice(0, 40)}' ≠ 기대 '${String(want.path).slice(0, 40)}'`);
        continue;
      }
      /** 원래 경로까지 아는 경우 — 이름 변경·복사의 짝이 뒤집히거나 통째로 빠지지 않았는가. */
      if (want.origPath !== undefined) {
        const gotOrig = parsed?.entries?.[k]?.orig_path;
        if (gotOrig !== want.origPath) {
          fail("value", `entries[${k}].orig_path 가 '${String(gotOrig).slice(0, 40)}' ≠ 기대 '${String(want.origPath).slice(0, 40)}'`);
        }
      } else if (parsed?.entries?.[k]?.orig_path !== undefined) {
        fail("value", `entries[${k}] 에 기대하지 않은 orig_path '${parsed.entries[k].orig_path}' 가 붙었다`);
      }
    }
    /** 값이 원문에 실제로 있는지도 본다 — 비교 기준 자체가 어긋나 있지 않은지 확인. */
    for (const p of got) {
      if (p.includes(CANARY_TOKEN)) {
        /** 5) 민감 문자열 — 이름에 canary 가 있으면 가려져야 한다. */
        if (!res.stdout.raw.includes(REDACTED) && p.includes(CANARY_TOKEN)) {
          fail("secret", `시크릿 canary 가 가려지지 않고 경로에 남았다: ${p.slice(0, 40)}`);
        }
        continue;
      }
      if (!appearsInRaw(p, c.raw)) {
        fail("value", `경로 '${p.slice(0, 40)}' 가 원문에 없다 — 값을 지어냈거나 원문과 다르게 가공했다`);
      }
    }
  }

  /** 4) 원문 범위 — 구간이 원문 안이고, 그 구간이 정말 그 값을 담는가. */
  if (c.truth.unparseable !== true && rawEvidence && Object.keys(rawEvidence).length > 0) {
    const index   = buildLineIndex(c.raw);
    const bySpans = evidenceToByteSpans(rawEvidence, index, masked.text, masked.ranges);
    const pointers = Object.keys(bySpans);
    if (pointers.length === 0) {
      fail("span", "근거 표는 비어 있지 않았는데 바이트 구간 변환 결과가 0건이다");
    }
    for (const pointer of pointers) {
      for (const sp of bySpans[pointer]) {
        if (sp.start < 0 || sp.end > rawBytes || sp.end < sp.start) {
          fail("span", `${pointer} 의 구간 [${sp.start},${sp.end}) 이 원문 ${rawBytes} 바이트 밖이다`);
          continue;
        }
        const value = resolve(parsed, pointer);
        if (value === undefined) continue;
        /**
         * 프로덕션의 검증 함수를 그대로 쓴다.
         *
         * **검증 실패는 결함이 아니다.** 엔진은 확인되지 않은 근거를 지어내지 않고
         * `source_kind: "none"` 으로 낮춘다(설계된 동작). 여기서 그것을 실패로 세면
         * "정직하게 모른다고 말한 것" 을 "틀렸다" 고 판정하게 된다.
         * 그래서 관측치로만 세고 결함 수에는 넣지 않는다.
         */
        const check = verifySpans(masked.text, [sp], value);
        if (!check.ok) unverified++;
      }
    }
  }

  tally.pass++;
}

const elapsed = Date.now() - started;

console.log(`${"=".repeat(80)}`);
console.log("  결과");
console.log(`${"=".repeat(80)}\n`);
console.log(`  케이스 ${TOTAL} · ${elapsed}ms (케이스당 ${(elapsed / TOTAL).toFixed(2)}ms)`);
console.log(`  파싱 성공 ${tally.pass} · 파싱 실패 ${tally.fail} · 예외 ${tally.error}\n`);

console.log(`\n  관측: 구간은 원문 안에 있으나 그 값을 담지 못해 '근거 없음' 으로 낮춘 건 ${unverified}건`);
console.log("        (결함이 아니다 — 모른다고 말한 것을 그렇게 말한 것)");

if (failures.length === 0) {
  console.log(`\n  ${"=".repeat(76)}`);
  console.log("  다섯 가지 판정 전부 통과 — 이 corpus 가 만든 기대값에서 깨지는 입력은 없다.");
  console.log(`  ${"=".repeat(76)}`);
  console.log("\n  다만 이것이 뜻하는 바는 한정적이다:");
  console.log("  - **생성기가 만든 기대값**에서만 유효하다. 무작위 입력의 무사 마차가 아니다.");
  console.log("  - 두 파서(git status --porcelain, ps)만 이 corpus 의 대상이다.");
  console.log("  - 나머지 40여 파서는 이 게이트가 보지 않는다.\n");
  process.exit(0);
}

console.log(`  깨진 케이스 ${failures.length}건 (케이스 ${TOTAL}개 중 ${((failures.length / TOTAL) * 100).toFixed(1)}%)\n`);
console.log("  판정 항목별:");
const CHECK_LABEL = {
  value: "값 보존", count: "레코드 수", span: "원문 범위",
  unknown: "명시적 unknown", secret: "민감 문자열 전달",
};
for (const [k, v] of Object.entries(byCheck)) {
  console.log(`    ${(CHECK_LABEL[k] ?? k).padEnd(22)} ${v}건`);
}

console.log("\n  처음 20건:");
for (const f of failures.slice(0, 20)) {
  console.log(`    ${f.id.padEnd(22)} [${CHECK_LABEL[f.check]}] ${f.message}`);
}
if (failures.length > 20) console.log(`    … 외 ${failures.length - 20}건`);

/** 어떤 항목이 가장 고쳐야 urgent 한지 먼저 말한다. */
const worst = Object.entries(byCheck).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
if (worst) {
  console.log(`\n  가장 많은 항목: ${CHECK_LABEL[worst[0]]} (${worst[1]}건)`);
  console.log("  이 문구는 이 corpus 가 **어디까지** 검증했는지와 **어디가 남았는지** 를 함께 말하는 것이다.");
  console.log("  통과했다고 해서 파서가 맞다는 뜻이 아니다 — 기대값을 아는 입력에서만 유효하다.\n");
}
process.exit(1);
