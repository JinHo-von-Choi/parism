/**
 * 토큰 비용 실측 — README 의 "솔직한 이야기" 절이 인용하는 수치의 출처.
 *
 * ## 왜 이 스크립트가 있는지
 *
 * README 는 "JSON 이 raw 보다 **205%** 무겁다"고 적고 있었는데, 그 수치의 출처 문서
 * (`docs/plans/2026-03-06-benchmark.md`) 는 **더 이상 존재하지 않았다.** 재현할 수 없는
 * 수치를 문서主张으로 남겨 둔 것이었다. 계획서 4.5장은 이를 "삭제하거나 시뮬레이션이라고
 * 명확히 고치라"고 했다.
 *
 * 지우는 것으로 끝내지 않고 **다시 측정했다.** 수치가 문장이 아니라 **여기서 돌릴 수 있는
 * 스크립트**가 되도록. 다음 사람이 같은 명령을 돌리면 같은 값이 나오고, 다르면 그 다름을
 * 설명할 의무가 생긴다.
 *
 * ## 무엇을 재는가
 *
 * 같은 `ls -la` 출력에 대해 두 형태의 **토큰 수**를 잰다.
 *   raw  — 사람이 보는 텍스트 그대로
 *   json — 파싱 결과(JSON 직렬화)
 *
 * **토크나이저를 명시한다.** 토크나이저가 다르면 값이 다르다. 여기서는 제품이 스스로
 * 노출하는 `parism/approx` 을 쓴다. 다른 토크나이저의 값과 이 값을 섞어 비교하지 않는다.
 *
 * ## 무엇을 재지 않는가
 *
 * **"AI한테 설명하는 토큰" 의 감소량은 재지 않는다.** 그것은 에이전트가 원문을 해석하는
 * 프롬프트를 얼마나 쓰는지, 즉 모델이 어떻게 동작하는지에 대한 수치여서 이 저장소에서
 * 잴 수 없다. README 는 그 자리를 측정하지 않았다는 사실을 밝힌다.
 *
 * 실행: `npm run build && node experiments/token-cost.mjs [--entries=200]`
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { execFileSync }          from "node:child_process";
import { rm, writeFile }         from "node:fs/promises";
import { join }                  from "node:path";
import { countJsonTokens }       from "../dist/engine/budget/tokenizer.js";
import { createEngine }          from "../dist/facade/engine.js";

const TOKENIZER = "parism/approx";

const entriesArg = process.argv.find(a => a.startsWith("--entries="));
const ENTRIES    = Number(entriesArg ? entriesArg.slice("--entries=".length) : 200);

console.log("=".repeat(80));
console.log("  토큰 비용 실측 — raw 텍스트 대 JSON");
console.log("=".repeat(80));
console.log(`\n항목 ${ENTRIES}개 · 토크나이저 ${TOKENIZER}\n`);

/**
 * 파싱 결과에서 항목 수를 센다. 모양이 두 가지(행 배열 / 열형)라 경우를 나눠 본다.
 * 그래도 못 찾으면 **모른다고 말하고 0 이다** — 엉뚱한 숫자를 지어내지 않는다.
 */
function countRows(parsed) {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed == null || typeof parsed !== "object") return 0;
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value)) return value.length;
    if (value != null && typeof value === "object") {
      const rows = value.rows;
      if (Array.isArray(rows)) return rows.length;
    }
  }
  return 0;
}

/**
 * 가드의 기본 `allowed_paths` 는 실행 디렉터리 하나다.
 * 임시 디렉터리가 그 밖에 있으면 실행이 `path_not_allowed` 로 막히고,
 * **토큰을 재려는 조사가 경계 거절로 조용히 흐러진다.** 그래서 cwd 안에 만든다.
 */
const dir = `.token-cost-${process.pid}`;
const started = Date.now();

