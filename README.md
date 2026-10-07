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

연결하면 7개 도구가 노출됩니다.

| 도구 | 명령 실행 | 용도 |
|---|---|---|
| `run` | O | 기본 실행. 필터, 예산, 근거 옵션 포함 |
| `run_paged` | O | 큰 출력을 줄 단위 페이지로 읽기 |
| `describe` | X | 환경, 허용 명령, 파서 정보 확인 |
| `dry_run` | X | 가드 통과 여부 미리 확인 |
| `explain_result` | X | 보관한 결과의 값이 원문 어디에서 왔는지 조회 |
| `fetch_result` | X | 예산 때문에 잘린 결과의 다음 페이지 읽기 |
| `compare_results` | X | 보관한 두 결과의 차이 비교 |

`explain_result`, `fetch_result`, `compare_results`는 보관된 결과만 읽고 명령을 다시 실행하지 않습니다. 보관본은 서버 프로세스 메모리에만 있으며 한도는 결과당 2MiB, 합계 32MiB, 최대 16개, 60초입니다. 모르는 id, 만료, 퇴출, 보관하지 않음은 각각 다른 사유로 거절됩니다.

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

`contract_version`, `evidence`, `retain`, `budget`을 지정하지 않으면 응답 형태는 이전 버전과 같습니다.

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
3. **인젝션 패턴**: 인자 하나하나에 셸 메타문자가 있으면 거절합니다.
4. **명령별 인자 제한**: `node -e`, `node --eval`, `node --input-type`, `npx --yes`는 기본으로 막힙니다.

가드는 프로세스 수준의 방어선이며 커널 샌드박스가 아닙니다. 신뢰할 수 없는 환경에서 쓸 때의 격리 방법은 [SECURITY.md](SECURITY.md)에 있습니다.

---

## 지원 명령

43개 명령에 기본 파서가 있습니다. 명령별 결과 필드는 `describe({ cmd: "…" })`로 확인합니다.

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
  }
}
```

| 키 | 설명 |
|---|---|
| `guard.allowed_paths` | 비어 있으면 경로 제한이 없습니다 |
| `guard.profile` | `"readonly"`(기본)는 조회 서브커맨드만 허용합니다. `"build"`는 `npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose ps` 같은 빌드·시험 명령을 추가합니다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 켜십시오 |
| `guard.command_arg_restrictions` | 기본값과 병합됩니다. 일부 명령만 바꿔도 나머지 기본 제한은 남습니다 |
| `guard.command_policies` | 명령별 서브커맨드·플래그 규칙을 덮어씁니다 |
| `guard.secrets.env_patterns` | 이름이 일치하는 환경 변수를 자식 프로세스에서 제거합니다 |
| `guard.secrets.output_redaction_enabled` | `true`면 출력에서 `output_patterns`에 걸리는 값을 `[REDACTED]`로 바꿉니다 |
| `guard.secrets.output_patterns` | 생략하면 기본 패턴(GitHub, GitLab, AWS, Slack 토큰 등)을 씁니다. 끄려면 `[]` |
| `parsers.strict_schemas` | `true`면 파싱 결과를 Zod 스키마로 검증합니다 |
| `telemetry.enabled` | `true`면 응답에 단계별 소요 시간을 붙이고 `describe`에 명령별 통계를 보여 줍니다. 외부로 전송하지 않습니다 |

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

기본 파서가 없는 명령에 파서를 직접 붙일 수 있습니다. Parism은 ESM 전용이고 스키마는 zod 3을 씁니다.

```bash
npm install @nerdvana/parism zod@^3
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

- Parism은 셸을 대체하지 않습니다. 기존 명령을 실행하고 그 출력을 구조로 바꿉니다.
- 보관된 결과를 조회, 이어 읽기, 비교할 때 명령을 다시 실행하지 않습니다. 만료된 결과는 다시 실행해야 합니다.
- 비교는 호출자가 준 두 결과 사이에서만 이뤄집니다. 주기적으로 감시하지 않습니다.
- 토큰 예산은 Parism이 만든 JSON 기준입니다. 모델이 실제로 세는 토큰 수를 보장하지 않습니다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
