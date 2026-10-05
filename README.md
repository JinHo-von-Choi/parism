# Parism

> Refract the Shell. Every command, structured.
>
> AI 에이전트를 위한 안전하고 예측 가능한 OS 실행 게이트웨이.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

> 문서: [README](README.md) · [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

설계 결정과 모듈 구조의 상세: [SPECIFICATION.md](SPECIFICATION.md)

---

## 무엇인가

셸 명령을 실행해 **구조화된 데이터**로 돌려주는 실행 게이트웨이입니다.

```console
$ parism run "ls -la src"
```

```json
{
  "ok": true,
  "stdout": {
    "raw": "drwxr-xr-x  2 user group 4096 Mar 06 09:23 src\n",
    "parsed": {
      "entries": [
        {
          "type": "directory",
          "name": "src",
          "permissions": { "owner": "rwx", "group": "r-x", "other": "r-x" },
          "size_bytes": 4096,
          "owner": "user",
          "group": "group",
          "modified_at": "2026-03-06T09:23:00"
        }
      ]
    }
  }
}
```

`raw` 는 항상 그대로 남습니다. `parsed` 는 보너스이고, `raw` 는 보험입니다.
파서가 없는 명령이어도 `raw` 로 원본을 그대로 받을 수 있습니다.

43종 내장 파서를 지원하고, 직접 파서를 추가할 수도 있습니다.

---

## 왜 필요한가

셸은 사람이 읽으려고 만들어졌습니다. 에이전트는 사람이 아닙니다.

`ls -la` 는 파일시스템의 구조화된 정보를 사람이 읽기 좋은 한 줄 텍스트로 펽팽 눌러서 냅니다. 에이전트는 그 텍스트를 다시 구조로 되돌려야 합니다. 공백으로 나눠 첫 열이 권한이고 셋째가 소유자이며 파일명이 어디서 시작하는지까지 토큰을 태우며 추론하는 일입니다. 그리고 자주 틀립니다.

틀리기 쉬운 지점은 분명합니다.

- 파일명에 공백이 있으면 구분 위치를 놓칩니다.
- `ps` 는 Linux와 macOS에서 열 순서가 다릅니다.
- `df -h` 의 `1K-blocks` 헤더가 환경에 따라 다르게 나옵니다.
- macOS `stat` 은 레이블이 없는 한 줄이라 Linux 패턴으로 아무것도 못 얻습니다.
- 파일명에 이모지나 개행 문자가 있으면 UTF-16 코드 단위와 바이트가 어긋납니다.

한 번 틀리면 에이전트는 존재하지 않는 경로에 쓰고, 오류를 되짚느라 재시도하고, 또 틀립니다. 재시도는 다시 토큰입니다.

Parism은 이 해독 단계를 없앱니다. OS를 감지해 맞는 파서를 고르고, 결과를 구조로 냅니다.

---

## 무엇이 달라지는가

**값에 근거가 붙습니다.** `ps` 와 `git status --porcelain` 결과는 각 필드가 원문의 어느 바이트에서 왔는지 함께 돌려줍니다.

```json
"evidence": {
  "/processes/0/command": [{ "source": "stdout", "start": 118, "end": 131, "transform": "trim" }]
}
```

값을 고른 뒤 `explain_result` 로 원문 구간을 다시 열 수 있습니다. 근거가 없는 필드는 `source_kind: "none"` 으로 **"근거 없음"** 이라고 말합니다. 없는 근거를 지어내지 않습니다.

**큰 결과는 잘린 이유를 설명합니다.** 토큰 예산을 걸면 무엇을 몇 개 버렸는지, 왜 버렸는지, 다음 페이지는 어디인지가 함께 나옵니다. 조용히 줄어들지 않습니다.

```json
"budget": { "max_tokens": 2000, "measured_tokens": 1842, "budget_met": true },
"omission": [{ "stage": "budget", "rows_total": 206, "rows_returned": 138, "rows_omitted": 68 }]
```

**같은 결과 두 개를 비교할 수 있습니다.** `compare_results` 는 두 결과가 비교 가능한지 먼저 말하고, 가능하면 바뀐 필드와 그 근거를 짝지어 냅니다. 비교 불가능하면 거절 사유를 냅니다.

```json
{ "comparable": false, "refusals": { "reasons": ["different command"] } }
```

**재실행은 일어나지 않습니다.** 이어 읽기와 결과 조회는 모두 보관된 결과에서만 나옵니다. 모르는 id, 만료, 퇴출, 처음부터 보관하지 않음은 서로 다른 거절 사유로 구분됩니다.

**실행은 게이트를 지나갑니다.** 허용 목록에 없는 명령은 실행되지 않습니다. 허용 경로 밖에서는 실행되지 않습니다. 출력의 시크릿은 기본으로 가려집니다. 설정은 아래 [가드](#가드) 절에 있습니다.

---

## 실행 환경에 대해

한 가지는 분명히 말합니다. **JSON 은 raw 텍스트보다 무겁습니다.** 키 이름이 항목마다 반복되기 때문입니다.

`ls -la` 출력이 200행이면 raw 5,044 토큰, JSON 12,204 토큰입니다. 500행이면 raw 12,545, JSON 30,122 입니다. `node experiments/token-cost.mjs --entries=200` (기본값)과 `--entries=500` 로 그대로 재볼 수 있습니다.

그래서 예산을 쓰는 쪽이 맞습니다. 한 번 조회하고 끝나는 일이라면 원문 없이 필요한 필드만 받는 편이 이득이고, 결과를 근거와 함께 다시 열어보아야 하는 일이라면 구조가 값을 지킵니다. Parism이 토큰을 아끼는 도구가 아니라 **해독 비용을 없애는 도구**라는 점이 중요합니다.

오독률이나 재시도 감소량을 몇 퍼센트 아꼈다는 수치는 이 저장소에서 측정하지 않았습니다. 재현할 수 없는 수치는 쓰지 않습니다.

---

## 60초 데모

`experiments/demo-60s.mjs` 가 그대로 만드는 내용입니다. `npm run build && node experiments/demo-60s.mjs` 로 재현됩니다(고정 시드).

**200행 목록에 예산을 건 경우**

```
목록 200행 중 87행 표시
예산 생략 119행
측정 18355 / 20000 토큰 (parism/approx, exact=false)
파싱 오류 0건
누락 내역: ["budget"]
  budget: reason=119 of 206 row(s) were left out to fit 14611 tokens
          total=206 returned=87 omitted=119
```

**고른 값의 원문 구간**

```
고른 값: docs (directory, 4096 바이트)
ls 필드 근거: "none"

--- 근거가 있는 파서(git status --porcelain)로 같은 장면 ---
  고른 값   "changed.ts" ( M)
  원문 구간 byte[3, 13) = "changed.ts"
  성격      verbatim
  마스킹    가려지지 않음
```

`ls` 에는 필드 근거가 없어 `source_kind: "none"` 이라고 말합니다. `ps` 와 `git status --porcelain` 은 바이트 구간을 줍니다.

**나머지는 명령을 다시 실행하지 않고**

```
이어 읽기 1회 후 206행 확보 (중복 없음: true)

모르는 id: ok=false reason=unknown_id
보관 안 함: retained=false explain=not_retained
```

두 사유는 무엇을 해야 하는지가 다르기 때문에 구분합니다. **어느 쪽이든 자동으로 재실행하지 않습니다.**

**숫자 하나.** 같은 87행을 원문까지 받으면 18,355 토큰, 원문 없이 필수 필드만 받으면 1,266 토큰입니다. 차이는 raw 원문입니다. 2,000 토큰으로는 실측 0행이 나옵니다(행이 아니라 원문만으로 상한을 넘기 때문) — 그때도 조용히 넘기지 않고 이유를 밝힙니다. 같은 목록을 20,000 토큰으로 부르면 138행이 나옵니다.

---

## 가드 — 에이전트를 신뢰하지 않는 이유

`rm -rf /`는 세 개의 문자로 쓸 수 있다.

에이전트는 오류를 범한다. 문맥을 잃고, 경로를 착각하고, 의도하지 않은 명령을 만들어 낸다. Guard는 그 실수가 그대로 실행되지 않게 막는 장치다.

네 겹의 방어선이 있다.

**화이트리스트**: `allowed_commands`에 없는 명령어는 실행되지 않는다. 프로세스를 만들지도 않는다. 설명 없이 거절한다.

**경로 제한**: `allowed_paths` 를 설정하면 `cwd` 와 경로 인자를 검사한다. 모든 명령에서 경로처럼 보이는 값(`/` 를 포함하거나 `.` `~` 로 시작하는 값, `cwd` 기준으로 실제 존재하는 항목 — 심볼릭 링크 포함)을 검사하고, 경로를 받는 명령(`cat subdir/file`, `find src` 같은)은 위치 인자와 경로 플래그 값을 항상 검사한다. 허용 경로 밖이면 차단된다. 커널 수준 샌드박스는 아니고 가드 수준의 방어선이다.

**인젝션 패턴 차단**: 각 인자를 개별적으로 순회하며 `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, `<`가 포함되면 실행하지 않는다. 인자 단위 검사이므로 서로 다른 인자 경계를 넘어서는 오탐이 발생하지 않는다.

**명령별 인자 제한**: 명령마다 차단할 플래그를 지정할 수 있다. `node -e`, `node --eval`, `node --input-type`은 기본 차단된다. `npx --yes`도 기본 차단된다.

차단된 명령은 이런 응답을 반환한다.

```json
{
  "ok": false,
  "guard_error": {
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  },
  "failure": {
    "kind": "guard",
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

`failure` 이 권위 필드다. `guard_error` 도 하위 호환을 위해 유지되지만, `result.failure.kind` 로 분기하면 된다.

에이전트는 실행 결과와 동일한 구조로 차단 이유를 받는다. 예외가 터지지 않는다. 파이프라인이 깨지지 않는다.

Guard의 위협 모델, 4겹 방어선의 한계, 신뢰할 수 없는 환경에서의 격리 권고는 [SECURITY.md](SECURITY.md)를 참조한다.

---

## 명령어 지원

43종 명령어에 기본 파서가 있다. 각 명령이 돌려주는 필드는 `describe({ cmd: "…" })` 로 확인한다.

| 카테고리 | 명령어 | 기본 허용 |
|---|---|---|
| 파일시스템 | `ls -l` `find` `stat` `du` `df` `tree` | O |
| 프로세스 | `ps aux` | O |
| 네트워크 | `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | O |
| 텍스트 | `grep -n` `wc` `head` `tail` `cat` | O |
| Git | `git status` `git log --oneline` `git diff` `git branch -vv` | O |
| 배포 | `kubectl get` `docker` `gh pr list` `helm list` | O |
| 환경 | `env` `pwd` `which` | O |
| 시스템 | `free` `uname` `id` `systemctl list-units` `journalctl` `apt list` `apt search` `brew list --versions` | O |
| 패키지 | `npm list` | O |
| 패키지 | `pnpm list` `yarn list` | 명시적 허용 (`yarn` 은 build 프로필도 필요) |
| 빌드 | `terraform plan` `cargo tree` | build 프로필 |
| 프로세스 제어 | `kill` | 명시적 허용 |
| Windows | `dir` `tasklist` `ipconfig` `systeminfo` | 명시적 허용 |

**명시적 허용** 은 `guard.allowed_commands` 에 직접 넣어야 한다는 뜻이다. **build 프로필** 을 요구하는 명령은 `guard.profile` 을 `"build"` 로 바꿔야 한다. `cargo` 의 조회 서브커맨드(`tree` `metadata` `search` `pkgid`)가 build 프로필에만 있는 이유는 저장소가 지정한 rustc 래퍼를 실행할 수 있고, `yarn` 이 그래야 하는 이유는 저장소가 지정한 `yarnPath` 스크립트를 실행하기 때문이다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 켠다.

**파서가 없는 명령어는 `stdout.parsed` 가 `null` 이고 `raw` 는 그대로 온다.** 실패가 아니다. 파서 버그와 구분하려고 `stdout.parse_error` 를 따로 둔다 — 파서가 예외를 던졌을 때만 채워진다.

| `parse_error.reason` | 뜻 |
|---|---|
| `parser_exception` | 파서가 예외를 던졌다 |
| `schema_violation` | `strict_schemas` 에 걸렸다 |
| `unsupported_format` | 파서가 그 인자의 출력 형식을 다루지 않는다 |
| `unrecognized_output` | 데이터 줄이 있지만 어떤 값도 읽지 못했다 |

명령이 실행되지 못한 경우는 `result.failure` 에 남고(`kind: "exec"`, stderr 를 담은 메시지), 파싱 실패는 `stdout.parse_error` 에만 남는다. 파서가 아예 없는 경우는 `result.failure.reason === "parser_not_found"` 다(`kind: "parse"`).

### 형식 밖 인자

각 파서는 실제로 확인한 인자 범위(허용 플래그, 위치 인자 규칙, 서브커맨드)를 계약으로 선언한다. 범위 밖의 인자를 주면 파서를 아예 실행하지 않고 `unsupported_format` 을 돌려준다. 틀린 값을 조용히 해석하는 것보다 실패를 드러내는 편이 낫기 때문이다. `raw` 는 그대로이고, 출력이 JSON 문서라면 네이티브 JSON 패스스루가 `parsed` 를 채운다.

같은 정보를 얻는 인자가 있으면 함께 알려준다.

```json
{ "reason": "unsupported_format", "hint": { "args": ["log", "--format=%h %s"] } }
```

`uname -r` → `["-a"]` · `git status -s --ignored` → `["status", "--ignored"]` · `kubectl get pods -o yaml` → `["get", "pods", "-o", "json"]`. 전체 목록은 [SPECIFICATION.md](SPECIFICATION.md) §3.2.

### JSON 은 기본 파서가 있다

명령의 출력 자체가 JSON 이면(`kubectl get pods -o json`, `docker inspect`) 파서를 거치지 않고 `parsed` 에 들어간다. 가드 검사와 봉투 래핑은 똑같이 적용된다. 별도 설정이 없다.

---

## 설치

```bash
npx @nerdvana/parism
```

로컬에서 빌드해 쓰려면:

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

---

## 라이브러리 모드

MCP 서버 없이 Node.js 안에서 직접 부를 수 있다.

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine();
const result = await engine.run("ls", { args: ["-la"] });
console.log(result.stdout.parsed);
```

`createEngine()` 은 `prism.config.json` 을 로드하고 등록된 외부 파서를 붙인 뒤 `ParismEngine` 을 돌려준다. 다른 설정 파일을 쓰려면 `createEngine({ configPath: "…" })`.

실행 옵션: `args` / `cwd` / `format` / `includeDiff` / `select` / `where` / `sort_by` / `limit` / `array`, 페이지 단위는 `page` / `page_size`. `engine.describe("git")` 로 한 명령의 능력 요약을 볼 수 있다.

설계 상세는 [SPECIFICATION.md](SPECIFICATION.md) §1.1.

---

## MCP 클라이언트 설정

MCP stdio 프로토콜로 AI CLI/IDE 에 연결한다. 클라이언트별 설정 파일은 `docs/mcp-clients/` 에 있다.

| 클라이언트 | 설정 파일 |
|---|---|
| Claude Desktop | [claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

인자 없이 `parism` 을 실행하면 MCP 서버로 동작한다. 연결되면 일곱 개 도구가 노출되고, 처음 쓰는 에이전트는 `describe` 로 환경과 제한을 파악한 뒤 `dry_run` 으로 가드 통과 여부를 확인하고 `run` 을 호출한다.

---

## 도구

| 도구 | 새 명령 실행 | 언제 쓰나 |
|---|---|---|
| `run` | O | 기본. 예산·근거·필터 옵션 포함 |
| `run_paged` | O | 출력이 클 때 페이지 단위 |
| `explain_result` | **X** | 값이 원문 어디서 나왔는지 (보관본만) |
| `fetch_result` | **X** | 예산으로 잘린 결과를 이어 읽기 |
| `compare_results` | **X** | 전후 차이 보기 (두 보관본만) |
| `describe` | X | 처음 쓸 때 환경 파악 |
| `dry_run` | X | 실행 전 가드 확인 |

`explain_result` · `fetch_result` · `compare_results` 는 **어떤 경우에도 명령을 다시 실행하지 않는다.** 모르는 id·만료·퇴출이면 그것을 알리고 끝낸다. 보관본은 세션 메모리에만 있고 디스크에 남지 않는다(결과당 2MiB, 합계 32MiB, 16개, 60초 TTL).

### run

모든 명령의 기본 도구다. 출력이 작거나 구조화 파싱이 필요할 때 쓴다.

| 파라미터 | 기본값 | 뜻 |
|---|---|---|
| `cmd` | — | 명령어 이름 |
| `args` | `[]` | 인자 배열 |
| `cwd` | 현재 디렉토리 | 작업 디렉토리 |
| `format` | `"json"` | `"json"` · `"compact"` · `"json-no-raw"` |
| `includeDiff` | `false` | 파일시스템 diff 포함. 자주 호출할 MCP 세션에서는 `false` 유지 |
| `contract_version` | `"stable"` | `"next"` 면 `review` 가 붙는다 |
| `evidence` | `"none"` | `"rows"` · `"fields"`. 필드별 근거 계산 |
| `retain` | `false` | 결과를 세션 메모리에 보관해 나중에 다시 본다 |
| `budget` | — | 아래 "토큰 예산" |
| `select` `where` `sort_by` `limit` `array` | — | 아래 "투영과 필터" |

`contract_version` · `evidence` · `retain` · `budget` 네 개는 **전부 opt-in** 이다. 지정하지 않으면 응답이 이전과 완전히 같다.

`format: "compact"` 는 리스트형 출력을 `schema` + `rows` 로 압축해 토큰 비용을 줄인다.

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

#### 투영과 필터

`select`(필드 목록) · `where`(조건 목록) · `sort_by`(`{ field, order }`) · `limit`(행 수)은 파싱 결과의 최상위 배열(`ls` 의 `entries`, `git log` 의 `commits` 등)에만 적용한다. 순서는 `where` → `sort_by` → `limit` → `select` 이고, 배열이 여럿이면 `array` 로 고른다.

```json
{
  "cmd": "ls", "args": ["-l"],
  "where":   [{ "field": "type", "op": "eq", "value": "file" },
              { "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" },
  "limit":   10,
  "select":  ["name", "size_bytes"]
}
```

- 조건 연산: `eq` `ne` `prefix` `contains` (문자열·수·불리언·`null`), `gt` `gte` `lt` `lte` (수). 조건은 모두 맞아야 한다.
- 결과에 `_summary: { total, matched, shown }` 이 붙고 `stdout.raw` 는 실리지 않는다. 결과 객체 안의 배열이면 `parsed._summary`, 결과가 배열이면 `stdout._summary` 다.
- 정렬은 안정 정렬이며 값이 없는 행은 뒤에 둔다. `format: "compact"` 와 함께 쓸 수 있다.
- 없는 필드나 형이 맞지 않는 비교는 `failure.kind = "config"`(`unknown_field`, `type_mismatch`)이며 raw 를 남긴다. 문법이 틀린 인자는 실행하지 않는다.
- 항목 500개짜리 디렉터리의 `ls -l` 에 `select: ["name","size_bytes"], limit: 50` 을 주면 파싱 결과의 토큰이 97.6% 줄어든다(30,122 → 725, `parism/approx`). `node experiments/token-cost.mjs --entries=500` 로 재볼 수 있다.

### run_paged

대용량 출력을 페이지 단위로 읽는다. `ps aux` `find` `grep -r` 등에 쓴다.

- `cmd` `args` `cwd` `includeDiff` — `run` 과 동일
- `page` — 0-indexed 페이지 번호 (기본 `0`)
- `page_size` — 페이지당 줄 수 (기본 100). 상한은 `max_page_size`(기본 1000)이고, 넘는 요청은 그 값으로 줄인 뒤 요청값을 `page_info.requested_page_size` 에 남긴다.

응답에는 `page_info.total_lines` · `page_info.has_next` · `page_info.cache`(`{ hit, age_ms }`, 30초 안에서 첫 실행 결과를 재사용) 가 붙는다. 부분 출력은 구조화할 수 없으므로 `stdout.parsed` 는 항상 `null` 이다.

```
1. run_paged(cmd, page=0) → page_info.total_lines 로 전체 규모를 본다
2. 작으면 그대로 쓴다
3. 크면 grep 으로 먼저 좁힌 뒤 run 을 쓴다
4. 필요한 페이지만 run_paged(page=N) 으로 더 받는다
```

### describe

에이전트 온보딩 도구다. 현재 환경의 허용 명령, 사용 가능 파서, 가드 제한, 버전을 돌려준다.

인자 없이 호출하면 `version` · `allowed_commands` · `available_parsers` · `guard_summary`(`timeout_ms`, `max_output_bytes`, `max_items`, `block_patterns`, `allowed_paths`) · `telemetry_enabled` 이 온다. 텔레메트리를 켠 경우에만 `stats`(명령별 결과 횟수)가 붙는다.

`describe({ cmd: "git" })` 는 한 명령의 정보를 2KB 이하로 돌려준다.

- `policy` — 가드가 허용하는 서브커맨드·플래그·위치 인자 규칙과 정책 출처(`origin`: `default`, `build`, `config`, `none`)
- `parser` — 파서가 다루는 형식. `requires`, `values`, `flags`, `rows_key`, `row_fields`
- `alternatives` — 형식 밖 인자를 대신할 인자(`{ from, args, reason }`)
- `examples` — 현재 가드를 통과하는 예시 인자

허용되지 않은 명령은 `failure`(`command_not_allowed`)를 담은 결과로 온다.

### dry_run

가드를 미리 통과할지 확인한다. 명령을 실행하지 않는다.

`cmd` `args` `cwd` 를 받고 `would_pass` · 차단 사유(`command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`) · 상세 메시지를 돌려준다.

```json
{ "would_pass": false, "reason": "command_not_allowed", "message": "Command 'rm' is not in the allowed list" }
```

### 근거 조회 — `run` + `explain_result`

**"이 값이 원문 어디에서 나왔나"를 바이트 구간으로 답한다.** 새 명령을 실행하지 않는다.

`contract_version: "next"` 로 `review` 를 받고, `retain: true` 로 보관해 두면 `explain_result` 로 다시 본다. `evidence` 를 `"rows"` 나 `"fields"` 로 주면 필드별 근거까지 계산한다.

`review` 는 기존 봉투 필드의 뜻을 바꾸지 않고 옆에 붙는다.

| 필드 | 뜻 |
|---|---|
| `result_id` | `explain_result` · `compare_results` · `fetch_result` 에 넘기는 id |
| `parser_id` / `parser_version` / `schema_version` | 이 결과를 만든 파서와 스키마 |
| `content_hash` | 원문 해시. 같은 실행을 반복했는지 판별 |
| `source_complete` | 수집이 끝났는가 (`parse_complete` 는 파싱이 끝났는가, `representation_lossless` 는 압축·변환이 값을 잃지 않았는가) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | `explain_result` 로 다시 볼 수 있는가 |
| `warnings` | 왜 불완전하거나 근거가 없는지 |

**완성도는 `true` / `false` / `unknown` 세 값이다.** 확인하지 못한 것을 거짓으로 말하지 않기 위해 `unknown` 을 쓴다. 수집 상한에 걸리면 `source_complete: false` 이고 `warnings` 에 그 사실이 적힌다.

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived",
  "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- 구간은 **마스킹된 정규 원문의 UTF-8 바이트 오프셋** `[start, end)` 다. 파서가 값을 변환했다면 `derived` 로 밝히고 그 변환을 함께 준다.
- **근거는 그 순간 명령이 무엇을 출력했는지에 대한 링크다. 값이 참이라는 증명이 아니다.**
- 모르는 포인터는 `unknown_pointer`, 만료·퇴출된 id 는 그 사실과 함께 실패한다. **자동으로 재실행하지 않는다.**

근거를 만드는 파서는 `ps` 와 `git status --porcelain` 뿐이다. 나머지는 근거가 없다는 사실을 `warnings` 로 알린다.

근거를 계산하면 결과 구조가 바뀌어 근거 포인터와 필수 필드 계산 대상이 지워진다. 그래서 **`evidence` 나 `budget` 을 쓰면 적응형 compact 가 꺼진다.** `format: "compact"` 를 명시하면 그대로 압축하고 이유를 `warnings` 에 적는다.

### 토큰 예산 — `run(budget)` + `fetch_result`

**큰 결과를 예산 안에 받으면서 무엇이 빠졌는지 알 수 있다.** 핵심은 "예산 때문에 사라진 정보"와 "파서 오류 때문에 사라진 정보"를 섞지 않는 것이다.

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

- **예산은 실행시간이나 수집량을 줄이는 기능이 아니다.** 이미 얻은 결과를 어디까지 내보낼지 정한다.
- `required_fields` 는 어떤 행에서도 빠지지 않는다. 파서가 선언한 행 identity 도 남는다. **필수 필드를 예산 안에서 지킬 수 없으면 조용히 일부만 내보내지 않고 명시적으로 실패한다** — 부분 성공은 조용한 손실이다.
- 예산이 최소 봉투(약 1,200 토큰)에 못 미치면 **실행 전에** `budget_too_small` 로 거절한다.

응답에 `budget` 보고와 `omission` 목록이 붙는다.

- `budget` — `requested`, `measured_tokens`, `tokenizer_id`, `tokenizer_version`, `budget_met`, `tokenizer_exact`, `tokenizer_scope`
- `omission[]` — `stage`(`capture`/`parse`/`projection`/`budget`/`privacy`)와 `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `next_cursor`

**고정 토크나이저**는 `parism/approx`(근사)와 `byte`(문자 단위 정확) 둘이며 새 런타임 의존성이 없다. 미지원 토크나이저는 조용히 대체하지 않고 `tokenizer_unsupported` 로 거절한다. 이 약속은 parism JSON payload 에만 성립하고 **전송·클라이언트·모델 내부 토큰은 포함하지 않는다**(`tokenizer_scope` 에 밝힌다).

`fetch_result(result_id, cursor, budget)` 는 저장된 같은 결과의 다음 페이지를 **재실행 없이** 돌려준다. `continuation.cursor` 를 그대로 넘긴다. cursor 는 진행 규칙(스냅샷 identity·투영·정책·스키마)과 위치를 함께 묶으므로 **클라이언트가 임의 오프셋을 조립할 수 없다.** 다른 결과의 cursor 는 `cursor_mismatch`, 조작한 cursor 는 `cursor_invalid` 로 거절한다.

```
1. run(cmd, { budget: { max_tokens: 2000, overflow: "page" }, retain: true })
2. budget.budget_met 과 omission 으로 무엇이 빠졌는지 확인한다
3. continuation.cursor 가 있으면 fetch_result(result_id, cursor) 를 반복한다
4. 다 읽을 때까지 가거나, omission 이 남았다면 그 사실을 사용자에게 알린다
```

### 의미 diff — `compare_results`

**이미 존재하는 두 결과만 비교한다.** 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다.

`base_id` · `current_id`(`run(retain: true)` 의 `review.result_id`), 선택으로 `keys` · `ignore_fields` · `strict` 를 받는다. 응답은 `comparable` · `refusals` · `added`/`removed`/`changed`/`unchanged_count` · `ignored_fields` · `partial` · `key_conflicts` 이고, 필드 변화에는 이전·현재 근거 포인터가 붙는다.

**거짓 삭제 0** — 어느 한쪽이라도 불완전하면(수집 잘림·파서 실패·표현 손실) 없는 행을 '삭제'로 단정하지 않고 `partial.withheld_reasons` 에 보류를 남긴다. identity 를 확정하지 못한 행이 있어도 '추가'나 '삭제'를 단정하지 않는다 — 못 찾았다고 새로 생긴 것이 아니다. 중복 identity 는 조용히 한 행을 버리지 않고 `duplicate_identity` 로 멈춘다.

- 행 identity 규칙: git 은 저장소 identity(실경로) + 정규 경로. kubernetes 는 context/namespace/kind + `metadata.uid` 이며 **uid 없는 표 출력으로는 같은 자원이라고 말하지 않는다.** **ps 는 PID 만을 identity 로 삼지 않고 비교를 보류한다**(PID 재사용).
- **지문은 세계 상태를 캡처한 인증서가 아니다.** 같은 지문이어도 그 사이 파일이 바뀌었을 수 있다.
- 비밀 유출 방지: **argv 는 해시로 식별하고 표시에는 마스킹한 값만** 쓴다. **환경 변수는 '이름'만 관찰 기록에 남기고 값은 담지 않는다.**

---

## 마이그레이션 — 2.0.2 → 2.1.0

2.1.0 은 **기존 봉투 필드의 의미를 바꾸지 않는다.** `contract_version` 의 기본값이 `"stable"` 이라 인자를 추가하지 않은 기존 소비자는 응답이 이전과 완전히 같다. 새 기능을 쓰려면 opt-in 인자를 명시해야 한다.

**하지만 아래 다섯 건은 파일 수정이 필요합니다.** MCP 를 거치지 않고 이 API 를 직접 쓰는 코드에 해당합니다. `run` 만 호출하는 소비자는 영향이 없습니다.

| 대상 | 이전 | 지금 |
|---|---|---|
| 외부 ParserPack 작성자 | `contract.noise` / `rowLine` / `acceptedValues` 가 메인 스레드의 `RegExp` | 워커가 계산한 서술자와 `facts`. 메인 스레드에서 `RegExp` 가 아니다 |
| `toCompact()` / `parism inspect` 호출자 | `unknown` 반환 | `CompactOutcome`(`{ok:true,value}` \| `{ok:false,reason,message}`) |
| `guard.secrets.output_patterns` 를 생략한 설정 | 기본 패턴 7개를 적용하지 않음 | 기본 패턴을 쓴다. 비활성으로 두려면 `output_patterns: []` 을 명시 |
| `git status --porcelain` 을 쓰는 소비자 | `failure.hint` 의 '대안 형식 안내' 대상 | 지원 형식. `entries` 행 배열 |
| porcelain 항목을 통째로 직렬화해 저장한 코드 | `xy`/`index`/`worktree`/`path`/`orig_path` | 같은 필드에 `quoted` 추가(줄 모드에서만 채워짐). 경로 값의 뜻은 두 모드에서 같다 |

앞의 두 줄은 되돌릴 수 없다. `toCompact()` 는 `representation_not_lossless` 를 처리해야 하고, ParserPack 작성자는 전역 설정에 `parsers.external_isolation: "none"` 을 두면 이전처럼 메인 스레드에서 실행된다.

**`output_patterns` 기본값 변경은 보안 관련이다.** 이전에는 키를 생략해도 기본 패턴이 비활성이라, 리댁션을 켠 상태에서 합성 비밀 5종(sk-, ghp_, AKIA, xoxb-, glpat-)이 그대로 반환됐다.

**바꿀 필요 없는 것**

- MCP 클라이언트 설정 — 도구 이름이 안 바뀌었다. 세 도구가 추가됐을 뿐이다.
- 기존 `run` 호출 — 새 인자를 주지 않으면 응답이 이전과 같다.
- 내부 파서의 응답 — `git status --porcelain` 을 제외하고 그대로다.

---

## 설정

`prism.config.json` 을 프로젝트 루트에 두면 가드 동작을 제어한다.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps"],
    "allowed_paths": ["/home/user/projects"],
    "timeout_ms": 10000,
    "max_output_bytes": 102400,
    "max_items": 500,
    "default_page_size": 100,
    "block_patterns": [";", "$(", "`", "&&", "||", ">", ">>", "<", "|"],
    "command_arg_restrictions": {
      "node": { "blocked_flags": ["-e", "--eval", "-r", "--require", "-p", "--print", "--input-type"] },
      "npx":  { "blocked_flags": ["--yes", "-y"] }
    },
    "secrets": {
      "env_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"],
      "output_patterns": ["Bearer [A-Za-z0-9._\\-]+", "ghp_[A-Za-z0-9]+"],
      "output_redaction_enabled": false
    }
  },
  "parsers": {
    "strict_schemas": false,
    "external_isolation": "worker",
    "external_time_limit_ms": 500,
    "external_memory_limit_mb": 128
  },
  "telemetry": {
    "enabled": false
  }
}
```

- `allowed_paths` 가 비어 있으면 경로 제한 없이 실행된다. 판단은 당신 몫이다.
- `guard.secrets.env_patterns` 에 걸리는 환경 변수는 실행 전 자식 프로세스에서 제거된다. `env` 명령을 실행해도 노출되지 않는다.
- `guard.secrets.output_redaction_enabled` 는 기본 `false` 다. `true` 로 두면 `output_patterns` 에 걸리는 문자열을 raw 출력에서 `[REDACTED]` 로 바꾼다. 파싱 전에 적용되므로 `stdout.parsed` 에는 영향이 없다.
- `command_arg_restrictions` 는 기본값과 병합된다. 일부 명령만 override 해도 나머지 기본 제한은 유지된다.
- `parsers.strict_schemas` 를 `true` 로 두면 각 파서의 Zod 스키마로 파싱 결과를 검증하고, 위반 시 `failure.reason === "schema_violation"` 을 반환한다. 기본 `false` 다.
- `telemetry.enabled` 를 `true` 로 두면 응답 봉투에 `telemetry` 필드가 붙는다. 단계별 소요 시간(ms)과 raw 출력 바이트 수이며, 켜면 명령별 결과 횟수도 모아 `describe` 의 `stats` 로 보여 준다. 외부로 보내거나 저장하지 않는다.

`guard.profile` 은 기본 `"readonly"` 이며 조회 서브커맨드만 허용한다. `"build"` 로 바꾸면 `npm run` `npm test` `cargo build` `terraform plan` `docker compose ps` 같은 빌드·시험 서브커맨드가 추가된다. **프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 켠다.** `node` `npx` `yarn` 은 `allowed_commands` 에 직접 추가해야 하고 `build` 프로필에서만 동작하며, `npx` 에는 `--no` 가 붙는다. 명령별 세부 규칙은 `guard.command_policies` 로 덮어쓴다.

**프로젝트 `prism.config.json` 은 가드를 넓히지 못한다.** 넓히려면 전역 `~/.parism/prism.config.json` 에 `"trust_project_config": true` 를 둔다.

### 설정 레이어와 환경 변수

세 레이어를 순서대로 병합한다. 뒤 레이어가 앞 레이어를 덮어쓴다.

1. 전역 `~/.parism/prism.config.json`
2. 프로젝트 `<cwd>/prism.config.json`
3. 환경 변수 `PARISM_` 접두

MCP 서버와 라이브러리 모드(`createEngine()`) 모두 이 3레이어를 쓴다. `createEngine({ configPath })` 로 특정 파일 하나만 로드할 수도 있다.

| 환경 변수 | 대상 설정 | 형식 |
|---|---|---|
| `PARISM_ALLOWED_COMMANDS` | `guard.allowed_commands` | 쉼표 구분 목록 |
| `PARISM_ALLOWED_PATHS` | `guard.allowed_paths` | 쉼표 구분 목록 |
| `PARISM_TIMEOUT_MS` | `guard.timeout_ms` | 정수 |
| `PARISM_MAX_OUTPUT_BYTES` | `guard.max_output_bytes` | 정수 |
| `PARISM_MAX_ITEMS` | `guard.max_items` | 정수 |
| `PARISM_DEFAULT_PAGE_SIZE` | `guard.default_page_size` | 정수 |
| `PARISM_STRICT_SCHEMAS` | `parsers.strict_schemas` | `true` 또는 `1` |
| `PARISM_ADAPTIVE_FORMAT_JSON` | `parsers.adaptive_format_threshold.json` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_COMPACT` | `parsers.adaptive_format_threshold.compact` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_JSON_NO_RAW` | `parsers.adaptive_format_threshold.json_no_raw` | 정수 |
| `PARISM_TELEMETRY_ENABLED` | `telemetry.enabled` | `true` 또는 `1` |

---

## 커스텀 파서

43개로 부족하면 직접 만든다. 스캐폴드가 컴파일되려면 두 가지가 먼저 필요하다.

```bash
npm install @nerdvana/parism zod@^3
# package.json 에 { "type": "module" } — parism 은 ESM 전용이고 ParserPack.schema 가 zod 3 타입이다
```

```bash
parism capture "htop -b -n 1"   # 1. 명령어 출력을 캡처한다
parism init-parser htop          # 2. 파서 팩 스캐폴드를 생성한다

# 3. 캡처한 fixture 에 사람이 검토한 기대값을 직접 적는다 — 기계가 채워 넣지 않는다
#    { "expected": { "parsed": { … }, "reviewed_by": "이름", "note": "왜 이 값이 맞는지" } }

parism test ~/.parism/fixtures   # 3-1. 되짚는다 — 달라진 경로가 목록으로 나온다
parism add ./htop                # 4. 등록한다 — 재시작 없이 즉시 쓸 수 있다
parism inspect "htop -b -n 1"    # 5. raw/parsed/compact 를 나란히 보고 토큰 수를 잰다
```

등록한 팩은 `~/.parism/parsers/` 에 저장되고 MCP 서버 시작 시 자동으로 로드된다.

### 인자를 넘기는 두 가지 방법

| 호출 | 처리 | 따옴표·공백 |
|---|---|---|
| `parism inspect ls -l /path` | argv 모드 — 준 그대로 넘긴다 | 보존된다 |
| `parism inspect "ls -l /path"` | 문자열 모드 — 공백으로 나눈다 | 보존되지 않는다 |

문자열 모드에서 `parism inspect 'echo "hello   world"'` 를 주면 따옴표가 문자 그대로 자식에게 전달된다. 그래서 문자열 모드는 호출할 때 경고로 먼저 말한다. 정확히 넘기려면 인자를 따로 준다.

### `parism eval` — 판정을 세 층으로 나눈다

이 호스트에서 명령을 실제로 돌려 **기대를 어겼는지** 확인한다. 성공률을 하나로 세지 않는다. 아래 세 가지는 원인이 다르므로 따로 본다.

| 층 | 무엇을 보는가 |
|---|---|
| `execution` | 명령이 **실제로 실행되었는가.** 가드 거절과 실행 실패를 구분한다 |
| `parse` | 구조로 읽었는가 · **파서가 없는 것** · 명시적 파싱 실패를 구분한다 |
| `task` | 자기 과제를 해냈는가. **없는 것을 찾는 과제는 실패해야 성공이다** |

가드가 막으면 `execution: blocked` 로 따로 나온다. **파서가 없는 명령은 실패가 아니다** — parism 이 모르는 형식이라는 사실이지 오류가 아니다. **지원하지 않는 형식은 명시적으로 실패한다** — 빈 결과를 조용히 내지 않고 가능한 대체 인자를 함께 제시한다. **기대값을 세우지 않은 항목은 비율에 넣지 않는다.**

`retry-rate` 시나리오는 "저장한 결과를 다시 실행하지 않는다"는 계약을 직접 잰다. 빈 임시 저장소에서 결과를 보관한 뒤 새 파일을 만들고, 나중에 만든 파일이 보이면 재실행이다.

```bash
parism eval                    # 전체
parism eval execution-parse    # 한 시나리오
parism eval --verbose          # 모든 항목의 관측
```

기대와 어긋난 항목이 하나라도 있으면 `exit 1` 이다.

### fixture 로 회귀를 재현하는 닫힌 고리

`parism capture` → 사람이 기대값을 적음 → `parism test` → 무엇이 어긋났는지 경로로 나온다.

```console
$ parism capture "ls -l src"
Fixture saved: /home/you/.parism/fixtures/ls-20261005-163909.json
Exit code: 0
This fixture replays but has no expected values yet.
Add expected (and reviewed_by) by hand, then run: parism test /home/you/.parism/fixtures

# ── 사람이 원문과 대조해 기대값을 적는다 ──
#   "expected": {
#     "parsed": { "entries": [ … ] },     ← 필드를 일부만 적으면 나머지가 전부 "extra" 로 보고된다
#     "reviewed_by": "이름",
#     "note": "왜 이 값이 맞는지"
#   }

$ parism test ~/.parism/fixtures
fixture 4개
  검토된 기대값 1개 중 일치 0 · 변화 1
  미검토 기대값 3개 (사람이 검토해야 계약이 된다)
  매니페스트 오류 0개

의도치 않은 계약 변화 10건 — 이걸 확인하기 전에는 배포 판정을 하지 않는다:
  ls-20261005-163909  (ls)
  [parsed] 10건
    /entries/0/name  value  기대 "WRONG" → 실제 "cli"
    /entries/2  extra  기대 undefined → 실제 { … "name":"config" … }
    …
```

**비교는 전수 대조다.** 기대값에 필드를 일부만 적으면 적지 않은 나머지가 전부 `extra` 로 보고된다 — 위 예에서 10건 중 9건이 그것이다. **기대값은 실제 파싱 결과 모양 그대로 적어야 한다.**

- **캡처는 원문을 그대로 저장하지 않는다.** 시크릿·홈 경로·`--token=` 류 인자 값을 가리고 무엇을 가렸는지 `redactions` 에 남긴다. 민감한 값은 형태를 남기고 값만 바꾼다 — 통째로 지우면 fixture 가 조립된 것처럼 보인다.
- **`reviewed_by` 가 없으면 기대값이 아니라 제안이다.** `parism test` 는 이를 계약 위반으로 세지 않는다. `parism test` 도 기대값을 **쓰지 않는다** — 자동 갱신은 회귀를 숨기는 가장 싼 방법이다.
- **되짚기는 명령을 다시 실행하지 않는다.** 저장된 stdout 만 쓴다. 다시 실행하면 그때의 환경이 섞여 "파서가 바뀌었다"와 "기계가 바뀌었다"를 구별할 수 없게 된다.
- 근거 기대는 적은 포인터만 확인한다. 전수 대조가 필요하면 `evidence.exhaustive: true`.

매니페스트 형식과 자세한 계약은 [SPECIFICATION.md](SPECIFICATION.md) §5.2.4.

### CLI 명령어

| 명령어 | 설명 |
|---|---|
| `parism capture "<command>"` | 명령어를 실행하고 정제한 출력을 fixture 매니페스트로 저장 |
| `parism init-parser <name>` | TypeScript 파서 팩 스캐폴드 생성 (parser.ts + schema.json + fixtures/) |
| `parism test [dir]` | fixture 집합을 오프라인으로 되짚고 달라진 경로를 보고 (깨진 fixture 가 있으면 exit 1) |
| `parism add <path>` | 로컬 파서 팩을 `~/.parism/parsers/` 에 영구 등록 |
| `parism inspect <command> [args...]` | raw / parsed / compact 출력 비교 + 토큰 수 |
| `parism eval [scenario]` | 이 호스트에서 기대대로 동작하는지 세 층으로 판정 |

### ParserPack 인터페이스

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* 구조화된 결과 반환 */ },
  schema: { /* Zod 스키마 */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
  acceptedFlags: { "-a": "bool", "-n": "value" }, // 선택: 출력 형식을 검증한 플래그. 그 밖은 unsupported_format
  acceptedPositionals: { max: 1 },                // 선택: 위치 인자 규칙
  supports: (args) => args.length < 4,            // 선택: 선언 뒤에 추가로 적용하는 규칙
  headerLines: 1,                                 // 선택: 데이터가 아닌 머리 줄 수
  noise: /^Total /,                               // 선택: 데이터가 아닌 줄 패턴
  rowsKey: "items",                               // 선택: 데이터 줄마다 행 하나를 담는 배열
};

export default pack;
```

### 외부 파서 격리 실행

등록한 팩은 기본적으로 팩마다 하나의 워커 스레드에서 읽고 실행한다(`parsers.external_isolation: "worker"`). 서버 스레드는 팩 모듈을 실행하지 않고 계약 선언만 받으며, `supports` 와 `hint` 같은 함수 선언은 호출할 때마다 워커에서 평가한다.

`parse()` 호출 하나(`supports`·`hint` 왕복 포함)가 `external_time_limit_ms`(기본 500ms)를 넘거나, 워커가 비정상 종료하거나, V8 힙이 `external_memory_limit_mb`(기본 128MB)를 넘으면 `parse_error.reason = "parser_exception"` 으로 보고한다. 그 뒤 대기 시간(2초에서 시작해 장애가 이어지면 두 배씩, 최대 30초) 동안은 워커를 띄우지 않고 바로 실패로 답한다. 서버는 계속 응답한다.

- `parse()` 의 반환값은 구조화 복제가 가능한 값이어야 한다. 함수·Promise·Symbol 이 든 값은 `parser_exception` 이다.
- `parse()` 는 서버 스레드의 전역 상태를 볼 수 없다. 팩 안의 `console` 과 `process.stdout.write` 출력은 stderr 로 간다.
- 힙 상한은 V8 힙만 제한한다. `Buffer` 처럼 힙 밖에 잡는 메모리는 제한하지 않는다.
- 호출마다 입력과 결과를 복제하는 비용이 든다. 20줄 입력에서 호출당 약 0.1ms, 500줄 입력에서 약 1.6ms 가 더해진다(`npm run benchmark:external`).
- 서버 스레드에서 실행하려면 전역 `~/.parism/prism.config.json` 에 `"parsers": { "external_isolation": "none" }` 을 둔다.

**워커 격리는 결함 격리이지 보안 샌드박스가 아니다.** 워커는 서버 프로세스의 권한(파일·네트워크·자식 프로세스·환경 변수)을 그대로 가진다. 직접 작성했거나 검토한 팩만 등록하고, 신뢰할 수 없는 제3자 팩은 Parism 전체를 컨테이너나 VM 안에서 실행한다. [SECURITY.md](SECURITY.md) 참조.

---

## Parism이 아닌 것

Parism은 새로운 셸이 아니다. bash를 대체하지 않는다. bash 위에 앉아서 출력을 받아 구조화할 뿐이다.

Parism은 AI를 위한 운영체제가 아니다. 관심사는 하나다. 에이전트가 명령을 내렸을 때, 에이전트가 이해할 수 있는 형태로 결과를 돌려주는 것.

Parism은 **근거를 만들어내지 않는다.** 이 값이 원문 어디에서 나왔는지는 바이트 구간으로 답할 수 있지만, 그 값이 참이라는 증명은 아니다. 확인하지 못한 완성도는 `false` 가 아니라 `unknown` 이다.

Parism은 **근거 조회·예산·비교를 해도 같은 명령을 다시 실행하지 않는다.** 저장본을 보거나, 잘린 결과를 이어 읽거나, 전후를 비교하는 것까지다. 사라진 결과를 대신 실행해 주는 도구는 아니다.

Parism은 **감시 루프가 아니다.** 비교는 이미 있는 두 결과를 놓고 이루어진다. 언제 다시 확인할지는 호출자가 정한다.

Parism은 **정확한 모델 토큰 수를 약속하지 않는다.** 고정 토크나이저(`parism/approx`·`byte`)의 약속은 parism JSON payload 에만 성립한다. 전송·클라이언트·모델 내부 토큰은 포함하지 않는다.

Unix 철학은 "하나의 일을 잘 하라"였다. Parism은 그것을 이해한다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
