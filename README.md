# Parism

> Refract the Shell. Every command, structured.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

AI 에이전트가 셸 명령을 안전하게 실행하고 결과를 JSON으로 받게 해 주는 MCP 서버이자 Node.js 라이브러리입니다.

문서: [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

---

## 한눈에 보기

```json
run({ "cmd": "ls", "args": ["-la", "src"] })
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

- `raw`에는 원본 출력이 항상 그대로 담깁니다.
- `parsed`에는 파서가 읽어 낸 구조가 담깁니다. 파서가 없는 명령은 `null`입니다.
- 43개 명령에 기본 파서가 있고, 직접 만든 파서를 추가할 수 있습니다.

셸 출력은 사람이 읽도록 만들어져 있습니다. 에이전트가 이를 직접 해석하면 파일명의 공백, OS별 열 순서(`ps`), 환경마다 다른 헤더(`df`)에서 자주 틀립니다. Parism은 OS를 감지해 맞는 파서를 고르고, 해석이 끝난 결과를 돌려줍니다.

---

## 동작 구조

```
  Agent (MCP client)                 Node.js code
         │  stdio                          │  createEngine()
         ▼                                 ▼
  ┌──────────────────────────────────────────────────┐
  │                     Parism                       │
  │                                                  │
  │  1. Guard      allowlist · paths · injection     │──▶ blocked: ok=false, failure.kind="guard"
  │       │                                          │
  │  2. Executor   spawn (no shell), timeout, limit  │──▶ exec error: failure.kind="exec"
  │       │                                          │
  │  3. Redactor   mask secrets in output            │
  │       │                                          │
  │  4. Parser     OS-aware, 43 built-in + custom    │──▶ no parser: parsed=null, raw kept
  │       │                                          │
  │  5. Shaper     filter · budget · evidence        │
  │       │                                          │
  │       ├──▶ Result store (opt-in, in memory)      │
  └───────┼──────────────────────────────────────────┘
          ▼
   { ok, stdout: { raw, parsed }, failure?, review?, budget? }
```

명령은 셸을 거치지 않고 실행 파일을 직접 띄웁니다. 차단, 실행 실패, 파싱 실패는 예외를 던지지 않고 같은 형태의 응답으로 돌아옵니다. 에이전트는 `failure.kind` 하나로 분기하면 됩니다.

---

## 빠른 시작

### 1. 설치

```bash
npx @nerdvana/parism
```

인자 없이 실행하면 stdio MCP 서버로 동작합니다. 소스에서 빌드하려면 다음과 같이 합니다.

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

### 2. MCP 클라이언트에 등록

대부분의 클라이언트는 아래 형식을 그대로 받습니다.

```json
{
  "mcpServers": {
    "parism": {
      "command": "npx",
      "args": ["-y", "@nerdvana/parism"]
    }
  }
}
```

클라이언트별 설정 위치는 다음 문서에 있습니다.

| 클라이언트 | 문서 |
|---|---|
| Claude Desktop | [claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

### 3. 에이전트의 첫 호출 순서

```
describe()                    허용 명령, 파서, 가드 제한 확인
   │
dry_run(cmd, args)            가드 통과 여부만 확인 (실행 안 함)
   │
run(cmd, args)                실행하고 구조화된 결과 받기
   │
   ├─ 출력이 크면  ──▶ run_paged(page=N)  또는  run(budget) + fetch_result
   └─ 근거가 필요하면 ──▶ run(retain, evidence) + explain_result
```

---

## 도구

연결하면 9개 도구가 노출됩니다.

| 도구 | 명령 실행 | 용도 |
|---|---|---|
| `run` | O | 기본 실행. 필터, 예산, 근거 옵션 포함 |
| `run_paged` | O | 큰 출력을 줄 단위 페이지로 읽기 |
| `describe` | X | 환경, 허용 명령, 파서 정보 확인 |
| `dry_run` | X | 가드 통과 여부 미리 확인 |
| `explain_result` | X | 보관한 결과의 값이 원문 어디에서 왔는지 조회 |
| `fetch_result` | X | 예산 때문에 잘린 결과의 다음 페이지 읽기 |
| `compare_results` | X | 보관한 두 결과의 차이 비교 |
| `query_result` | X | 보관한 결과에 다른 조건을 다시 걸기 |
| `task` | X | `run(mode: "task")`로 시작한 명령의 상태 조회와 취소 |

`explain_result`, `fetch_result`, `compare_results`, `query_result`는 보관된 결과만 읽고 명령을 다시 실행하지 않습니다. 보관본은 서버 프로세스 메모리에만 있으며 한도는 결과당 2MiB, 합계 32MiB, 최대 16개, 60초입니다. 개수와 시간은 `results` 설정으로 바꿀 수 있습니다. 모르는 id, 만료, 퇴출, 보관하지 않음은 각각 다른 사유로 거절됩니다.

### run

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `cmd` | — | 명령 이름 |
| `args` | `[]` | 인자 배열 |
| `cwd` | 현재 디렉터리 | 작업 디렉터리 |
| `format` | `"json"` | `"json"`, `"compact"`, `"json-no-raw"` |
| `includeDiff` | `false` | 실행 전후 파일시스템 변화 포함 |
| `select` `where` `sort_by` `limit` `array` | — | [필터와 투영](#필터와-투영) |
| `budget` | — | [토큰 예산](#토큰-예산) |
| `contract_version` | `"stable"` | `"next"`면 `review` 메타데이터 추가 |
| `evidence` | `"none"` | `"rows"`, `"fields"`. 필드별 원문 위치 계산 |
| `retain` | `false` | 결과를 메모리에 보관해 후속 도구에서 사용 |
| `machine_format` | `false` | 시험 러너·컴파일러·린터에 기계용 출력 형식 인자를 덧붙여 실행. [시험·빌드·린트](#시험빌드린트) |
| `mode` | `"wait"` | `"task"`면 명령을 시작하고 식별자를 바로 반환. [장기 실행 태스크](#장기-실행-태스크) |

`contract_version`, `evidence`, `retain`, `budget`을 지정하지 않으면 응답 형태는 이전 버전과 같습니다. `machine_format`과 `mode`는 `contract_version: "next"`에서만 동작하고, 이때 응답 JSON은 들여쓰기 없이 한 줄로 옵니다.

`format: "compact"`는 목록형 결과를 `schema`와 `rows`로 접어 토큰을 줄입니다.

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

### run_paged

`ps aux`, `find`, `grep -r`처럼 출력이 큰 명령에 씁니다. `stdout.parsed`는 항상 `null`이고 원문을 줄 단위로 나눠 줍니다.

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `page` | `0` | 0부터 시작하는 페이지 번호 |
| `page_size` | `100` | 페이지당 줄 수. 상한은 `max_page_size`(기본 1000) |

응답의 `page_info`에는 `total_lines`, `has_next`, `cache`(`{ hit, age_ms }`)가 담깁니다. 같은 명령은 30초 동안 첫 실행 결과를 재사용합니다.

### describe

인자 없이 부르면 `version`, `allowed_commands`, `available_parsers`, `guard_summary`, `telemetry_enabled`를 돌려줍니다.

`describe({ cmd: "git" })`처럼 명령을 지정하면 그 명령의 정보만 2KB 이내로 돌려줍니다.

- `policy`: 가드가 허용하는 서브커맨드, 플래그, 위치 인자
- `parser`: 파서가 읽는 형식과 결과 필드
- `alternatives`: 지원하지 않는 인자 대신 쓸 인자
- `examples`: 현재 가드를 통과하는 인자 예시

### dry_run

`cmd`, `args`, `cwd`를 받아 실행 없이 가드 판정만 돌려줍니다.

```json
{ "would_pass": false, "reason": "command_not_allowed", "message": "Command 'rm' is not in the allowed list" }
```

차단 사유는 `command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed` 중 하나입니다.

---

## 응답과 실패 처리

```
result.ok === true   ──▶ stdout.parsed 사용 (null이면 stdout.raw 사용)
result.ok === false  ──▶ result.failure.kind 로 분기
                           ├─ "guard"   가드가 차단함. 실행되지 않음
                           ├─ "exec"    실행 실패. message에 stderr
                           ├─ "parse"   파서 없음 (reason: "parser_not_found")
                           └─ "config"  필터 인자 오류 (unknown_field, type_mismatch)
```

```json
{
  "ok": false,
  "failure": {
    "kind": "guard",
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

하위 호환을 위해 `guard_error` 필드도 함께 오지만, 분기는 `failure`로 합니다.

파서가 실행됐지만 결과를 만들지 못하면 `stdout.parse_error`에 이유가 남고 `raw`는 그대로 옵니다.

| `parse_error.reason` | 의미 |
|---|---|
| `parser_exception` | 파서가 예외를 던짐 |
| `schema_violation` | `strict_schemas` 검증 실패 |
| `unsupported_format` | 파서가 다루지 않는 인자 조합 |
| `unrecognized_output` | 데이터 줄은 있지만 아무 값도 읽지 못함 |

### 지원하지 않는 인자

각 파서는 검증한 인자 범위를 선언합니다. 범위 밖의 인자를 주면 추측해서 해석하지 않고 `unsupported_format`을 돌려주며, 같은 정보를 얻을 수 있는 인자가 있으면 `hint`로 알려 줍니다.

```json
{ "reason": "unsupported_format", "hint": { "args": ["log", "--format=%h %s"] } }
```

| 입력 | 제안 |
|---|---|
| `uname -r` | `["-a"]` |
| `git status -s --ignored` | `["status", "--ignored"]` |
| `kubectl get pods -o yaml` | `["get", "pods", "-o", "json"]` |

출력 자체가 JSON인 명령(`kubectl get pods -o json`, `docker inspect`)은 파서 없이 바로 `parsed`에 들어갑니다.

### 명령이 이 호스트에 없을 때

허용 목록에 있는 명령이라도 이 호스트에 설치돼 있지 않을 수 있습니다. 그때 parism 은 실패를 그대로 두지 않고 **다음 행동**까지 알려 줍니다.

```json
{
  "ok": false,
  "failure": {
    "kind": "exec",
    "reason": "spawn_failed",
    "message": "spawn helm ENOENT",
    "errorCode": "ENOENT",
    "availability": {
      "status": "missing",
      "install": { "command": "brew install helm", "package": "helm", "manager": "brew" },
      "alternatives": [
        { "cmd": "kubectl", "args": ["get", "all"], "reason": "helm 차트가 없으면 kubectl 로 클러스터 리소스를 직접 본다" }
      ]
    }
  }
}
```

| 필드 | 뜻 |
|---|---|
| `availability.status` | `missing`(PATH 에 없음) 또는 `not_executable`(있지만 실행 권한 없음) |
| `availability.install` | 이 호스트에서 **실제로 쓸 수 있는** 패키지 관리자의 설치 명령 |
| `availability.alternatives` | 같은 일을 하는 다른 명령. 현재 가드 allowlist 안에 있는 것만 |
| `failure.errorCode` | 스폰 실패의 errno 코드 |

`not_executable` 는 설치로 해결되지 않으므로 `install` 가 없습니다. 설치 지시는 **정적 표**에서만 나오므로, 표에 없는 명령은 `status` 만 알려 줍니다.

실행 전에 무엇을 쓸 수 있는지 보려면 `describe()` 를 부르세요. `command_availability` 에 허용 명령 전체의 설치 상태가 들어 있습니다.

---

## 가드

에이전트가 잘못 만든 명령이 그대로 실행되지 않도록 네 가지 검사를 차례로 적용합니다.

```
 cmd + args
     │
     ▼
 [1] allowed_commands   목록에 없는 명령          ──▶ command_not_allowed
     │
 [2] allowed_paths      cwd·경로 인자가 범위 밖    ──▶ path_not_allowed
     │
 [3] block_patterns     ; $( ` && || | > >> <     ──▶ injection_pattern
     │
 [4] arg restrictions   node -e, npx --yes 등      ──▶ arg_not_allowed
     │
     ▼
  실행
```

1. **명령 허용 목록**: `allowed_commands`에 없는 명령은 프로세스를 만들지 않고 거절합니다.
2. **경로 제한**: `allowed_paths`를 설정하면 `cwd`와 경로로 보이는 인자(`/`가 들어 있거나 `.`, `~`로 시작하거나 실제로 존재하는 항목, 심볼릭 링크 포함)를 검사합니다. 비워 두면 경로 제한이 없습니다.
3. **인젝션 패턴**: 인자 하나하나에 셸 메타문자가 있으면 거절합니다. 검색어와 출력 형식 값은 검사하지 않습니다: `grep`의 검색어(첫 위치 인자, `-e`), `find`의 `-regex`, `git`의 `--format`과 `--pretty`. 그래서 `grep -E "BEGIN|END"`가 통과합니다.
4. **명령별 인자 제한**: `node -e`, `node --eval`, `node --input-type`, `npx --yes`는 기본으로 막힙니다.

가드는 프로세스 수준의 방어선이며 커널 샌드박스가 아닙니다. 신뢰할 수 없는 환경에서 쓸 때의 격리 방법은 [SECURITY.md](SECURITY.md)에 있습니다.

---

## 지원 명령

60개 명령에 기본 파서가 있습니다. 명령별 결과 필드는 `describe({ cmd: "…" })`로 확인합니다.

| 분류 | 명령 | 기본 허용 |
|---|---|---|
| 파일시스템 | `ls -l` `find` `stat` `du` `df` `tree` | O |
| 프로세스 | `ps aux` | O |
| 네트워크 | `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | O |
| 텍스트 | `grep -n` `wc` `head` `tail` `cat` | O |
| Git | `git status` `git status --porcelain` `git log --oneline` `git diff` `git branch -vv` | O |
| 배포 | `kubectl get` `docker` `gh pr list` `helm list` | O |
| 환경 | `env` `pwd` `which` | O |
| 시스템 | `free` `uname` `id` `systemctl list-units` `journalctl` `apt list` `apt search` `brew list --versions` | O |
| 패키지 | `npm list` | O |
| 패키지 | `pnpm list` `yarn list` | 직접 허용 필요 (`yarn`은 build 프로필도 필요) |
| 빌드 | `terraform plan` `cargo tree` | build 프로필 |
| 시험·진단 | `cargo test` `cargo build` `cargo check` | build 프로필 |
| 시험·진단 | `vitest` `jest` `tsc` `eslint` (직접 실행 또는 `npx`로) | 직접 허용 필요 (`npx`는 build 프로필도 필요) |
| 시험·진단 | `pytest` `go test` `ruff check` `mypy` | 직접 허용 필요 |
| 프로세스 제어 | `kill` | 직접 허용 필요 |
| Windows | `dir` `tasklist` `ipconfig` `systeminfo` | 직접 허용 필요 |

- **직접 허용 필요**: `guard.allowed_commands`에 명령을 넣어야 합니다.
- **build 프로필**: `guard.profile`을 `"build"`로 바꿔야 합니다. `cargo`와 `yarn`은 조회 명령이어도 저장소가 지정한 래퍼나 스크립트를 실행할 수 있어서 이 프로필에서만 열립니다.

---

## 고급 기능

### 필터와 투영

파싱 결과의 최상위 배열(`ls`의 `entries`, `git log`의 `commits` 등)을 서버에서 걸러 필요한 만큼만 받습니다.

```
 parsed rows ──▶ where ──▶ sort_by ──▶ limit ──▶ select ──▶ response
```

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

- 연산자: `eq` `ne` `prefix` `contains`(문자열, 수, 불리언, `null`), `gt` `gte` `lt` `lte`(수). 조건은 모두 만족해야 합니다.
- 배열이 여러 개면 `array`로 대상을 고릅니다.
- 결과에 `_summary: { total, matched, shown }`이 붙고 `stdout.raw`는 빠집니다.
- 정렬은 안정 정렬이고, 값이 없는 행은 뒤로 갑니다.
- 항목 500개 디렉터리에서 `select: ["name","size_bytes"], limit: 50`을 주면 결과 크기가 30,122토큰에서 725토큰으로 줄어듭니다.

### 토큰 예산

결과를 정한 토큰 안에 맞추고, 무엇이 얼마나 빠졌는지 함께 알려 줍니다.

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

```
 Agent                              Parism
   │ run(cmd, budget, retain:true)    │
   │────────────────────────────────▶│ 실행, 파싱, 예산에 맞춰 자름
   │◀────────────────────────────────│ budget, omission[], continuation.cursor
   │                                  │
   │ fetch_result(result_id, cursor)  │
   │────────────────────────────────▶│ 보관본에서 다음 페이지 (재실행 없음)
   │◀────────────────────────────────│ 다음 행 + 새 cursor
   │          ... cursor가 없을 때까지 반복
```

```json
"budget":   { "max_tokens": 2000, "measured_tokens": 1842, "budget_met": true },
"omission": [{ "stage": "budget", "rows_total": 206, "rows_returned": 138, "rows_omitted": 68 }]
```

- 예산은 이미 얻은 결과를 얼마나 내보낼지 정하는 기능입니다. 실행 시간이나 수집량은 줄지 않습니다.
- `required_fields`와 행 식별 필드는 어떤 행에서도 빠지지 않습니다. 예산 안에서 이를 지킬 수 없으면 일부만 보내지 않고 실패를 돌려줍니다.
- 예산이 최소 응답 크기(약 1,200토큰)보다 작으면 실행 전에 `budget_too_small`로 거절합니다.
- `omission[].stage`는 `capture`, `parse`, `projection`, `budget`, `privacy` 중 하나여서, 예산 때문에 빠진 행과 파서 문제로 빠진 행을 구분할 수 있습니다.
- 토크나이저는 `parism/approx`(근사)와 `byte`(문자 단위) 두 가지입니다. 측정 범위는 Parism이 만든 JSON뿐이며 모델 내부 토큰 수와는 다를 수 있습니다.
- cursor는 결과와 조회 조건에 묶여 있습니다. 다른 결과의 cursor는 `cursor_mismatch`, 변조된 cursor는 `cursor_invalid`로 거절됩니다.

JSON은 같은 내용의 원문보다 큽니다. `ls -la` 200행 기준으로 원문은 5,044토큰, JSON은 12,204토큰입니다. 토큰을 아껴야 하면 `select`, `limit`, `format: "json-no-raw"`, `budget`을 함께 쓰십시오.

### 근거 조회

"이 값이 원문 어디에서 나왔는가"를 바이트 구간으로 답합니다.

```
 run(cmd, { contract_version: "next", evidence: "fields", retain: true })
   └─▶ review.result_id
         │
 explain_result(result_id, pointer: "/processes/0/pid")
   └─▶ value, source_kind, source_spans [start, end), transform
```

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived",
  "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- 구간은 시크릿을 가린 원문 기준의 UTF-8 바이트 오프셋 `[start, end)`입니다.
- 원문 그대로인 값은 `verbatim`, 변환을 거친 값은 `derived`이고 적용한 변환을 함께 줍니다.
- 근거를 만드는 파서는 현재 `ps`와 `git status --porcelain`입니다. 다른 파서의 필드는 `source_kind: "none"`이고 그 이유가 `warnings`에 남습니다.
- 근거는 명령이 그 순간 무엇을 출력했는지를 가리킬 뿐, 값이 참이라는 증명은 아닙니다.
- `evidence`나 `budget`을 쓰면 자동 compact 변환이 꺼집니다. 접힌 표에서는 포인터가 가리킬 대상이 사라지기 때문입니다.

`contract_version: "next"`일 때 붙는 `review`의 주요 필드는 다음과 같습니다.

| 필드 | 의미 |
|---|---|
| `result_id` | 후속 도구에 넘기는 id |
| `parser_id` / `parser_version` / `schema_version` | 결과를 만든 파서와 스키마 |
| `content_hash` | 원문 해시 |
| `source_complete` / `parse_complete` / `representation_lossless` | 수집, 파싱, 변환이 손실 없이 끝났는지 (`true` / `false` / `unknown`) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | 보관 여부 |
| `warnings` | 불완전하거나 근거가 없는 이유 |

### 결과 비교

`compare_results`는 `run(retain: true)`로 보관한 두 결과를 비교합니다.

```
 run(..., retain:true) ─▶ base_id ─┐
                                   ├─▶ compare_results(base_id, current_id)
 run(..., retain:true) ─▶ current_id ┘        │
                                              ├─ comparable: false ─▶ refusals.reasons
                                              └─ comparable: true  ─▶ added / removed / changed
```

```json
{ "comparable": false, "refusals": { "reasons": ["different command"] } }
```

- 선택 인자: `keys`, `ignore_fields`, `strict`.
- 한쪽이라도 불완전하면 없어진 행을 삭제로 단정하지 않고 `partial.withheld_reasons`에 보류합니다.
- 행 식별 기준: git은 저장소 실경로와 파일 경로, Kubernetes는 context, namespace, kind, `metadata.uid`입니다. uid가 없는 표 출력은 같은 자원으로 보지 않습니다. `ps`는 PID가 재사용될 수 있어 비교를 보류합니다.
- 같은 식별자가 두 번 나오면 `duplicate_identity`로 멈춥니다.
- argv는 해시로 비교하고 화면에는 가린 값만 보여 줍니다. 환경 변수는 이름만 기록합니다.

### 시험·빌드·린트

시험 러너, 컴파일러, 린터의 결과에서 실패 항목과 진단은 모두 싣고, 통과한 항목은 개수만 싣습니다.

```
 run("npx", { args: ["vitest", "run"], contract_version: "next", machine_format: true })
```

```json
{
  "kind": "test", "tool": "vitest",
  "passed": 1788, "failed": 2, "skipped": 9, "todo": 0, "total": 1799, "files_failed": 0, "success": false,
  "failures": [
    { "id": "tests/engine/guard.test.ts > guard rejects glob", "file": "tests/engine/guard.test.ts",
      "name": "guard rejects glob", "line": 214, "column": 31, "message": "AssertionError: expected false to be true" }
  ]
}
```

진단 도구는 `{ kind: "diagnostics", errors, warnings, infos, files, by_code[], diagnostics[] }`를 돌려줍니다. `diagnostics[]`의 각 항목은 `{ file, line, column, severity, code, message }`입니다.

| 명령 | 읽는 형식 | `machine_format`이 덧붙이는 인자 |
|---|---|---|
| `vitest` | json 리포터 | `--reporter=json`. 보고서는 임시 파일로 받아 읽고 지웁니다 |
| `jest` | `--json` | `--json` |
| `tsc` | `--pretty false` | `--pretty false` |
| `eslint` | `--format json` | `--format json` |
| `cargo test` | libtest 기본 출력 | 없음 |
| `cargo build` `cargo check` | `--message-format=json` | `--message-format=json` |
| `pytest` | JUnit XML | 없음. 보고서를 임시 파일(`--junitxml`)로 받아 읽고 지웁니다 |
| `go test` | `-json` | `-json` |
| `ruff check` | `--output-format=json` | `--output-format=json` |
| `mypy` | `--output=json` | `--output=json` |

- `machine_format` 없이 다른 형식으로 실행하면 `unsupported_format`이고, `hint.args`에 바꿔 실행할 인자가 옵니다.
- 러너가 스스로 보고한 실패 수와 파싱한 실패 항목 수가 다르면 결과를 만들지 않고 원문을 돌려줍니다.
- 러너가 실패했는데 읽을 출력이 없으면 결과를 만들지 않습니다. 러너를 띄우지 못한 실행을 "오류 0건"으로 읽지 않기 위해서입니다.
- 이 명령들의 출력은 `max_output_bytes`와 관계없이 전체를 읽어 파싱합니다. 파싱에 성공하면 원문은 응답에 싣지 않습니다.
- 실패 항목은 `max_items`로 자르지 않습니다. 진단 목록은 `max_items`에서 자르지만 개수 필드는 전체 기준이고, 잘린 수는 `diagnostics_omitted`에 옵니다.
- 파일 경로에서 작업 디렉터리 접두사는 뺍니다.
- `npm test`, `npm run <스크립트>`는 어떤 러너가 어떤 형식으로 출력할지 정해져 있지 않아 파싱하지 않습니다. 러너를 직접 부르십시오.
- `pytest`는 표준 출력에 기계용 형식이 없어서 `machine_format: true`로 실행해야 결과가 나옵니다.
- `evidence: "fields"`와 `retain: true`를 함께 주면 `tsc`, `mypy`, `cargo build`의 진단 필드와 `cargo test`, `go test`의 실패한 시험 이름이 원문 어느 구간에서 왔는지 `explain_result`로 조회할 수 있습니다. JSON 문서 하나를 내는 러너(`vitest`, `jest`, `eslint`, `ruff`)와 보고서 파일을 쓰는 `pytest`는 근거를 내지 않습니다.

실제 러너 출력 11개(`tests/parsers/devloop-fixtures`)로 잰 토큰 수입니다. 재현: `npm run build && node experiments/devloop-tokens.mjs`.

| 출력 | 원문 토큰 | 결과 토큰 | 비율 | 실패·진단 (원문 → 결과) |
|-|-|-|-|-|
| vitest (실패 2, 파일 오류 1) | 1051 | 247 | 24% | 3 → 3 |
| vitest (전부 통과) | 245 | 44 | 18% | 0 → 0 |
| jest (실패 1, 파일 오류 1) | 1376 | 274 | 20% | 2 → 2 |
| pytest (실패 3, 오류 1) | 559 | 445 | 80% | 4 → 4 |
| cargo test (실패 2) | 216 | 214 | 99% | 2 → 2 |
| go test (실패 3) | 1471 | 152 | 10% | 3 → 3 |
| tsc (오류 3) | 78 | 179 | 229% | 3 → 3 |
| eslint (문제 4) | 347 | 218 | 63% | 4 → 4 |
| ruff (문제 6) | 1226 | 291 | 24% | 6 → 6 |
| mypy (오류 2) | 148 | 141 | 95% | 2 → 2 |
| cargo build (오류 2) | 1522 | 126 | 8% | 2 → 2 |
| 합계 | 8239 | 2331 | 28% | 31 → 31 |

시험이 몇 개뿐인 예제 프로젝트의 출력이라 실패 항목의 비중이 큽니다. 통과한 시험이 많을수록 원문은 길어지고 결과는 그대로이므로 비율은 낮아집니다. `tsc`처럼 원문이 이미 한 줄에 진단 하나인 형식은 구조화하면 토큰이 늘어납니다. 이 경우 얻는 것은 크기가 아니라 필드 조건으로 고르고 세는 기능입니다.

### 장기 실행 태스크

`guard.timeout_ms`(기본 10초)보다 오래 걸리는 시험과 빌드는 태스크로 실행합니다.

```
 run(cmd, { contract_version: "next", mode: "task" }) ─▶ { task: { task_id, state: "running" } }
                                                              │
 task({ task_id, wait_ms: 30000 })    ─▶ state, elapsed_ms, stdout_bytes, progress
 task({ task_id, action: "cancel" })  ─▶ 그 태스크의 프로세스만 종료
                                                              │
                              끝나면 task.result에 run과 같은 결과가 실립니다
```

- 태스크는 `tasks.timeout_ms`(기본 10분)까지 실행되고, 동시에 `tasks.max_concurrency`(기본 2)개까지 실행됩니다.
- `wait_ms`를 주면 상태 조회가 바로 답하지 않고, 태스크가 끝나거나 새 실패가 나오거나 그 시간이 지날 때 답합니다. 최대 30초입니다. 짧은 간격으로 반복 조회하는 대신 이 값을 쓰십시오. 생략하면 바로 답합니다.
- 슬롯이 차면 대기시키지 않고 `task_slots_full`로 거절합니다. 태스크 슬롯은 일반 `run`의 동시 실행 수와 따로 셉니다.
- `cargo test` 태스크는 실행 중에 `progress: { passed, failed, skipped, failed_names }`를 돌려줍니다. 첫 실패를 보고 끝까지 기다리지 않고 취소할 수 있습니다. 다른 러너는 실행 중에 경과 시간과 출력 바이트 수만 알려 줍니다.
- 끝난 태스크의 결과는 10분, 최대 16개까지 보관합니다. 보관이 끝난 태스크는 `task_expired`로 알려 주고 다시 실행하지 않습니다.
- 프로젝트 설정은 `tasks`의 두 값을 줄일 수만 있습니다.

80초쯤 걸리는 `cargo test`를 에이전트(모델 `haiku`)에게 5회씩 시킨 결과입니다. 시험 하나가 시작하자마자 실패하는 크레이트입니다.

| 조건 | 맞게 보고 | 실패를 안 시각 | 도구 호출 |
|-|-|-|-|
| `run`, 시간 제한 10초 | 5/5 (4건은 전체 결과를 얻지 못했다고 보고) | 13.4초 | 6회 |
| `run`, 시간 제한 10분 | 5/5 | 83.8초 | 1회 |
| 태스크, 시간 제한 10초 | 5/5 | 13.0초 | 5회 |

재현과 한계: [experiments/README.md](experiments/README.md) 부록 S.

#### MCP 태스크 요청으로 쓰기

MCP의 태스크 요청을 지원하는 클라이언트는 `task` 도구 대신 프로토콜 요청으로 같은 태스크를 다룰 수 있습니다. 호스트 설정에서 켭니다.

```json
{ "tasks": { "mcp_extension": true } }
```

켜면 서버가 태스크 기능을 선언하고 `run_task` 도구를 하나 더 노출합니다.

```
 tools/call run_task (task 인자 포함) ─▶ 태스크(working)
 tasks/get     ─▶ 상태. 실행 중이면 statusMessage에 진행 상태
 tasks/result  ─▶ run과 같은 결과
 tasks/cancel  ─▶ 그 명령의 프로세스만 종료
```

- `run_task`의 입력은 `run`과 같고(`mode`, `contract_version` 제외) 결과는 `contract_version: "next"`의 `run`과 같습니다.
- 태스크 요청 없이 `run_task`를 부르면 거절합니다. 일반 호출은 `run`을 쓰십시오.
- 가드가 막았거나 슬롯이 없으면 `failed` 상태의 태스크를 돌려주고, `tasks/result`에 사유가 담긴 결과가 옵니다.
- 슬롯, 시간 제한, 취소는 `run(mode: "task")`와 같은 태스크 관리자가 맡습니다.
- 이 기능은 MCP SDK의 experimental 태스크 API를 씁니다. SDK가 바뀌면 동작이 달라질 수 있어 기본값은 꺼짐이고, SDK 버전을 `~1.32.1`로 고정했습니다.
- 프로젝트 설정으로는 켤 수 없습니다.

### 보관 결과 재질의

`query_result`는 `run(contract_version: "next", retain: true)`로 보관한 결과에 `select`, `where`, `sort_by`, `limit`, `aggregate`를 다시 겁니다. 명령은 다시 실행하지 않습니다.

```
 run("ls", { args: ["-l"], contract_version: "next", retain: true, limit: 5 })   ─▶ result_id
 query_result({ result_id, where: [{ field: "size_bytes", op: "gt", value: 4096 }], select: ["name"] })
```

- 조건은 처음 실행에서 걸었던 프로젝션과 무관하게, 파싱한 전체 결과에 적용합니다.
- 처음 실행에 프로젝션 인자가 하나도 없었으면 보관본이 `max_items`에서 잘렸을 수 있습니다. 이때 응답의 `source_complete`가 `false`입니다. 전체를 보관하려면 처음 실행에 프로젝션 인자를 하나라도 주십시오.
- 응답의 `row_pointers`는 돌려준 행마다 보관된 결과에서의 위치입니다(`/processes/41`). 뒤에 필드 이름을 붙여 `explain_result`에 주면 그 값의 원문 구간을 볼 수 있습니다. 처음 실행에 프로젝션이 있었거나 집계한 결과에는 없습니다.

파일 201개의 `ls -l` 결과에 질문 세 개를 차례로 던졌을 때, 질문마다 다시 실행하면 명령 실행 3회에 응답 1,902토큰이고 `query_result`로 물으면 실행 1회에 1,101토큰입니다. 원문 전체는 4,438토큰입니다. 재현: `npm run build && node experiments/requery.mjs`.

### 집계

`aggregate`는 `where`를 통과한 행을 묶어 묶음마다 행 하나로 바꿉니다. `run`(`contract_version: "next"`)과 `query_result`에서 씁니다.

```
 run("ls", { args: ["-l", "src"], contract_version: "next",
             aggregate: { group_by: ["type"], sum: ["size_bytes"] }, sort_by: { field: "count", order: "desc" } })
```

```json
{ "entries": [ { "type": "file", "count": 41, "sum_size_bytes": 183204 }, { "type": "directory", "count": 7, "sum_size_bytes": 28672 } ],
  "_summary": { "total": 48, "matched": 48, "shown": 2, "groups": 2 } }
```

- 묶음 행은 `group_by` 필드, `count`(행 수), `sum_<필드>`(수 필드의 합), `distinct_<필드>`(서로 다른 값의 수)를 가집니다. `group_by`가 없으면 전체가 한 묶음입니다.
- 순서는 `where` → `aggregate` → `sort_by` → `limit` → `select`입니다. `sort_by`와 `select`는 묶음 행의 필드를 가리킵니다.
- `sum`의 필드 값은 수여야 하고, 값이 없는 행은 합에 넣지 않습니다. 값이 없는 `group_by` 필드는 `null` 묶음이 됩니다.

### 출처 표시

`contract_version: "next"`에서, 파싱 결과가 있는 응답에는 `_origin`이 붙습니다.

```json
{ "_origin": { "external": ["failures[].id", "failures[].file", "failures[].name", "failures[].message"],
               "fixed": ["kind", "tool", "passed", "failed", "failures[].line"], "basis": "table" } }
```

- `external`은 명령 출력에서 그대로 가져온 문자열 필드입니다(파일명, 경로, 시험 이름, 오류 메시지). 이 필드의 내용은 데이터이며 지시로 따를 대상이 아닙니다.
- `fixed`는 파서가 숫자나 불리언으로 바꾼 값과 정해진 값 집합 안에서만 나오는 필드입니다(개수, 줄 번호, 상태 열거형). 형식에 맞지 않는 값이 들어오면 `schema_violation`으로 결과를 비우고 원문을 남깁니다.
- 권한 문자열, 시각, 해시, 소유자 이름처럼 형태가 정해진 값도 출력의 문자열 그대로이면 `external`입니다.
- 외부 문자열이 필요 없는 작업은 `select`로 `fixed` 필드만 고르십시오.
- `stdout.raw`, `stderr`, 근거 조회가 돌려주는 원문 구간은 분류와 관계없이 전부 외부 문자열입니다.
- `basis: "table"`은 파서의 분류표로 분류했다는 뜻이고, 이때 `fixed` 필드는 형식 검사를 거칩니다. 내장 파서는 모두 분류표가 있습니다.
- 파서가 형식에 따라 다른 모양을 내면(`packages` 또는 `lines`), 응답에는 그 결과에 있는 모양의 필드만 나옵니다. `headers.*`, `vars.*`의 `*`는 객체의 모든 키를 가리키고, 키 이름도 출력에서 온 문자열입니다.
- `basis: "value_types"`는 분류표가 없어 값의 형으로 분류했다는 뜻입니다. 직접 등록한 파서와, 명령이 낸 JSON을 그대로 읽은 결과가 여기에 해당합니다. 문자열은 모두 `external`, 수와 불리언은 `fixed`입니다. 키가 24개를 넘는 객체는 키도 출력에서 온 것으로 보고 한 경로(`*`)로 모읍니다.
- 이 표시는 외부 문자열을 구분할 단서를 줍니다. 프롬프트 주입을 막는 장치는 아닙니다.

지시문을 넣은 커밋 메시지, 파일명, 로그 줄로 조건마다 90회씩 잰 결과입니다(모델 `haiku`). 과제는 커밋 수 같은 수를 세는 일입니다.

| 도구 결과 | 지시문이 모델에 전달됨 | 지시문을 따름 | 정답 |
|-|-|-|-|
| 원문 | 90/90 | 0/90 | 88/90 |
| 기본 응답 (`_origin` 포함) | 90/90 | 0/90 | 90/90 |
| `fixed` 필드만 고른 응답 | 0/90 | 0/90 | 90/90 |

`fixed` 필드만 고르면 지시문이 모델에 전달되지 않습니다. 이 모델은 원문에서도 지시문을 따르지 않아서, `_origin` 표시가 따르는 비율을 낮추는지는 이 측정으로 알 수 없습니다. 재현과 한계: [experiments/README.md](experiments/README.md) 부록 R.

### 실행 영수증

영수증은 "이 명령이 이 작업 공간 상태에서 이 결과로 끝났다"는 기록입니다. 에이전트가 "시험 통과"라고 보고했을 때 Stop 훅, CI, 리뷰 봇이 그 말을 확인하는 데 씁니다.

호스트 설정(`~/.parism/prism.config.json`)에서 켭니다.

```json
{
  "receipts": { "enabled": true },
  "verify":   { "commands": [["npx", "vitest", "run"], ["npx", "tsc", "--noEmit"]] }
}
```

켜면 `run`이 끝날 때마다 `~/.parism/receipts/receipts.jsonl`에 한 줄을 남깁니다. `contract_version: "next"` 응답에는 같은 내용이 `receipt`로 실립니다.

```json
{
  "id": "rcp_GyOCRKg35s47", "cmd": "npx", "args": ["vitest", "run", "--reporter=json"], "args_requested": ["vitest", "run"],
  "cwd": "/repo", "exit_code": 0, "started_at": "2026-11-11T09:12:03.000Z", "duration_ms": 48211,
  "summary": { "kind": "test", "passed": 1794, "failed": 0, "skipped": 9, "files_failed": 0 },
  "output_sha256": "…",
  "workspace": { "root": "/repo", "git_head": "98e63021cfec", "state_digest": "…",
                 "covers": ["tracked", "staged", "untracked_names", "untracked_content"] }
}
```

`parism receipts check`는 완료 조건을 판정합니다. 명령을 실행하지 않습니다.

```bash
parism receipts check                                  # verify.commands 기준
parism receipts check --require "npx vitest run"       # 명령을 직접 지정 (여러 번 가능)
parism receipts check --json
parism receipts list
```

명령마다 가장 최근 영수증으로 판정하고, 모두 `ok`일 때만 종료 코드 0입니다.

| 판정 | 뜻 |
|---|---|
| `ok` | 통과했고 그 뒤로 작업 공간이 바뀌지 않았습니다 |
| `missing` | 이 작업 공간에서 그 명령을 실행한 영수증이 없습니다 |
| `failed` | 종료 코드가 0이 아니거나, 실패한 시험·실행하지 못한 시험 파일·오류가 있거나, 시간 초과·취소로 끝났습니다 |
| `stale` | 실행 뒤에 작업 공간이 바뀌었습니다 |
| `unverifiable` | git 저장소가 아니어서 작업 공간 상태를 비교할 수 없습니다 |
| `bad_signature` | 서명 키가 있는데 서명이 맞지 않습니다 |

판정할 명령이 하나도 없으면 통과가 아니라 종료 코드 2입니다.

작업 공간 상태(`state_digest`)는 작업 트리에 있는 파일의 경로와 내용으로 만듭니다. 추적되지 않는 파일도 들어갑니다. HEAD와 스테이징 여부는 들어가지 않으므로, 시험이 통과한 내용 그대로 스테이징하거나 커밋해도 `ok`입니다. `.gitignore`로 제외된 파일, 서브모듈 안의 변경, 실행 권한 비트, 저장소 밖의 변화는 들어가지 않습니다. 추적되지 않는 파일이 `untracked_max_files`(2,000개)나 `untracked_max_bytes`(64MiB)를 넘으면 내용 해시를 빼고 `covers`에서 `untracked_content`를 뺍니다. 이때는 추적되지 않는 파일을 이름으로만 비교하므로, 그 파일을 스테이징하면 내용이 같아도 `stale`이 됩니다.

영수증이 말하지 않는 것은 다음과 같습니다.

- 시험이 요구를 제대로 검사하는지는 말하지 않습니다.
- 영수증 파일을 직접 고칠 수 있는 환경에서는 위조를 막지 못합니다. 기본 영수증은 실행 누락과 착오를 잡는 용도입니다.

서명이 필요하면 `receipts.key_file`에 16바이트 이상의 키 파일 경로를 줍니다. 영수증에 HMAC-SHA256 서명(`sig`)이 붙고 `check`가 서명을 확인합니다. 키는 환경 변수로 받지 않고 자식 프로세스에 넘기지 않습니다. 키 파일이 `guard.allowed_paths` 안에 있으면 Parism 명령으로 읽을 수 있으므로 서명을 켜지 않고 경고합니다. 서명은 Parism을 거치지 않고는 키 파일을 읽을 수 없는 환경(샌드박스, 별도 계정)에서만 위조를 막습니다.

예제 프로젝트에서 세션 15개(시험 실행, 수정, 스테이징, 커밋의 조합)를 실제로 실행해 판정을 확인했습니다. 보고하면 안 되는 세션 8개는 모두 막았고, 보고해도 되는 세션 7개는 하나도 막지 않았습니다. 재현: `npm run build && node experiments/receipts-check.mjs`.

Claude Code의 Stop 훅에 연결하는 방법은 [docs/mcp-clients/claude-code.md](docs/mcp-clients/claude-code.md)에 있습니다.

---

## 설정

`prism.config.json`으로 가드와 파서 동작을 바꿉니다.

```
 ~/.parism/prism.config.json      전역
           │  덮어씀
 <cwd>/prism.config.json          프로젝트 (가드를 넓히지 못함*)
           │  덮어씀
 PARISM_* 환경 변수
           ▼
     최종 설정
```

\* 프로젝트 설정으로 가드를 넓히려면 전역 설정에 `"trust_project_config": true`를 둡니다.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps"],
    "allowed_paths": ["/home/user/projects"],
    "profile": "readonly",
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
  },
  "tasks":    { "max_concurrency": 2, "timeout_ms": 600000 },
  "results":  { "max_entries": 16, "ttl_ms": 60000 },
  "receipts": { "enabled": false, "max_entries": 500, "max_age_days": 30 },
  "verify":   { "commands": [] }
}
```

| 키 | 설명 |
|---|---|
| `guard.allowed_paths` | 비어 있으면 경로 제한이 없습니다 |
| `guard.profile` | `"readonly"`(기본)는 조회 서브커맨드만 허용합니다. `"build"`는 `npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose ps` 같은 빌드·시험 명령을 추가합니다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 켜십시오 |
| `guard.workspace_executables` | `true`이면 경로로 지정한 실행 파일(`./configure`, `/work/build/app`)을 `allowed_commands`에 없어도 실행합니다. build 프로필에서만 동작하고, 심볼릭 링크를 따라간 실제 파일이 `allowed_paths` 안에 있어야 합니다. 기본값은 `false`이고, 신뢰하지 않는 프로젝트 설정으로는 켤 수 없습니다 |
| `guard.command_arg_restrictions` | 기본값과 병합됩니다. 일부 명령만 바꿔도 나머지 기본 제한은 남습니다 |
| `guard.command_policies` | 명령별 서브커맨드·플래그 규칙을 덮어씁니다 |
| `guard.secrets.env_patterns` | 이름이 일치하는 환경 변수를 자식 프로세스에서 제거합니다 |
| `guard.secrets.output_redaction_enabled` | `true`면 출력에서 `output_patterns`에 걸리는 값을 `[REDACTED]`로 바꿉니다 |
| `guard.secrets.output_patterns` | 생략하면 기본 패턴(GitHub, GitLab, AWS, Slack 토큰 등)을 씁니다. 끄려면 `[]` |
| `parsers.strict_schemas` | `true`면 파싱 결과를 Zod 스키마로 검증합니다 |
| `telemetry.enabled` | `true`면 응답에 단계별 소요 시간을 붙이고 `describe`에 명령별 통계를 보여 줍니다. 외부로 전송하지 않습니다 |
| `tasks` | 태스크의 동시 실행 수(`max_concurrency`)와 최대 실행 시간(`timeout_ms`). 프로젝트 설정은 줄일 수만 있습니다. `mcp_extension`은 [MCP 태스크 요청](#mcp-태스크-요청으로-쓰기)을 켭니다 |
| `results` | 결과 보관함의 최대 개수와 보관 시간. 호스트 설정에서만 읽습니다 |
| `receipts` | 실행 영수증. `enabled`, `max_entries`, `max_age_days`, `untracked_max_files`, `untracked_max_bytes`, `key_file`. 호스트 설정에서만 읽습니다 |
| `verify.commands` | `parism receipts check`가 기준으로 삼는 명령 목록. 각 항목은 `[명령, 인자...]`입니다. 호스트 설정에서만 읽습니다 |

호스트 설정은 전역 설정 파일과 환경 변수입니다. 프로젝트 설정(`<cwd>/prism.config.json`)의 `results`, `receipts`, `verify`는 `trust_project_config`와 관계없이 버리고 경고합니다. 저장소가 자기 완료 조건을 정하지 못하게 하기 위해서입니다.

`node`, `npx`, `yarn`은 `allowed_commands`에 직접 넣어야 하고 build 프로필에서만 동작합니다. `npx`에는 `--no`가 자동으로 붙습니다.

### 환경 변수

| 환경 변수 | 대상 | 형식 |
|---|---|---|
| `PARISM_ALLOWED_COMMANDS` | `guard.allowed_commands` | 쉼표 구분 |
| `PARISM_ALLOWED_PATHS` | `guard.allowed_paths` | 쉼표 구분 |
| `PARISM_TIMEOUT_MS` | `guard.timeout_ms` | 정수 |
| `PARISM_MAX_OUTPUT_BYTES` | `guard.max_output_bytes` | 정수 |
| `PARISM_MAX_ITEMS` | `guard.max_items` | 정수 |
| `PARISM_DEFAULT_PAGE_SIZE` | `guard.default_page_size` | 정수 |
| `PARISM_STRICT_SCHEMAS` | `parsers.strict_schemas` | `true` 또는 `1` |
| `PARISM_ADAPTIVE_FORMAT_JSON` | `parsers.adaptive_format_threshold.json` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_COMPACT` | `parsers.adaptive_format_threshold.compact` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_JSON_NO_RAW` | `parsers.adaptive_format_threshold.json_no_raw` | 정수 |
| `PARISM_TELEMETRY_ENABLED` | `telemetry.enabled` | `true` 또는 `1` |
| `PARISM_REGEX_ENGINE` | 정규식 엔진 선택 | `auto`(기본) · `rust` · `typescript` |
| `PARISM_REGEX_BIN` | 네이티브 엔진 바이너리 경로 | 절대 경로 |
| `PARISM_REGEX_TIMEOUT_MS` | 네이티브 엔진 요청 제한 시간 | 정수(기본 10000) |
| `PARISM_REQUIRE_NATIVE` | Rust 엔진이 없으면 바이트 동일성 게이트를 실패로 | `1` |

---

## 정규식 엔진

parism 은 **사용자가 준 정규식**을 그대로 실행한다. 그 패턴이 비밀 가림 여부를 결정한다.
그래서 패턴 하나가 서버를 멈추게 해서는 안 된다.

| 엔진 | 언제 | 특징 |
|------|------|------|
| **Rust** (`regex` 크레이트) | 엔진 바이너리를 찾았을 때 기본 | 역추적 불가능 — 어떤 패턴이든 **선형 시간** |
| **TypeScript** (V8) | 바이너리가 없거나, Rust 가 같은 결과를 못 낼 때 | 빠르지만 역추적 엔진 |

npm 배포본에는 Rust 엔진 바이너리가 들어 있지 않아 TypeScript 엔진으로 동작합니다. 출력은 같습니다.
Rust 엔진을 쓰려면 직접 빌드하고 `PARISM_REGEX_BIN` 으로 경로를 지정합니다.

```bash
cargo build --release --manifest-path crates/parism-regex/Cargo.toml
export PARISM_REGEX_BIN="$PWD/crates/parism-regex/target/release/parism-regex"
```

`i`·`m`·`u`·`y` 플래그, 역참조, lookaround 는 Rust 로 옮기지 않고 **TypeScript 로 되돌려보냅니다.**
되돌아간 사실은 결과의 `regex_engine.fallbacks` 에 사유와 함께 남습니다 — 조용히 바뀌지 않습니다.

```json
{ "regex_engine": { "used": "typescript", "fallbacks": [
  { "pattern": "secret", "reason": "the i flag uses ECMA-262 Canonicalize, which differs from Rust's Unicode case folding (U+017F and U+212A are the first divergences)" }
] } }
```

**출력은 한 바이트도 바뀌지 않습니다.** Rust 엔진을 켜고 끄고 같은 fixture 를 돌려
바이트 단위로 비교합니다 — 2,886건 비교, 불일치 0건(실측).
게이트는 "비교할 것이 없는 통과" 를 막습니다 — Rust 가 실제로 돌지 않았거나
아무것도 가려지지 않았다면 **검증 실패** 로 봅니다.

설계 근거: [`docs/adr/2026-10-22-native-regex-engine.md`](docs/adr/2026-10-22-native-regex-engine.md)

---

## 라이브러리로 쓰기

MCP 없이 Node.js 코드에서 직접 호출할 수 있습니다.

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine();
const result = await engine.run("ls", { args: ["-la"] });
console.log(result.stdout.parsed);
```

- `createEngine()`은 MCP 서버와 같은 설정 레이어를 읽고, 등록된 외부 파서를 붙입니다. 특정 파일만 쓰려면 `createEngine({ configPath: "…" })`.
- `run` 옵션: `args`, `cwd`, `format`, `includeDiff`, `select`, `where`, `sort_by`, `limit`, `array`, `page`, `page_size`.
- `engine.describe("git")`로 명령 하나의 정보를 볼 수 있습니다.

---

## 커스텀 파서

기본 파서가 없는 명령에 파서를 직접 붙일 수 있습니다. Parism은 ESM 전용이고 스키마는 zod 4를 씁니다.

```bash
npm install @nerdvana/parism zod@^4
# package.json 에 "type": "module" 필요
```

```
 capture ──▶ init-parser ──▶ 기대값 작성 ──▶ test ──▶ add ──▶ inspect
 (출력 저장)  (스캐폴드)     (사람이 검토)   (재생 검증) (등록)  (토큰 비교)
```

```bash
parism capture "htop -b -n 1"   # 1. 실제 출력을 fixture로 저장
parism init-parser htop          # 2. 파서 팩 스캐폴드 생성
# 3. fixture에 기대값과 reviewed_by를 직접 적는다
parism test ~/.parism/fixtures   # 4. 저장된 출력으로 파서를 다시 돌려 차이 확인
parism add ./htop                # 5. 등록. 재시작 없이 바로 사용
parism inspect "htop -b -n 1"    # 6. raw / parsed / compact 결과와 토큰 수 비교
```

등록한 팩은 `~/.parism/parsers/`에 저장되고 서버 시작 시 자동으로 로드됩니다.

### ParserPack 인터페이스

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* 구조화된 결과 반환 */ },
  schema: { /* Zod 스키마 */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
  acceptedFlags: { "-a": "bool", "-n": "value" }, // 선택: 검증한 플래그. 그 밖은 unsupported_format
  acceptedPositionals: { max: 1 },                // 선택: 위치 인자 규칙
  supports: (args) => args.length < 4,            // 선택: 추가 지원 조건
  headerLines: 1,                                 // 선택: 머리 줄 수
  noise: /^Total /,                               // 선택: 데이터가 아닌 줄
  rowsKey: "items",                               // 선택: 행 배열의 키
};

