# Parism

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

AI 에이전트가 셸 명령을 셸 없이 실행하고 결과를 JSON으로 받게 하는 MCP 서버이자 Node.js 라이브러리입니다.

문서: [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

```json
run({ "command": "ls -la src | grep engine" })
```

```json
{
  "ok": true,
  "cmd": "ls",
  "args": ["-la", "src"],
  "stdout": {
    "raw": "",
    "parsed": {
      "entries": [{ "name": "engine", "type": "directory", "size_bytes": 4096, "permissions": "drwxrwxr-x", "owner": "user", "modified_at": "Nov 12 07:27" }],
      "_summary": { "total": 15, "matched": 1, "shown": 1 }
    }
  }
}
```

- 61개 명령에 파서가 있고, 직접 만든 파서를 더할 수 있습니다.
- 파이프 뒤의 `grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`은 Parism이 파싱된 행에 적용합니다.
- 파싱에 성공하면 `raw`는 비웁니다. 같은 202개 항목의 `ls -la`가 원문 5,448토큰에서 2,061토큰이 됩니다.
- 비밀값 가리기, 명령 허용 목록, 경로 제한을 실행 전후에 적용합니다.

## 설치

```bash
npx @nerdvana/parism          # stdio MCP 서버
```

MCP 클라이언트 설정:

```json
{ "mcpServers": { "parism": { "command": "npx", "args": ["-y", "@nerdvana/parism"] } } }
```

클라이언트별 위치: [Claude Code](docs/mcp-clients/claude-code.md) · [Claude Desktop](docs/mcp-clients/claude-desktop.md) · [Cursor](docs/mcp-clients/cursor.md) · [Gemini CLI](docs/mcp-clients/gemini-cli.md) · [Codex CLI](docs/mcp-clients/codex.md) · [Copilot CLI](docs/mcp-clients/copilot-cli.md)

필요하면 함께 설치합니다.

```bash
npx @nerdvana/parism skill install    # 에이전트 스킬: Parism을 적은 호출로 쓰는 법 (.claude/skills/parism)
npx @nerdvana/parism hook install     # 에이전트의 Bash 호출을 Parism으로 돌리고 확인 없는 종료를 막는다
```

Node.js 20 이상이 필요합니다.

## 도구

| 도구 | 용도 |
|-|-|
| `run` | 명령 실행. 행 고르기·정렬, 태스크와 서비스 시작·조회, 원문 페이지 읽기 |
| `query_result` | 보관한 결과를 다시 실행하지 않고 다시 고르기, 값의 출처(`pointer`), 다음 페이지(`cursor`), 두 결과 비교(`compare_with`) |
| `describe` | 허용 명령, 파서, 가드 확인. `command`를 주면 실행하지 않고 가드 판정만 |

`mcp.surface: "full"`로 두면 2.x의 9개 도구를 씁니다.

### run

| 인자 | 뜻 |
|-|-|
| `command` | 명령 한 줄. 또는 `cmd`와 `args` |
| `cwd` | 작업 디렉터리 |
| `select`, `where`, `sort_by`, `limit` | 행 고르기 |
| `mode` | `"task"`: 오래 걸리는 명령, `"service"`: 서버 |
| `task_id`, `wait_ms`, `cancel` | 태스크·서비스 조회와 중지 |
| `options` | `format`, `include_raw`, `contract_version`, `machine_format`, `aggregate`, `budget`, `retain`, `evidence`, `page`, `page_size`, `ready_port`, `ready_pattern`, `lease_ms`, `persist` 등. 설명은 `describe()`의 `run_options` |

### 명령 한 줄

따옴표, 백슬래시, `~`, 글로브, `#` 주석, 맨 앞의 `cd <dir> &&`, `2>&1`, `2>/dev/null`을 셸처럼 처리합니다. `git -C <dir>`은 그 디렉터리에서 실행합니다.

`$(...)`, `$VAR`, 리다이렉션, `&`, `;`, `&&`, `||`, `VAR=1 명령`은 실행하지 않고 `unsupported_shell_operator`와 대안(`failure.suggestion`)을 돌려줍니다. 명령은 호출 하나에 하나씩 줍니다.

### 행 고르기

```json
{ "command": "ls -l", "where": [{ "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" }, "limit": 10, "select": ["name", "size_bytes"] }
```

- 연산자: `eq` `ne` `prefix` `contains` `gt` `gte` `lt` `lte`
- `_summary`의 `total`은 명령이 낸 행, `matched`는 조건을 통과한 행, `shown`은 돌려준 행입니다. `limit: 0`이면 개수만 받습니다.
- `aggregate: { group_by, sum, distinct }`는 묶음마다 `count`, `sum_<필드>`, `distinct_<필드>`를 냅니다(`contract_version: "next"`).

### 큰 결과

행이 100개를 넘고 `limit`이 없으면 앞 50행과 `result_id`를 돌려줍니다. 나머지는 `query_result({ result_id, where, select, limit })`로 읽습니다. 보관은 300초입니다.

응답이 `mcp.max_response_bytes`(기본 40,000)를 넘으면 `stdout.raw`를 줄 경계에서 자르고 `options.page`로 나머지를 읽게 안내합니다.

### 시험, 빌드, 린트

```json
{ "command": "npx vitest run", "options": { "contract_version": "next", "machine_format": true } }
```

```json
{ "kind": "test", "tool": "vitest", "passed": 41, "failed": 1,
  "failures": [{ "file": "src/math.test.ts", "line": 12, "message": "expected 2 to be 3", "attribution": "modified_line" }] }
```

- 대상: `vitest`, `jest`, `pytest`, `go test`, `cargo test|build|check`, `tsc`, `eslint`, `ruff check`, `mypy`
- 실패와 진단은 모두 싣고, 통과한 항목은 개수만 싣습니다.
- `attribution`은 `git diff HEAD`와 대조한 결과입니다. `modified_line`(바꾼 줄), `modified_file`(바꾼 파일의 다른 줄), `unmodified` 중 하나입니다.
- 러너 뒤의 `| head`, `| tail`은 적용하지 않습니다.

### 태스크와 서비스

```json
{ "command": "cargo test", "mode": "task", "options": { "contract_version": "next" } }
{ "task_id": "task_…", "wait_ms": 30000 }
{ "command": "npm run dev", "mode": "service", "options": { "ready_port": 5173 } }
```

- 태스크는 `tasks.timeout_ms`(기본 10분)까지 실행합니다. `wait_ms`(최대 30초)는 끝나거나 새 실패가 나오면 바로 답합니다.
- 서비스는 `ready_port`나 `ready_pattern`으로 준비를 확인하고, `lease_ms`(최대 5분)가 지나면 종료합니다.
- 동시에 `tasks.max_concurrency`(기본 2)개까지 실행합니다. 슬롯이 차면 `task_slots_full`입니다.

## 실패

`ok: false`이면 `failure.kind`로 나눕니다.

| `kind` | 뜻 | 할 일 |
|-|-|-|
| `guard` | 가드가 막음. 실행하지 않음 | `describe({ cmd })`로 허용 인자 확인 |
| `config` | 셸 문법, 파이프 단계, 필터 인자 오류 | `failure.suggestion`대로 고침 |
| `exec` | 실행 실패, 시간 초과, 명령 없음 | `spawn_failed`면 `failure.availability.install`의 설치 명령 |
| `parse` | 파서가 없거나 그 인자 형식을 읽지 못함 | `stdout.raw`에 원문이 있음. `hint.args`로 다시 실행하면 파싱됨 |

## 가드

실행 전에 차례로 검사합니다.

1. `allowed_commands`에 없는 명령: `command_not_allowed`
2. `allowed_paths` 밖의 작업 디렉터리나 경로 인자: `path_not_allowed`
3. 인자 안의 셸 메타문자: `injection_pattern`. 검색어, 출력 형식, 인터프리터의 인라인 코드(`python3 -c`), SQL, pip 버전 조건은 검사하지 않습니다.
4. 명령별 인자 정책(`node -e`, `npx --yes` 등): `arg_not_allowed`

| 프로필 | git | 그 밖 |
|-|-|-|
| `readonly`(기본) | 조회(`status`, `log`, `diff`, `show`, `branch`, `grep`, `reflog`, …) | 조회 명령 |
| `build`, `ci` | 로컬 쓰기 추가(`init`, `add`, `commit`, `checkout`, `merge`, `rebase`, `reset`, `clone`, `fetch`, `pull`, …) | `npm run`·`test`, `cargo`, `npx`, 작업 공간 안의 실행 파일 |

- `git push`는 `guard.allow_git_remote_write: true`일 때만 허용합니다.
- 모든 git 실행에 `core.hooksPath=/dev/null`과 `core.editor=true`를 붙입니다.
- 가드는 프로세스 수준의 방어선이고 커널 샌드박스가 아닙니다. 격리는 [SECURITY.md](SECURITY.md)에 있습니다.

## 지원 명령

| 분류 | 명령 | 기본 허용 |
|-|-|-|
| 파일 | `ls -l` `find` `stat` `du` `df` `tree` | O |
| 프로세스·네트워크 | `ps` `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | O |
| 텍스트 | `grep -n` `wc` `head` `tail` `cat` | O |
| Git | `git status` `log` `diff` `branch -vv` | O |
| 배포 | `kubectl get` `docker` `gh pr list` `helm list` | O |
| 시스템 | `env` `pwd` `which` `free` `uname` `id` `systemctl` `journalctl` `apt` `brew` `npm list` | O |
| 빌드 | `terraform plan` `cargo` | build 프로필 |
| 시험·진단 | `vitest` `jest` `tsc` `eslint` `pytest` `go test` `ruff` `mypy` | 허용 목록에 추가 |
| 기타 | `pnpm` `yarn` `kill`, Windows `dir` `tasklist` `ipconfig` `systeminfo` | 허용 목록에 추가 |

명령별 결과 필드는 `describe({ cmd: "git" })`로 봅니다. `kubectl -o json`, `docker inspect`처럼 JSON을 내는 명령은 그대로 `parsed`에 들어갑니다.

## 훅

```bash
npx @nerdvana/parism hook install                    # Claude Code, .claude/settings.json
npx @nerdvana/parism hook install --scope user       # ~/.claude/settings.json
npx @nerdvana/parism hook install --client gemini    # .gemini/settings.json
```

| 훅 | 하는 일 |
|-|-|
| `PreToolUse` | 파서가 있는 Bash 명령을 `parism exec`로 바꿔 실행합니다. 허용된 명령의 금지 인자(`git push`)는 막습니다. 읽기 전용 명령만 묻지 않고 실행하고, 나머지는 클라이언트의 권한 규칙을 따릅니다 |
| `SessionStart` | 시작 시점의 작업 공간 상태를 기록합니다 |
| `Stop` | 작업 공간이 바뀌었는데 지금 상태에서 통과한 시험·빌드가 없으면 종료를 막습니다 |

훅 설정은 `~/.parism/hook.config.json`(build 프로필, 영수증과 리댁션 켬)입니다. 렉서가 받지 않는 명령은 원래 셸이 실행합니다.

## 영수증

호스트 설정에 `"receipts": { "enabled": true }`를 두면 실행마다 `~/.parism/receipts/receipts.jsonl`에 명령, 종료 코드, 시험 합계, 작업 공간 상태를 남깁니다. 줄마다 앞 줄의 해시와 HMAC 서명이 붙습니다.

```bash
parism receipts check --require "npx vitest run"   # 지금 작업 공간에서 통과했는지. 아니면 종료 코드 1
parism receipts verify                             # 줄 고침, 삭제, 끼워 넣기 검사
parism receipts export --format github             # markdown, github, sarif, json
```

판정은 `ok`, `missing`, `failed`, `stale`(실행 뒤에 바뀜), `unverifiable`, `bad_signature` 가운데 하나입니다. 서명 키는 `receipts.key_file`, 없으면 `~/.parism/receipts/receipts.key`를 만들어 씁니다. 같은 사용자 계정의 프로세스는 이 키를 읽을 수 있으므로, 영수증을 근거로 삼으려면 키를 에이전트가 읽지 못하는 곳에 둡니다.

## 설정

| 위치 | 범위 |
|-|-|
| `~/.parism/prism.config.json` | 호스트. 모든 키 |
| `<cwd>/prism.config.json` | 프로젝트. 가드를 넓히지 못하고, `results`, `receipts`, `verify`, `stats`, `hook`은 무시 |
| `PARISM_*` 환경 변수 | `PARISM_ALLOWED_COMMANDS`, `PARISM_ALLOWED_PATHS`, `PARISM_TIMEOUT_MS` 등 |

| 키 | 기본 | 뜻 |
|-|-|-|
| `guard.allowed_commands` | 조회 명령 | 실행할 수 있는 명령 |
| `guard.allowed_paths` | 서버를 띄운 디렉터리 | 작업 디렉터리와 경로 인자의 범위. `[]`이면 제한 없음 |
| `guard.profile` | `readonly` | `build`, `ci`는 빌드·시험과 로컬 git 쓰기 |
| `guard.timeout_ms` | 10000 | `run` 한 번의 시간 제한 |
| `guard.secrets.output_redaction_enabled` | `false` | 출력, 파싱 결과, 보관 결과의 비밀값을 `[REDACTED]`로 |
| `output.include_raw` | `false` | 파싱에 성공해도 `raw`를 싣기 |
| `output.auto_retain_rows`, `output.preview_rows` | 100, 50 | 큰 결과 미리보기 |
| `mcp.surface` | `core` | `full`은 2.x 도구 |
| `mcp.max_response_bytes` | 40000 | 응답 한 건의 상한 |
| `tasks.max_concurrency`, `tasks.timeout_ms` | 2, 600000 | 태스크 |
| `receipts.enabled` | `false` | 실행 영수증 |
| `stats.enabled` | `true` | `parism stats`의 사용 통계 |

전체 필드는 [SPECIFICATION.md](SPECIFICATION.md) 6장에 있습니다. `parism doctor`가 설정과 설치 상태를 점검합니다.

## 라이브러리

```typescript
import { createEngine } from "@nerdvana/parism/engine";
const engine = await createEngine();
const result = await engine.run("", { command: "git status" });

import { sh } from "@nerdvana/parism/sdk";
const status = await sh.git.status();                 // 타입이 붙은 결과
const tests  = await sh.vitest.run();                 // 실패마다 attribution
```

가드 거절과 실행 실패는 예외가 아니라 `ok: false` 결과입니다.

## 커스텀 파서

```bash
parism capture "htop -b -n 1"    # 실제 출력을 fixture로 저장
parism init-parser htop           # 파서 팩 생성
parism test ~/.parism/fixtures    # fixture로 파서 검증
parism add ./htop                 # 등록
```

등록한 팩은 팩마다 워커 스레드에서 실행됩니다(장애 격리). 인터페이스와 fixture 형식은 [SPECIFICATION.md](SPECIFICATION.md) 5장에 있습니다.

## CLI

| 명령 | 하는 일 |
|-|-|
| `parism` | MCP 서버 |
| `parism exec -- "<명령>"` | 명령 한 줄을 Parism으로 실행하고 셸처럼 출력 |
| `parism hook install` | 훅 설치 |
| `parism skill install [--scope user]` | 에이전트 스킬 설치 |
| `parism receipts check\|list\|verify\|export` | 영수증 |
| `parism stats`, `parism doctor` | 사용 통계, 설정 점검 |
| `parism capture`, `init-parser`, `test`, `add`, `inspect`, `eval` | 커스텀 파서 |

## 2.x에서 3.0으로

| 대상 | 2.x | 3.0 |
|-|-|-|
| MCP 도구 | 9개 | `run`, `query_result`, `describe`. 이전 도구는 `"mcp": { "surface": "full" }` |
| `stdout.raw` | 항상 | 파싱에 성공하면 비움. `include_raw: true`로 되돌림 |
| 큰 결과 | 500행까지 전부 | 100행을 넘으면 앞 50행과 `result_id`. `"output": { "auto_retain_rows": 0 }`이면 이전처럼 |
| `run` 고급 옵션 | 최상위 인자 | `options` 안 |
| 태스크 조회 | `task({ task_id })` | `run({ task_id, wait_ms })` |
| 리댁션 범위 | `raw`, `stderr` | 파싱 결과와 보관 결과까지 |
| 영수증 | `key_file`이 있을 때만 서명 | 해시 체인과 자동 키 서명 |

나머지 변경은 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