try {
  await rm(dir, { recursive: true, force: true });
  await execFileSync("mkdir", ["-p", dir]);
  for (let i = 1; i <= ENTRIES; i++) {
    /** 파일 이름 길이를 들쭈날쭈하게 해 키 반복 비용이 길이 편차와 무관한지 드러나게 한다 */
    await writeFile(join(dir, `file_${i}.txt`), "x".repeat((i % 17) + 3) + "\n");
  }

  const raw   = execFileSync("ls", ["-la", dir], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const engine = await createEngine();
  const out   = await engine.run("ls", { args: ["-la", dir] });

  if (out.stdout.parsed == null) {
    console.log("  파싱이 되지 않았다 — 수치를 만들지 않는다. 이유:");
    console.log("  ", JSON.stringify(out.stdout.parse_error ?? out.guard_error ?? out.failure));
    process.exit(1);
  }

  const json    = JSON.stringify(out.stdout.parsed);
  const rawTok  = countJsonTokens(raw,  TOKENIZER);
  const jsonTok = countJsonTokens(json, TOKENIZER);
  const pct     = (jsonTok / rawTok - 1) * 100;

  /**
   * 항목 수를 정확히 센다.
   *
   * **파싱 결과의 모양이 크기에 따라 바뀐다** — 이건 알아야 할 사실이다.
   *   작은 목록  `{ entries: [ {...}, {...} ] }`
   *   큰 목록    `{ entries: { schema: [...], rows: [ [...], [...] ] } }` (열형)
   *
   * 최상위에서 배열을 찾지 못하고 키 개수를 세면 **항목 1개** 처럼 보인다.
   * 실제로는 200개인데 1로 적으면, 그 아래 모든 비율이 **무엇 대비 무거운지** 를 잃는다.
   * 실측에서 이걸 놓쳤다가 고쳤다.
   */
  const parsed = out.stdout.parsed;
  const rows = countRows(parsed);

  console.log(`  항목 수        ${rows}`);
  console.log(`  raw  글자      ${raw.length}`);
  console.log(`  raw  토큰      ${rawTok}`);
  console.log(`  JSON 글자      ${json.length}`);
  console.log(`  JSON 토큰      ${jsonTok}`);
  console.log(`\n  JSON 이 raw 보다 **${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%** ${pct >= 0 ? "무겁다" : "가볍다"}`);

  /**
   * 투영(`select` + `limit`)이 응답을 얼마나 줄이는지도 잰다.
   *
   * 앞의 raw 대 JSON 비교와 **비교 대상이 다르다.** 여기서는 둘 다 parism 응답이고,
   * 차이는 서버 측 투영이 한 몫이다. "JSON 이 무겁다" 와 "필터가 아껴준다" 를
   * 같은 축에 놓지 않는다 — 그래야 숫자가 오해받지 않는다.
   */
  const projected = await engine.run("ls", {
    args: ["-la", dir],
    select: ["name", "size_bytes"],
    limit: 50,
  });

  const fullTok     = countJsonTokens(JSON.stringify(out.stdout.parsed), TOKENIZER);
  const projectedTok = countJsonTokens(JSON.stringify(projected.stdout.parsed), TOKENIZER);
  const savedPct    = (1 - projectedTok / fullTok) * 100;

  console.log(`\n  투영(select name,size_bytes + limit 50)`);
  console.log(`  투영 전 토큰   ${fullTok}`);
  console.log(`  투영 후 토큰   ${projectedTok}`);
  console.log(`  줄어든 비율    ${savedPct.toFixed(1)}%`);

  console.log("\n  읽는 법:");
  console.log("  - 이건 **측정치**다. 문장이 아니라 위 스크립트의 결과다.");
  console.log("  - 토크나이저를 바꾸면 값이 달라진다. 다른 출처의 수치와 섞지 않는다.");
  console.log("  - **재현하지 못한 수치를 문서에 남기지 않는다.** 못 쟀으면 못 쟀다고 쓴다.");
  console.log("  - 투영 수치는 `--entries=500` 으로 돌려야 README 의 97.6% 와 같은 입력이 된다.");

} finally {
  await rm(dir, { recursive: true, force: true });
  console.log(`\n  (${Date.now() - started}ms)`);
}