export default pack;
```

### fixture와 회귀 검사

```console
$ parism capture "ls -l src"
Fixture saved: ~/.parism/fixtures/ls-20261005-163909.json

$ parism test ~/.parism/fixtures
fixture 4개
  검토된 기대값 1개 중 일치 0 · 변화 1
  미검토 기대값 3개 (사람이 검토해야 계약이 된다)
  매니페스트 오류 0개
  ...
  ls-20261005-163909  (ls)
  [parsed] 10건
    /entries/0/name  value  기대 "WRONG" → 실제 "cli"
```

fixture의 기대값은 다음 형식으로 적습니다.

```json
"expected": {
  "parsed": { "entries": [ … ] },
  "reviewed_by": "이름",
  "note": "이 값이 맞는 이유"
}
```

- 캡처할 때 시크릿, 홈 경로, `--token=` 같은 인자 값을 가리고 가린 내역을 `redactions`에 남깁니다.
- `reviewed_by`가 없는 기대값은 제안으로 취급해 실패로 세지 않습니다.
- 비교는 전체 대조입니다. 기대값에 일부 필드만 적으면 나머지는 모두 `extra`로 보고되므로, 실제 파싱 결과와 같은 모양으로 적어야 합니다.
- `parism test`는 명령을 다시 실행하지 않고, 기대값을 자동으로 고쳐 쓰지도 않습니다.
- 근거 기대값은 적은 포인터만 확인합니다. 전체 대조가 필요하면 `evidence.exhaustive: true`를 둡니다.

매니페스트 형식은 [SPECIFICATION.md](SPECIFICATION.md) §5.2.4에 있습니다.

### parism eval

이 호스트에서 명령이 기대대로 동작하는지 세 층으로 나눠 확인합니다.

| 층 | 확인 내용 |
|---|---|
| `execution` | 실제로 실행됐는지. 가드 차단(`blocked`)과 실행 실패를 구분 |
| `parse` | 구조로 읽었는지. 파서 없음과 파싱 실패를 구분 |
| `task` | 과제를 해냈는지. 없는 것을 찾는 과제는 못 찾아야 성공 |

```bash
parism eval                    # 전체 시나리오
parism eval execution-parse    # 시나리오 하나
parism eval --verbose          # 모든 항목 출력
```

기대와 다른 항목이 하나라도 있으면 종료 코드가 1입니다. 기대값이 없는 항목은 집계에서 빠집니다.

### 외부 파서 격리

등록한 팩은 팩마다 별도 워커 스레드에서 실행됩니다(`parsers.external_isolation: "worker"`).

- 호출 하나가 `external_time_limit_ms`(기본 500ms)를 넘거나, 워커가 죽거나, V8 힙이 `external_memory_limit_mb`(기본 128MB)를 넘으면 `parser_exception`으로 보고합니다. 이후 2초부터 최대 30초까지 늘어나는 대기 시간 동안 그 팩은 바로 실패로 응답하고, 서버는 계속 동작합니다.
- `parse()`의 반환값은 구조화 복제가 가능해야 합니다. 함수, Promise, Symbol이 들어 있으면 `parser_exception`입니다.
- 팩 안의 `console` 출력은 stderr로 갑니다.
- 호출당 복제 비용은 20줄 입력에서 약 0.1ms, 500줄 입력에서 약 1.6ms입니다.
- 메인 스레드에서 실행하려면 전역 설정에 `"parsers": { "external_isolation": "none" }`을 둡니다.

워커 격리는 장애 격리이지 보안 샌드박스가 아닙니다. 워커는 서버와 같은 파일, 네트워크, 환경 변수 권한을 가집니다. 신뢰할 수 없는 팩을 써야 하면 Parism 전체를 컨테이너나 VM 안에서 실행하십시오.

#### Wasmtime capability 샌드박스

팩 디렉터리에 `parser.wasm`(Wasmtime 컴포넌트)과 `contract.json`이 있으면 **샌드박스 경로**로 돕니다.
워커 경로와 성격이 다릅니다.

| | 워커 격리 | 샌드박스 |
|---|----------|--------|
| 성격 | 장애 격리 | **보안 경계** |
| 파일 접근 | 워커의 권한 그대로 | **열어 준 경로만** |
| 네트워크 | 워커의 권한 그대로 | **없음** |
| 환경 변수 | 워커의 권한 그대로 | **열어 준 것만** |
| 메모리 | V8 old generation 만 | 게스트 **선형 메모리** 전체 (기본 10MiB) |
| 시간 | 워커 임계값 | **Wasmtime epoch 타임아웃** (기본 60초) + 연료 상한 |

게스트는 파일·네트워크·환경 변수를 **직접 요구할 수 없습니다.** 호스트가 열어 준 것만 요구할 수 있고,
호스트는 `parsers.external_capabilities` 로 정합니다. **기본값은 비어 있습니다** — 아무것도 열지 않습니다(fail-closed).

```json
{ "parsers": { "external_capabilities": {
  "fs_read": [["/etc", "/etc"]],
  "env": [["LANG", "ko_KR"]]
} } }
```

신뢰하지 않는 프로젝트 설정은 이 값을 **좁힐 수만 있습니다.** 넓히려 한 항목은 경고 후 버립니다.

게스트는 시크릿의 **존재 여부만** 받습니다(`secret-exists`). **값은 주지 않습니다.**

> **이것은 OS 샌드박스가 아닙니다. 경계가 아닙니다.**
> 커널 격리가 아니고 parism과 같은 사용자 권한으로 돕니다.
> **메모리 안전 언어의 한계(로직 취약점)도 그대로 남습니다** — 게스트 안의 버그를 샌드박스가 막지 못합니다.

설계 근거: [`docs/adr/2026-10-22-agent-parser-sandbox.md`](docs/adr/2026-10-22-agent-parser-sandbox.md)

#### 샌드박스 바이너리

샌드박스는 Rust 크레이트라 **별도 프로세스**로 돕니다. 바이너리는 다음 순서로 찾습니다.

1. `PARISM_SANDBOX_BIN` 으로 명시한 경로 (없으면 undefined — 조용히 다른 곳을 찾지 않습니다)
2. `@nerdvana/parism-sandbox-<platform>-<arch>` npm 패키지 (아직 배포하지 않습니다)
3. 저장소에서 직접 빌드한 `crates/parism-sandbox/target/release/parism-sandbox`

```bash
cargo build --release --manifest-path crates/parism-sandbox/Cargo.toml
node scripts/build-sandbox-guest.mjs   # 시험용 게스트 컴포넌트
```

### CLI 명령

| 명령 | 설명 |
|---|---|
| `parism` | MCP 서버 실행 (stdio) |
| `parism capture "<command>"` | 실행 결과를 정제해 fixture로 저장 |
| `parism init-parser <name>` | 파서 팩 스캐폴드 생성 (`parser.ts`, `schema.json`, `fixtures/`) |
| `parism test [dir]` | fixture를 오프라인으로 재생해 차이 보고. 깨진 fixture가 있으면 종료 코드 1 |
| `parism add <path>` | 파서 팩을 `~/.parism/parsers/`에 등록 |
| `parism inspect <command> [args...]` | raw / parsed / compact 비교와 토큰 수 |
| `parism eval [scenario]` | 호스트 동작을 세 층으로 판정 |
| `parism receipts check` | 필요한 명령마다 통과한 최신 영수증이 있는지 판정. 없으면 종료 코드 1 |
| `parism receipts list` | 최근 영수증 목록 |

`parism inspect ls -l /path`처럼 인자를 나눠 주면 그대로 전달됩니다. `parism inspect "ls -l /path"`처럼 문자열 하나로 주면 공백으로 나누므로 따옴표와 연속 공백이 보존되지 않습니다.

---

## 2.0.x에서 2.1.0으로 올릴 때

MCP로 `run`만 호출한다면 바꿀 것이 없습니다. 도구 이름은 그대로이고 도구 3개(`explain_result`, `fetch_result`, `compare_results`)가 추가됐습니다. 아래 경우만 코드나 설정을 고쳐야 합니다.

| 대상 | 이전 | 2.1.0 |
|---|---|---|
| 외부 ParserPack 작성자 | `contract.noise`, `rowLine`, `acceptedValues`가 메인 스레드의 `RegExp` | 워커가 계산한 서술자. 이전 방식이 필요하면 `parsers.external_isolation: "none"` |
| `toCompact()`, `parism inspect` 호출자 | `unknown` 반환 | `CompactOutcome` (`{ok:true,value}` 또는 `{ok:false,reason,message}`) |
| `guard.secrets.output_patterns`를 생략한 설정 | 기본 패턴 미적용 | 기본 패턴 적용. 끄려면 `output_patterns: []` |
| `git status --porcelain` 사용자 | `failure.hint` 안내 대상 | 지원 형식. `entries` 배열로 파싱 |
| porcelain 항목을 그대로 저장하는 코드 | `xy`, `index`, `worktree`, `path`, `orig_path` | `quoted` 필드 추가 (줄 모드에서만 값이 있음) |

`output_patterns` 기본값 변경은 보안 수정입니다. 이전에는 이 키를 생략하면 출력 가리기를 켜도 `sk-`, `ghp_`, `AKIA`, `xoxb-`, `glpat-` 형태의 토큰이 그대로 노출됐습니다.

---

## 범위

- Parism은 셸을 대체하지 않습니다. 기존 명령을 실행하고 그 출력을 구조로 바꿉니다. Terminal-Bench 2.0 과제 20개에서 Bash만 가진 에이전트는 18개를, Bash 없이 Parism만 가진 에이전트는 13개를 통과했습니다(모델 `haiku`, 과제마다 1회). 실패한 과제는 `git` 쓰기 명령이 필요하거나 세션이 끝난 뒤에도 서버가 떠 있어야 했습니다. 재현과 한계: [experiments/README.md](experiments/README.md) 부록 T.
- 보관된 결과를 조회, 이어 읽기, 비교할 때 명령을 다시 실행하지 않습니다. 만료된 결과는 다시 실행해야 합니다.
- 비교는 호출자가 준 두 결과 사이에서만 이뤄집니다. 주기적으로 감시하지 않습니다.
- 영수증은 명령이 어떤 작업 공간 상태에서 어떤 결과로 끝났는지만 기록합니다. 시험이 요구를 제대로 검사하는지는 판단하지 않습니다.
- 태스크는 서버 프로세스 안에서만 삽니다. 서버가 끝나면 실행 중인 태스크의 프로세스도 종료합니다.
- 토큰 예산은 Parism이 만든 JSON 기준입니다. 모델이 실제로 세는 토큰 수를 보장하지 않습니다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
