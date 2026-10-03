# parism SPECIFICATION

작성자: 최진호
작성일: 2026-04-15
버전: v1.0.0

---

## Context

1969년 Ken Thompson이 Unix를 설계할 때 출력 대상은 사람이었다. 커널은 파일시스템 메타데이터를 구조체(`inode`, `mode`, `uid`, `gid`)로 관리하지만 `ls`는 그 구조를 인간이 읽기 좋은 텍스트로 평탄화한다. AI 에이전트는 그 텍스트를 다시 구조로 되돌리려 한다. 한 번 버려진 구조를 재구성하는 데 추론 단계와 토큰이 소모된다.

parism은 두 번째와 세 번째 번역 사이에 개입한다. 셸 없이 명령을 직접 실행하고, 결과를 결정론적 파서로 구조화하여 `ResponseEnvelope`로 반환한다. 에이전트는 `stdout.parsed`를 읽기만 하면 된다. 파서가 없거나 실패해도 `stdout.raw`가 항상 보존된다.

v0.6.0-alpha.1 기준으로 parism은 두 배포 면을 지원한다. FastMCP 기반 stdio 서버로 에이전트와 MCP 프로토콜로 통신하는 방식과, `@nerdvana/parism/engine` 서브패스 export로 Node.js 소비자가 in-process로 직접 사용하는 라이브러리 모드. 두 면 모두 동일한 `ParismEngine` 인스턴스에 위임하므로 비즈니스 로직 drift가 없다.

---

## 변경 이력 (v0.1 → v0.6.0-alpha.1)

| 버전 | 일자 | 결정 | 근거 | 대안 |
|---|---|---|---|---|
| v1.0.0 | 2026-04-15 | 첫 stable 릴리스 — v0.6.0-alpha 의 모든 개선 통합 | alpha 레이블이 작업 규모에 비해 과보수적이며, API 안정성 공약을 명시화할 필요 | v0.7.0 경유 유지 / v1.0.0-rc.1 경유 |
| v0.1 | 2026-03-06 | MCP 서버 + `execFile` 게이트웨이 초기 구조 | 셸을 거치지 않는 프로세스 실행으로 인젝션 원천 차단 | `child_process.spawn` + shell 옵션 |
| v0.2 | 2026-03-07 | Guard 4겹 방어선 도입, compact 포맷, native JSON 패스스루 | Guard 경로 인자 검증 미비 수정; compact로 리스트 출력 토큰 절감 [^1] [^2] | 단일 allowlist 방어만 유지 |
| v0.3 | 2026-03-07 | 44종 내장 파서 확장, `ResponseEnvelope` 정식 계약, 페이지네이션 | 에이전트 시스템 관리 명령 지원 확대; `run_paged`로 대용량 출력 처리 [^1] | 파서 없이 raw 전달만 |
| v0.4 | 2026-03-12 | piped-only compact 포맷 기본 활성화, `allowed_paths` 기본값 `[process.cwd()]`, `command_arg_restrictions` 기본값 병합 | v0.3 비판적 검토에서 보안·성능·문서 정합성 결함 지적 수용 [^3] | breaking change 연기 |
| v0.5 | 2026-03-28 | `ParserPack` SDK, CLI 5개 명령어 (`capture`/`init-parser`/`test`/`add`/`inspect`), `createRegistry` DI 팩토리 | 사용자 커스텀 파서 로컬 개발 루프 완성; `defaultRegistry` 싱글턴에서 DI 패턴 전환 [^4] | 싱글턴 유지 |
| v0.6.0-alpha.1 | 2026-04-15 | `failure` 필드 통합, `guard.secrets` 설정 통합, Zod `ParserPack` 스키마 계약, 출력 레덕션 레이어, `ParismEngine` 파사드, `SECURITY.md` 명문화 | prolog-reasoner 벤치마킹 분석 후 2-AI 적대적 검토 합성 결과 | `meta.error_code` 신설 (Copilot 지적으로 철회) / Facade 미도입 (Gemini YAGNI 지적 — ROI 재구성으로 부활) / `allowed_commands` 기동 선검증 (삭제됨) |

[^1]: 근거: [docs/plans/2026-03-06-benchmark.md](docs/plans/2026-03-06-benchmark.md)
[^2]: 근거: [docs/plans/2026-03-07-safe-os-gateway.md](docs/plans/2026-03-07-safe-os-gateway.md)
[^3]: 근거: [docs/plans/2026-03-12-feedback-critical-acceptance.md](docs/plans/2026-03-12-feedback-critical-acceptance.md)
[^4]: 근거: [docs/plans/2026-03-28-parser-sdk-phase1.md](docs/plans/2026-03-28-parser-sdk-phase1.md)

---

## 1. 아키텍처

### 1.1 두 배포 면 (MCP 서버 + 라이브러리)

```
┌─────────────────────────────────────────────────┐
│                   소비자                         │
│                                                 │
│   AI 에이전트 (MCP)        Node.js 코드          │
│   run / run_paged          import engine         │
└──────────┬───────────────────────┬──────────────┘
           │                       │
    ┌──────▼──────┐        ┌───────▼──────┐
    │  server.ts  │        │  facade/     │
    │  (FastMCP)  │        │  engine.ts   │
    │  stdio 서버  │        │  ParismEngine│
    └──────┬──────┘        └───────┬──────┘
           │                       │
           └───────────┬───────────┘
                       │ 위임
              ┌────────▼────────┐
              │   ParismEngine  │
              │  run / runPaged │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
    ┌─────▼────┐ ┌─────▼────┐ ┌────▼──────┐
    │  guard   │ │ executor │ │ parsers   │
    │  4겹 검사 │ │spawn     │ │ registry  │
    └──────────┘ └──────────┘ └───────────┘
                                    │
                              ┌─────▼──────┐
                              │ redactor   │
                              │ (opt-in)   │
                              └────────────┘
```

MCP 서버: `src/server.ts` + `src/index.ts`가 `@modelcontextprotocol/sdk` 기반 stdio 서버를 제공한다. 에이전트가 `run` / `run_paged` 도구로 호출한다.

라이브러리 모드 (v1.0.0부터 안정 API): `src/facade/engine.ts`의 `ParismEngine`을 직접 import하여 in-process 사용한다. `import { createEngine } from "@nerdvana/parism/engine"`. `ResponseEnvelope` 계약과 `ParismEngine` API는 Semantic Versioning을 따른다. v2.0.0의 breaking change는 CHANGELOG에 있으며, 다음 breaking change는 v3.0.0에서만 이루어진다.

두 면은 동일한 `ParismEngine`에 위임한다. `server.ts`의 `buildRunResult` / `buildPagedResult`는 `ParismEngine.run` / `runPaged`를 래핑하는 얇은 직렬화 레이어다.

### 1.2 모듈 레이어 (단방향 DAG)

```
src/types/          (envelope.ts — 계약 타입만)
src/config/         (loader.ts — 설정 파싱/병합/마이그레이션)
src/engine/         (guard.ts, executor.ts, redactor.ts, paginator.ts, state-tracker.ts, telemetry.ts)
src/parsers/        (registry.ts, compact.ts, json-passthrough.ts, 44종 파서)
src/facade/         (engine.ts — ParismEngine 클래스)
src/server.ts       (MCP 도구 정의, 직렬화)
src/version.ts      (PACKAGE_VERSION 상수 — 순환 의존성 방지)
src/index.ts        (진입점 — MCP 서버 / CLI 분기)
```

임포트 방향은 항상 위에서 아래다. `server.ts`가 `engine/`을 직접 import하지 않는다. `facade/engine.ts`를 통해 접근한다. `engine/`은 `parsers/`를 알지 못하며, `server.ts`가 파이프라인을 조립한다.

---

## 2. 도구 설계 (MCP Tools)

### 2.1 run

모든 명령의 기본 도구. Guard 검사 → 실행 → 파서 → 레덕션(opt-in) 파이프라인을 실행한다.

파라미터:

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `cmd` | string | 필수 | 명령어 이름 (예: `ls`, `git`) |
| `args` | string[] | `[]` | 인자 배열 |
| `cwd` | string | `process.cwd()` | 작업 디렉토리 |
| `format` | `json`\|`compact`\|`json-no-raw` | `json` | 출력 형식 |
| `includeDiff` | boolean | `false` | 파일시스템 diff 포함 여부. `false`이면 스냅샷 생략으로 지연 감소 |

`format=compact`: 파서 결과의 객체 배열 필드를 `{ schema: string[], rows: unknown[][] }` 컬럼 형식으로 압축한다.
`format=json-no-raw`: `stdout.raw`를 빈 문자열로 치환한다. 파서를 신뢰하는 경우 토큰을 절감한다. 파서 부재 시 디버깅이 불가능하므로 기본값으로 사용하지 말 것.

### 2.2 run_paged

대용량 출력을 페이지 단위로 읽는다. `ps aux`, `find`, `grep -r` 등에 사용한다.

추가 파라미터:

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `page` | int (≥0) | `0` | 0-indexed 페이지 번호 |
| `page_size` | int (≥1) | `guard.default_page_size` (기본 100) | 페이지당 줄 수. `guard.max_page_size`(기본 1000)를 넘으면 그 값으로 줄인다 |

`run_paged`는 파서를 실행하지 않는다. `stdout.parsed`는 항상 `null`이다. 부분 출력은 구조화 파싱이 불가능하다.

`run_paged`는 스트리밍이 아니다. 명령의 전체 stdout을 실행 완료까지 메모리에 적재한 뒤 페이지 단위로 잘라 반환한다(`page`/`page_size`는 응답 절삭일 뿐 실행 범위 절삭이 아니다). 실행 단계에는 `max_output_bytes`를 적용하지 않으므로 실행 단계의 상한은 실행기의 스트림별 버퍼 상한(10MB, `src/engine/executor.ts`)이다. 전체 stdout이 10MB를 넘으면 실행이 중단되고 `failure.reason="output_overflow"` 봉투가 반환된다. 잘라낸 페이지의 stdout과 stderr에는 `max_output_bytes`를 적용하며, 넘으면 마지막 완전한 줄까지 남기고 `truncated: true`를 표시한다.

응답에 `page_info` 필드가 추가된다:
- `page_info.page`: 현재 페이지 (0-indexed)
- `page_info.page_size`: 적용한 페이지 크기
- `page_info.requested_page_size`: 요청한 `page_size`가 `guard.max_page_size`를 넘어 줄였을 때만 있는 원래 요청값. `guard.default_page_size`는 설정을 읽을 때 `max_page_size` 이하로 줄이므로 `page_size`를 주지 않은 요청에는 나타나지 않는다
- `page_info.total_lines`: stdout 전체 줄 수
- `page_info.has_next`: 다음 페이지 존재 여부
- `page_info.cache`: `{ hit, age_ms }`. `page=0`은 항상 새로 실행해 저장하고, `page>0`은 같은 (명령, 인자, 실경로 cwd) 결과가 30초 안에 있으면 재실행 없이 재사용한다. 최대 16항목, LRU

### 2.3 describe

에이전트 온보딩 도구. 현재 환경의 허용 명령, 사용 가능 파서, guard 제한, 버전 정보를 반환한다.

파라미터: 없음.

응답 (`DescribeResult`):

| 필드 | 타입 | 설명 |
|---|---|---|
| `version` | string | Parism 패키지 버전 |
| `allowed_commands` | string[] | guard에서 허용하는 명령 목록 |
| `available_parsers` | string[] | 등록된 파서 이름 목록 |
| `guard_summary` | object | `timeout_ms`, `max_output_bytes`, `block_patterns`, `allowed_paths`, `command_arg_restrictions`, `profile`(`readonly` 또는 `build`), `policies`(명령별 유효 정책: `subcommands`, `flags`, `positionals`) |
| `telemetry_enabled` | boolean | 텔레메트리 활성화 여부 |

에이전트가 Parism을 처음 사용하거나 가용 명령을 탐색할 때 호출한다. 실행 파이프라인을 거치지 않는다.

### 2.4 dry_run

guard 사전 검증 도구. 명령을 실행하지 않고 guard 통과 여부만 확인한다.

파라미터:

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `cmd` | string | 필수 | 명령어 이름 |
| `args` | string[] | `[]` | 인자 배열 |
| `cwd` | string | `process.cwd()` | 작업 디렉토리 |

응답 (`DryRunResult`):

| 필드 | 타입 | 설명 |
|---|---|---|
| `would_pass` | boolean | guard 통과 여부 |
| `reason` | string\|null | 차단 시 사유 (`command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`). 정책 거부는 `arg_not_allowed`이고 메시지에 차단된 인자와 정책 출처(`default`, `build`, `config`)가 들어간다. `build` 프로필 전용 명령은 `command_not_allowed`다 |
| `message` | string\|null | 차단 시 상세 메시지 |

`dry_run`은 프로세스를 생성하지 않으며, 파서를 실행하지 않는다. guard 검사만 수행한다.

---

## 3. ResponseEnvelope 계약

### 3.1 기본 필드

`src/types/envelope.ts`에 정의된다. 모든 응답이 따르는 봉투 구조다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `ok` | boolean | 실행 성공 여부 (`exitCode === 0`) |
| `exitCode` | number | 프로세스 종료 코드. Guard 차단 시 `-1` |
| `cmd` | string | 실행한 명령어 |
| `args` | string[] | 실행 인자 |
| `cwd` | string | 실행 시 작업 디렉토리 |
| `duration_ms` | number | 실행 시간 (밀리초) |
| `stdout` | OutputField | raw 원본 + parsed 구조화 결과 |
| `stderr` | OutputField | raw 원본 + parsed (항상 null) |
| `diff` | DiffField\|null | `includeDiff=true`일 때만 채워짐. `created[]`, `deleted[]`, `modified[]` |
| `truncated` | boolean? | stdout이 `max_output_bytes`로 잘렸을 때 `true` |
| `page_info` | PageInfo? | `run_paged` 사용 시에만 채워짐 |
| `failure` | FailureInfo? | 정규화된 실패 정보 (v0.6 신설) |
| `telemetry` | TelemetryField? | `config.telemetry.enabled=true` 시에만 포함. 파이프라인 단계별 성능 메트릭 |

`TelemetryField`:
```typescript
{ guard_ms: number; exec_ms: number; parse_ms: number; redact_ms: number; total_ms: number; raw_bytes: number }
```

모든 시간 값은 `performance.now()` 기반이며 소수점 2자리까지 반올림된다. `raw_bytes`는 `Buffer.byteLength(raw, "utf8")`로 계산한다.

`OutputField`:
```
{ raw: string; parsed: unknown | null; parse_error?: ParseErrorField }
```

`raw`는 레덕션이 활성화된 경우를 제외하고 항상 원본을 보존한다.

### 3.2 실패 계약 — failure 필드 (v0.6 신설)

`ResponseEnvelope.failure?: FailureInfo`는 guard / exec / parse / config 네 종류의 실패를 단일 접점에서 표면화한다. 기존 `guard_error` 필드는 하위 호환을 위해 유지되지만, 새 소비자는 `failure`를 권위 필드로 사용한다.

`FailureInfo`:
```typescript
{
  kind:    "guard" | "exec" | "parse" | "config";
  reason:  string;
  message: string;
  hint?:   { args: string[]; reason: string };   // reason=unsupported_format일 때만
}
```

| kind | reason | 트리거 | ok |
|---|---|---|---|
| `guard` | `command_not_allowed` | `allowed_commands` 미포함 명령, 또는 `build` 프로필에서만 정책이 있는 명령 | false |
| `guard` | `path_not_allowed` | `allowed_paths` 밖 cwd 또는 경로 인자 | false |
| `guard` | `injection_pattern` | `block_patterns` 일치 인자 | false |
| `guard` | `arg_not_allowed` | `command_arg_restrictions` 차단 플래그, 또는 명령 정책에 없는 서브커맨드·플래그·위치 인자·값 | false |
| `exec` | `timeout` | `timeout_ms` 초과. POSIX에서는 프로세스 그룹 전체를 종료한다 | false |
| `exec` | `spawn_failed` | `ENOENT` 또는 `EACCES` (바이너리 없음/권한) | false |
| `exec` | `output_overflow` | 출력이 실행기 버퍼 상한(10MB)을 넘음 | false |
| `exec` | `non_zero_exit` | 비정상 종료 코드 | false |
| `parse` | `parser_exception` | 파서 함수가 예외 던짐 || true |
| `parse` | `parser_not_found` | 등록된 파서 없고 native JSON도 아님 | **true** (정보성) |
| `parse` | `schema_violation` | `strict_schemas=true`이고 Zod 검증 실패 || true |
| `parse` | `unsupported_format` | 인자가 파서 계약의 형식 선언(5.1) 밖이거나 `supports(args)`가 거부함 || true |
| `parse` | `unrecognized_output` | 데이터 줄이 있는데 파서가 어떤 값도 인식하지 못함 || true |
| `config` | (예약) | v0.6에서 트리거 없음, 향후 확장 | — |

`kind=parse, reason=unsupported_format`이면 파서를 실행하지 않는다. `stdout.raw`는 그대로이고, 출력 전체가 JSON 문서이면 native JSON 폴백이 `parsed`를 채우며 이때는 실패로 노출하지 않는다. 같은 명령에서 같은 정보를 내장 파서나 native JSON 폴백이 처리하는 형식으로 얻는 인자가 있으면 `failure.hint`(같은 값이 `stdout.parse_error.hint`)에 담긴다. `hint.args`는 명령 이름을 뺀 전체 인자이며 readonly 기본 정책을 통과한다. 예: `uname -r` → `["-a"]`, `git log --oneline --graph` → `["log", "--format=%h %s"]`, `git log -n 3` → `["log", "-n", "3", "--format=%h%x09%an%x09%aI%x09%s"]`(작성자, 작성 시각 포함), `git status -s --ignored` → `["status", "--ignored"]`, `kubectl get pods -o yaml` → `["get", "pods", "-o", "json"]`, `git log --oneline --decorate` → `["log", "--oneline", "--decorate=full"]`, `git diff --stat HEAD~1` → `["diff", "HEAD~1"]`(패치에 경로, 변경 종류, 바뀐 줄이 있다), `git branch --show-current` → `["branch", "-v"]`, `grep -r TODO src` → `["-n", "-r", "TODO", "src"]`, `ps -e` → `["aux"]`, `systemctl status cron` → `["list-units", "--all", "cron.service"]`. 같은 정보를 얻는 인자가 없으면(`ls -li`, `ps -ef` 등) `hint`가 없다.

`kind=parse, reason=parser_not_found`는 `ok=true`를 유지한다. 파서 부재는 실행 실패가 아니라 구조화 파싱 불가 알림이다. `stdout.raw`는 정상 보존된다. `ok`는 실행 결과만 나타내므로 `kind=parse`인 실패는 모두 `ok=true`다.

`kind=parse` 실패는 실행이 성공했을 때만 `failure`가 된다. 실행이 실패했거나(`non_zero_exit`, `timeout`, `spawn_failed`, `output_overflow`) 종료 코드가 0이어도 stdout이 비고 stderr만 있으면, 파싱 오류는 `stdout.parse_error`에만 남고 `failure`는 실행 결과의 것(`kind=exec`와 stderr를 담은 메시지, 실행이 성공했으면 없음)이다. 예: 이름을 풀지 못한 `ping -c 1 no-such-host.invalid`는 `failure = { kind: "exec", reason: "non_zero_exit" }`이고 `stdout.parse_error.reason = "unrecognized_output"`이다. 이때 `unsupported_format`의 안내는 `stdout.parse_error.hint`에만 있다.

`kind=exec, reason=non_zero_exit`는 프로세스 종료 코드가 0이 아닌 모든 경우를 포함한다. `timeout_ms`가 지나 종료시킨 실행은 `timeout`, 버퍼 상한 초과는 `output_overflow`로 분류한다. 분류 로직은 `src/engine/executor.ts`에 위치한다.

실행기는 셸 없이 `spawn`으로 프로세스를 띄운다. POSIX에서는 자식을 새 프로세스 그룹으로 띄우고, 시간 초과나 버퍼 상한 초과 시 그룹 전체에 SIGKILL을 보내 자식이 띄운 프로세스도 남기지 않는다. 종료시킨 뒤에는 자식이 끝나고 200ms가 지나면 stdout, stderr 스트림을 닫고 결과를 확정하므로, 그룹 밖으로 분리된 자손이 출력 파이프를 갖고 있어도 결과 반환이 늦어지지 않는다. 실행 중인 프로세스 그룹은 추적해 SIGINT, SIGTERM 수신과 프로세스 종료 시 종료한다. 동시에 실행하는 자식 프로세스 수는 `guard.max_concurrency`(기본 4)로 제한하며, 넘는 요청은 자리가 날 때까지 대기한다. 검증하지 않은 설정 객체로 엔진을 만들 때 이 값이 1 미만이면 1로, 유한한 수가 아니면 4로 본다.

---

## 4. Guard — 4겹 방어선

Guard는 에이전트가 생성한 명령이 시스템에 예상치 못한 범위로 실행되는 것을 막는 가드 수준 방어선이다. 커널 샌드박스가 아니며, 각 레이어에는 한계가 있다. 상세 위협 모델은 [SECURITY.md](SECURITY.md) 참조.

### (a) 화이트리스트

`guard.allowed_commands`에 없는 명령은 프로세스를 생성하지 않는다. 프로세스를 띄우기 전에 차단하므로 어떤 실행도 발생하지 않는다.

한계: 화이트리스트 범위가 너무 넓으면 (`bash`, `sh`, `python` 등 포함 시) 방어 효과가 크게 줄어든다.

### (b) 경로 제한

`guard.allowed_paths`가 설정된 경우 두 가지를 검사한다.

1. `cwd`가 허용 경로의 하위인지 (`path.resolve` 후 접미 슬래시 기반 prefix 비교)
2. 경로 인자: 정책이 있는 명령과 없는 명령이 같은 규칙(`collectPathCandidates`, `src/engine/guard.ts`)을 쓴다.
   - 정책의 위치 인자 규칙이 `path`인 위치 인자와 `path` 종류 플래그 값은 형식과 관계없이 검사한다.
   - 그 밖의 위치 인자와 플래그 값은 `/`를 포함하거나 `.`, `~`로 시작하거나 `cwd` 기준으로 존재하는 항목(심볼릭 링크 포함)을 가리키면 검사한다. 중간에 `..`가 있는 상대경로(`a/../../x`)와 허용 경로 밖을 가리키는 링크 이름도 여기에 걸린다.
   - `key=값`, `+opt=값` 형태의 위치 인자는 첫 `=` 뒤 값이 `/`를 포함하거나 `.`, `~`로 시작하면 그 값도 검사한다. 위치 인자 규칙이 `url`인 명령과 정책에 `textPositionals`가 있는 명령(`grep`, `echo`)은 제외한다.
   - 정책이 없는 명령은 어느 플래그가 값을 받는지 모르므로 `--x=값`의 값과, 짧은 플래그 묶음(`-abVALUE`)에서 각 글자 뒤 나머지를 값 후보로 본다. `build` 프로필의 `node`, `npx`가 대상 프로그램 몫으로 넘기는 인자도 같은 방식으로 본다.
   - 서브커맨드, 앞에 오는 전역 플래그, 하위 동사(`gh pr list`의 `list`)는 경로 후보가 아니다.

비교는 심볼릭 링크를 해석한 실경로로 한다. 프로젝트 설정의 `allowed_paths`는 실경로로 바꿔 전역 기준 경로 안에 있는 항목만 남긴다.

`allowed_paths`가 빈 배열이면 경로 제한이 생략된다. 기본값은 `[process.cwd()]`다 (서버 시작 시점 CWD).

한계: 커널 레벨 강제가 아니다. 경로를 직접 받지 않는 명령(`env`, `uname`)에는 경로 검사가 적용되지 않는다.

### (c) 인젝션 패턴 차단

각 인자를 개별적으로 순회하며 `block_patterns`에 포함된 패턴이 있는지 검사한다. 기본 패턴: `;`, `$(`, `` ` ``, `&&`, `||`, `>`, `>>`, `<`, `|`.

인자 단위 검사이므로 서로 다른 인자의 경계를 넘어서는 오탐이 발생하지 않는다 (예: `["foo>", ">bar"]`가 `>>`로 오탐되지 않음).

`execFile`의 구조적 셸 분리를 보완한다. 바이너리가 인자를 내부적으로 셸에 위임하는 경우까지 막지는 못한다.

### (d) 명령별 인자 제한

`guard.command_arg_restrictions`에 명령별 `blocked_flags`를 등록한다. `--flag=value` 형태는 `=` 앞의 플래그 이름만 추출하여 비교한다.

기본 차단 플래그:
- `node`: `-e`, `--eval`, `-r`, `--require`, `-p`, `--print`, `--input-type`
- `npx`: `--yes`, `-y`
- `curl`: `-d`, `--data`, `-F`, `--upload-file`, `-T`, `-K`, `--config`, `-o`, `--output`, `-O`

`command_arg_restrictions`는 사용자 설정과 기본값을 키 단위로 깊은 병합한다. 일부 명령만 override해도 나머지 기본 제한이 유실되지 않는다.

---

## 5. Parser SDK

### 5.1 ParserPack 인터페이스

`src/parsers/registry.ts`에 정의된다.

```typescript
export interface ParserPack extends ParserContract {
  name:      string;
  parse:     (raw: string, args: string[], ctx?: ParseContext) => unknown;
  schema:    z.ZodTypeAny;
  fixtures:  Fixture[];
  meta?:     { os?: string[]; version?: string };
}

type FlagArity = "bool" | "value" | "attached";

export interface ParserContract {
  // 입력 형식 선언
  acceptedFlags?:       Record<string, FlagArity>;
  acceptedValues?:      Record<string, RegExp>;
  acceptedPositionals?: { min?: number; max?: number; pattern?: RegExp };
  requiredFlags?:       string[];
  exclusiveFlags?:      string[];
  leadingFlags?:        Record<string, FlagArity>;
  subcommands?:         Record<string, ParserContract>;
  plusFlags?:           boolean;
  singleDashLong?:      boolean;
  supports?:            (args: string[]) => boolean;
  hint?:                (rest: string[]) => { args: string[]; reason: string; native?: boolean } | null;
  // 출력 모양
  headerLines?:         number;
  noise?:               RegExp;
  rowsKey?:             string;
  rowLine?:             RegExp;
  rowFields?:           string[];
  nulRecords?:          boolean;
  blankRecords?:        boolean;
  outputFlags?:         Record<string, Pick<ParserContract, "headerLines" | "noise" | "rowsKey" | "rowLine" | "rowFields" | "nulRecords" | "blankRecords">>;
}
```

계약 필드는 모두 선택이다.

입력 형식 선언은 파서가 출력 형식을 검증한 인자 범위다. 선언(`acceptedFlags`, `acceptedPositionals`, `subcommands` 가운데 하나)이 있으면 그 밖의 인자는 파서를 실행하지 않고 `parse_error.reason="unsupported_format"`을 반환하며, 메시지에 원인 인자를 밝힌다. 선언이 없으면 인자를 제한하지 않는다.
- `acceptedFlags`: 플래그 이름과 값 방식. `bool`은 값이 없고, `value`는 붙은 값(`--x=v`, `-xv`)이나 다음 인자를 값으로 받으며, `attached`는 붙은 값만 받는다(`--color=never`, `-U0`). 단문자 묶음(`-la`)은 글자마다 나눠 검사한다. `-5` 같은 숫자 축약은 `"-<number>"` 이름으로 선언한다. `--` 뒤는 모두 위치 인자다.
- `acceptedValues`: 플래그 값 패턴. `requiredFlags`: 이 가운데 하나 이상이 있어야 한다(`ls`의 `-l`). `exclusiveFlags`: 이 가운데 하나까지만 받는다(`id`의 `-u`, `-g`, `-G`).
- `acceptedPositionals`: 위치 인자 개수(`min`, `max`)와 모든 위치 인자가 일치해야 하는 `pattern`.
- `leadingFlags`: 서브커맨드 앞에 올 수 있는 전역 옵션(`git --no-pager`, `git -C <경로>`). 선언은 서브커맨드 위치를 찾는 데 쓰며 허용 여부는 guard 정책이 정한다. 기본 정책은 `git`의 전역 옵션으로 `--no-pager`만 받는다(`-c`로 출력 설정을 바꾸면 파서가 처리하지 못하는 출력이 나올 수 있다). `subcommands`: 서브커맨드 낱말(`"log"`, `"pr list"`)별 계약으로, 상위 계약에 덧씌운다. 빈 문자열 키는 서브커맨드 없이 실행한 경우다. 서브커맨드를 선언한 명령에서 선언 밖의 서브커맨드는 `unsupported_format`이다.
- `plusFlags`: `+`로 시작하는 인자를 플래그로 본다(`dig +tcp`, `lsof +D`). `singleDashLong`: 단일 대시 긴 이름(`find -name`)을 묶음으로 나누지 않는다.
- `supports(args)`: 선언으로 표현하기 어려운 조건. 선언 검사를 통과한 뒤 추가로 적용하며 `false`면 `unsupported_format`이다.
- `hint(rest)`: 서브커맨드 다음 인자를 받아 같은 정보를 얻는 대체 인자를 제안한다. 레지스트리는 앞쪽 전역 옵션과 서브커맨드를 다시 붙이고, `native`가 아닌 제안은 같은 계약의 형식 검사를 통과해야 `parse_error.hint`로 내보낸다.

출력 모양 필드는 실패 판정과 불변식 검사에 쓰인다. `headerLines`는 데이터가 아닌 머리 줄 수, `noise`는 합계·범례·안내 문구 같은 비데이터 줄의 패턴이다. 머리 줄과 noise 줄을 제외하고 데이터 줄이 남는데 파서 결과에 인식된 값이 하나도 없으면 `parse_error.reason="unrecognized_output"`을 반환한다. 머리 줄만 있거나 출력이 비어 있는 경우는 정상적인 빈 결과로 보며 `unrecognized_output`이 아니다. 출력이 비어 있으면 결과를 낼 수 없는 파서(`ping`, `id`, `curl -I`)는 빈 출력에서 `unrecognized_output`을 내지만, 그런 실행은 대개 실패한 실행이므로 `failure`는 실행 실패를 유지한다(3.2절). `rowsKey`는 데이터 줄 하나당 행 하나를 담는 결과 배열의 키, `rowLine`은 데이터 줄 가운데 행이 되는 줄의 패턴(없으면 모든 데이터 줄), `rowFields`는 행 객체가 가질 수 있는 필드 이름이다. `nulRecords`면 행이 줄바꿈 대신 NUL로 끝난다. `blankRecords`면 빈 줄과 공백만 있는 줄도 데이터 줄이며 마지막 종결 문자 뒤의 빈 조각만 뺀다(`grep -v`나 빈 패턴의 일치 줄). `outputFlags`는 플래그 이름이나 `"이름=값"`을 키로 하는 출력 모양 표이며, 인자에 그 플래그가 있으면 값의 필드를 유효 계약에 덧씌운다(`find`의 `-print0`, `du`의 `-0`, `grep`의 `-Z`는 `nulRecords`, `wc`의 `--total=only`는 행 배열 없음).

`src/parsers/invariants.ts`의 `checkInvariants(parsed, raw, contract)`는 파싱 결과를 원본과 계약으로 대조해 위반 목록을 돌려준다. `silent_empty`(데이터 줄이 있는데 결과가 비었다), `row_count`(`rowsKey` 배열 길이와 행 줄 수가 다르다. `_summary.truncated`면 `_summary.total`과 비교), `non_finite`(NaN, Infinity), `field_names`(`rowFields` 밖의 필드)를 판정한다. 출력 전체가 JSON 배열 문서이면(`gh pr list --json`) 행 수는 배열 원소 수다. 런타임에는 `unrecognized_output` 판정만 이 모듈을 쓰고, 나머지는 시험에서 쓴다. `ParserRegistry.contractFor(cmd, args)`가 서브커맨드와 `outputFlags`를 반영한 유효 계약을 돌려준다.

내장 파서의 계약은 `src/parsers/contracts.ts`에 있다. 허용 플래그는 실측으로 처리를 확인한 것만 둔다. 형식과 무관한 파서(`head`, `tail`, `cat`, `kill`)와 실측하지 못한 명령(`tree`, `terraform`, `brew`, `pnpm`, `yarn`, `tasklist`, `ipconfig`, `systeminfo`)에는 형식 선언이 없다.

파서는 출력에서 값을 얻을 수 없거나 줄 해석이 모호하면 `UnrecognizedOutputError`(`src/parsers/registry.ts`)를 던진다. 레지스트리는 이 예외를 `parser_exception`이 아닌 `unrecognized_output`으로 보고한다. 기본값을 채운 결과 객체를 돌려주지 않기 위한 장치로, `ping`(통계 줄 없음), `id`(uid, gid 없음), `curl -I`(상태 줄 없음), `lsof`(머리 줄 없음), `env`(NAME=value가 아닌 줄), `grep`(-r 단일 피연산자의 파일 여부를 가릴 수 없음), `wc`(개수 열 수가 인자와 맞지 않는 줄)가 쓴다.

내장 파서의 선택 출력 필드는 해당 형식일 때만 나타난다.

| 파서 | 선택 필드 | 의미 |
|-|-|-|
| `ls -l` | `directory` | `-R`이나 피연산자 둘 이상의 구획 머리줄(`./sub:`). 파일 피연산자의 항목에는 없다 |
| `stat` | `link_target`, `files[]` | 링크 대상. 파일이 여럿이면 최상위가 `files[]`이다 |
| `du` | `modified_at` | `--time` |
| `df` | `type`, `size`, `block_size` | `-T`의 종류. `blocks_1k`는 1K 블록일 때만 있다. 단위 붙은 크기(`-h`, `-H`, `--si`)는 `size`에 값 그대로("547G"), 다른 블록 단위(`-m`, `-B1M`)는 `size`에 블록 수를 담고 단위는 결과의 `block_size` |
| `dig` | `queries` | 쿼리가 여럿일 때 응답마다의 `query`, `query_type`, `answers`, `query_time_ms`, `server`. 맨 위 필드는 첫 응답이다. 루트 이름은 `"."`이고 루트를 가리키는 값(`0 .`)은 점을 지킨다 |
| `wc` | `total`, `entries[].lines`, `words`, `chars`, `bytes`, `max_line_length` | `--total=only`(개수 플래그 하나)의 합계. 이때는 `entries`가 없다. 개수 플래그가 하나면 행은 `count`와 `file`이고, 없거나 둘 이상이면 고른 열을 이름 붙인 필드로 담는다(플래그가 없으면 `lines`, `words`, `bytes`). `file`은 개수 다음 공백 한 칸 뒤의 이름 그대로다 |
| `ps` | `depth` | `f`, `--forest` 트리의 깊이(루트 0) |
| `curl -I` | `header_values`, `history` | 반복 헤더의 값 목록(`headers`에는 `, `로 이은 값), `-L`로 따라간 앞선 응답 |
| `grep` | `byte_offset`, `context` | `-b`의 오프셋, `-A/-B/-C` 문맥 줄 표시(문맥 줄 옵션은 `-n`이 있어야 받는다). 빈 줄과 공백만 있는 일치 줄도 행이다. `-r`(`-R`, `-d recurse`)에서 이름 열이 나오면 `-n`이나 `-b`가 있어야 받는다(번호 열 없이는 콜론이 든 이름과 구분자를 가를 수 없다) |
| `git status` | `renamed`, `ignored`, `unmerged`, `detached`, `detached_at` | 이름 바꾸기 `{old, new}`(staged에는 새 경로), `--ignored` 대상, 충돌 항목, detached HEAD(`branch`는 `HEAD`) |
| `git log` | `refs`, `author`, `date` | `--decorate=full` 참조(git이 찍은 전체 이름 그대로: `HEAD -> refs/heads/main`, `tag: refs/tags/v1.0`), `--format=%h%x09%an%x09%aI%x09%s`의 작성자와 작성 시각(ISO 8601). 짧은 참조(`--decorate`, `--decorate=short`)는 괄호로 시작하는 제목과 가를 수 없어 받지 않는다 |
| `git diff` | `files[].status`, `old_path`, `binary` | 변경 종류(`modified`, `added`, `deleted`, `renamed`, `copied`), 이름 바꾸기 전 경로, 바이너리 변경 |
| `git branch` | `detached`, `points_to`, `worktree`, `upstream_gone` | detached HEAD 항목, `origin/HEAD -> origin/main`의 대상(`-v`의 열 맞춤 공백 포함), 다른 작업 트리에서 쓰는 브랜치, 사라진 상류(`[gone]`, 이때 `ahead`, `behind`는 `null`) |
| `apt search` | `description` | 패키지 줄 아래 설명 |
| `npm ls` | `deduped`, `problem` | `deduped` 표시, `UNMET DEPENDENCY`나 `extraneous` 같은 문제 표시. 이름으로 거른 트리의 `(empty)` 표시는 의존성이 아니라 빈 `dependencies`다 |
| `cargo tree` | `depth`, `deduped`, `proc_macro`, `source` | 깊이, `(*)`, `(proc-macro)`, git 같은 경로가 아닌 소스 |

`compact` 형식은 객체 배열의 모든 행에서 키를 모아 열을 만든다. 일부 행에만 있는 선택 필드도 열로 남는다.

`schema`는 `z.ZodTypeAny`다. v0.5까지 JSON Schema 객체를 직접 사용하던 방식에서 v0.6에서 Zod 단일 소스로 전환되었다. `exportJsonSchema(pack)` 헬퍼로 JSON Schema 객체를 파생할 수 있다 (`zod-to-json-schema` 기반).

`fixtures`의 각 항목은 `{ input: string; args: string[]; expected: unknown }` 쌍이다. `parism test` CLI 실행 시 및 내장 테스트의 fixture replay 시 항상 Zod 스키마 검증을 적용한다.

### 5.2 등록 경로

`ParserRegistry`에는 두 등록 경로가 있다.

`register(cmd, fn, contract?)`: `ParserFn` 함수를 직접 등록한다. `contract`는 5.1의 `ParserContract` 형태의 선택 인자다. 내장 44개 파서가 사용하는 경로다. Zod 스키마가 없어 `strict_schemas` 모드에서도 런타임 검증이 적용되지 않는다.

`registerPack(pack)`: `ParserPack` 객체를 등록한다. `packs` Map과 `parsers` Map 양쪽에 등록된다. `strict_schemas=true`일 때 Zod 스키마로 파서 출력을 검증한다. 커스텀 파서 및 외부 파서가 사용하는 경로다.

### 5.3 strict_schemas 모드

`config.parsers.strict_schemas`로 제어한다. 기본값 `false`.

활성화 시 동작:
- `registerPack`으로 등록된 파서가 실행된 경우에만 적용
- 파서 출력을 `pack.schema.safeParse(parsed)`로 검증
- 검증 실패 시 `{ parsed: null, parse_error: { reason: "schema_violation", message: ... } }` 반환
- `ResponseEnvelope.failure.kind="parse", reason="schema_violation"`으로 승격

fixture replay는 `strict_schemas` 설정과 무관하게 항상 Zod 스키마 검증을 적용한다.

### 5.4 CLI 도구

5개 명령어로 커스텀 파서 로컬 개발 루프를 지원한다.

| 명령어 | 설명 |
|---|---|
| `parism capture "<cmd>"` | 명령 실행 후 raw 출력을 fixture로 저장 |
| `parism init-parser <name>` | `parser.ts` + `schema.ts` + `fixtures/` 스캐폴드 생성 |
| `parism test [parser]` | fixture replay 테스트 실행 (Zod 검증 포함) |
| `parism add <path>` | 파서 팩을 `~/.parism/parsers/`에 영구 등록 |
| `parism inspect "<cmd>"` | raw / parsed / compact 비교 출력 + 토큰 수 |

등록된 외부 파서는 MCP 서버 / 라이브러리 모드 시작 시 `loadExternalParsers`가 자동으로 로드한다.

---

## 6. 설정 (prism.config.json)

### 6.1 guard 전체 필드

| 필드 | 기본값 | 설명 |
|---|---|---|
| `allowed_commands` | 40종 목록 | 허용 명령어 화이트리스트. 40종 모두 기본 정책이 있다 |
| `allowed_paths` | `[process.cwd()]` | 허용 경로. 빈 배열이면 경로 제한 없음 |
| `timeout_ms` | `10000` | 프로세스 타임아웃 (밀리초) |
| `max_output_bytes` | `102400` (100 KB) | stdout 최대 크기. `0`이면 무제한 |
| `max_items` | `500` | 리스트 파서 최대 항목 수. `0`이면 무제한 |
| `default_page_size` | `100` | `run_paged` 기본 줄 수. `max_page_size`보다 크면 설정을 읽을 때 그 값으로 줄인다 |
| `max_page_size` | `1000` | `run_paged` `page_size` 상한. 1 이상 정수 |
| `max_concurrency` | `4` | 동시에 실행하는 자식 프로세스 수 상한. 넘는 요청은 대기한다. 1 이상 정수 |
| `block_patterns` | 9개 인젝션 패턴 | 인자 차단 패턴 |
| `command_arg_restrictions` | node/npx/curl 제한 | 명령별 차단 플래그 |
| `secrets` | 하위 참조 | 시크릿 설정 통합 객체 (v0.6) |
| `profile` | `"readonly"` | `"build"`이면 빌드·시험 실행 서브커맨드를 추가로 허용. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 사용 |
| `command_policies` | 없음 | 명령 단위 정책 덮어쓰기. 우선순위는 `command_policies`, `build` 프로필, 기본 정책 순 |

기본 정책은 읽기 용도에 필요한 플래그만 허용한다. 출력 파일을 지정하는 옵션(`tree -o`, `ss -D` 등), 시스템 상태를 바꾸는 옵션과 위치 인자(`date -s`, `hostname <이름>` 등), 끝나지 않는 반복 실행 옵션(`tail -f`, `free -s`, `netstat -c` 등), 재귀 중 심볼릭 링크를 따라가는 옵션(`grep -R`, `du -L`, `tree -l`, `ls -L`, `find -L`)은 없다. `hostname`은 위치 인자를 받지 않고, `date`는 `+`로 시작하는 출력 형식 하나만 위치 인자로 받는다. `ps`의 위치 인자는 BSD식 옵션 낱말로 보고 `auxfwrljsvhcmnSHTgZ` 글자로만 이루어진 경우에만 받는다. `ps`의 대시 옵션에는 `-x`와 사용자·그룹 선택 옵션(`-u`, `-U`, `-g`, `-G`, `--user`)이 없고, 실행 시 대시 옵션 낱말의 전체 선택 글자 `e`는 같은 뜻의 `A`로 바뀐다(`-ef`는 `-Af`로 실행). `lsof`는 `+`로 시작하는 인자도 플래그로 검사한다. 기본 정책이나 `build` 프로필 정책을 쓰는 기본 명령은 인자가 정확히 `--version` 하나이면 정책 검사를 생략하며, `--help`는 허용하지 않는다. 정책이 없는 명령은 사용자가 `allowed_commands`에 직접 추가한 명령뿐이다.

명령 정책은 `subcommands`, `flags`, `positionals` 외에 위치 인자 조건 `positionalChars`(허용 문자), `positionalPrefix`(접두사), `maxPositionals`(최대 개수), `plusFlags`(`+`로 시작하는 인자를 플래그로 분해), `textPositionals`(위치 인자를 검색어나 출력 문자열로 보고 `key=값`의 `=` 뒤 값을 따로 경로 검사하지 않음)를 가질 수 있다.

설정 값은 레이어(전역, 프로젝트, 환경 변수, `loadConfig`의 단일 파일)마다 필드 단위로 검증한다(`src/config/schema.ts`).

- 형식이 틀린 필드는 stderr에 한 번 경고하고 무시한다. 무시한 필드는 앞 레이어의 값을 유지한다. 기동은 계속한다.
- `timeout_ms`, `max_output_bytes`, `max_items`, `default_page_size`, `adaptive_format_threshold.*`는 유한한 0 이상 정수만 받는다.
- `command_policies`와 `command_arg_restrictions`는 명령 단위로 검사해 틀린 항목만 무시한다. 정책에 알 수 없는 키가 있으면 그 항목을 무시한다.
- `secrets`와 `adaptive_format_threshold`는 하위 키 단위로 병합한다. 지정하지 않은 하위 값은 앞 레이어의 값을 유지한다.
- 최상위 값이 객체가 아닌 설정 파일은 경고 후 무시한다.

### 6.2 guard.secrets (v0.6 통합)

```json
{
  "guard": {
    "secrets": {
      "env_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"],
      "output_patterns": [],
      "output_redaction_enabled": false
    }
  }
}
```

| 필드 | 기본값 | 설명 |
|---|---|---|
| `env_patterns` | 6개 패턴 | 자식 프로세스 환경 변수에서 제거할 변수명 패턴 (대소문자 무관 substring 매칭) |
| `output_patterns` | `[]` | stdout/stderr 레덕션 패턴. `undefined`이면 7개 DEFAULT 패턴 사용; `[]`이면 레덕션 비활성 |
| `output_redaction_enabled` | `false` | 출력 레덕션 활성화 여부 |

레거시 `guard.env_secret_patterns`는 2.0.0에서 제거됐다. 설정에 남아 있으면 stderr에 경고를 출력하고 무시한다.

최상위 `trust_project_config`는 전역 설정에서만 켤 수 있다. 꺼져 있으면 프로젝트 `prism.config.json`은 가드를 넓히지 못하고 좁히는 방향으로만 병합된다.

### 6.3 출력 레덕션 (v0.6 신설, opt-in)

`output_redaction_enabled=true`로 활성화한다. 파서 실행 후 서버 레이어에서만 호출된다. 파싱 전 원본을 건드리지 않는다 (`raw` 보존 원칙과의 예외 처리: 레덕션 활성 시 `raw`에도 레덕션이 적용된다).

7개 기본 패턴 (`src/engine/redactor.ts`의 `DEFAULT_OUTPUT_REDACT_PATTERNS`):
- `sk-[A-Za-z0-9_-]{20,}` — OpenAI/Anthropic API 키
- `ghp_[A-Za-z0-9]{30,}` — GitHub PAT
- `gho_[A-Za-z0-9]{30,}` — GitHub OAuth 토큰
- `glpat-[A-Za-z0-9_-]{20,}` — GitLab PAT
- `AKIA[0-9A-Z]{16}` — AWS Access Key ID
- `xox[baprs]-[A-Za-z0-9-]{10,}` — Slack 토큰
- `Bearer\s+[A-Za-z0-9._-]+` — 범용 Bearer 헤더

부팅 시 `validatePatterns`로 패턴을 컴파일 검증하고, 유효하지 않은 패턴은 stderr 경고 후 제외한다. `output_patterns`를 `undefined`로 두면 기본 패턴 7개를 사용하고, 빈 배열 `[]`로 명시하면 레덕션을 비활성화한다.

### 6.4 parsers

| 필드 | 기본값 | 설명 |
|---|---|---|
| `strict_schemas` | `false` | `registerPack` 파서 출력 Zod 검증 활성화 |

### 6.5 telemetry

| 필드 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `false` | 파이프라인 단계별 성능 메트릭 활성화 |

`config.telemetry.enabled=true`로 설정하면 `ResponseEnvelope.telemetry` 필드에 `guard_ms`, `exec_ms`, `parse_ms`, `redact_ms`, `total_ms`, `raw_bytes`가 포함된다. 기본 비활성이므로 응답 크기에 영향이 없다.

```json
{
  "telemetry": {
    "enabled": true
  }
}
```

### 6.6 설정 레이어와 환경 변수 오버레이

`loadConfigMultiLayer`가 세 레이어를 순서대로 병합한다. 뒤 레이어가 앞 레이어를 덮어쓴다.

1. 전역: `~/.parism/prism.config.json`
2. 프로젝트: `<cwd>/prism.config.json`
3. 환경 변수: `PARISM_` 접두 변수

MCP 서버 진입(`src/index.ts`)과 라이브러리 `createEngine()`은 동일한 3레이어 병합을 사용한다. `createEngine({ configPath })`로 특정 파일을 지정하면 단일 파일 로더(`loadConfig`)로 그 파일만 로드한다. 파일이 없으면 무경고로 기본값에 폴백하고, JSON 파싱에 실패하면 stderr 경고 후 폴백한다. `loadConfig`도 같은 필드 검증을 거치고, 실행 디렉터리가 `/`이면 기본 `allowed_paths`를 홈 디렉터리로 제한한다.

정수 환경 변수는 유한한 0 이상 정수만 받는다. 목록 환경 변수가 비어 있거나 쉼표와 공백뿐이면 경고 후 무시한다. 빈 `PARISM_ALLOWED_PATHS`로 경로 제한을 끌 수 없다.

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

## 7. 설계 원칙

1. 결정성 유지 — 파서는 deterministic code다. LLM 추론이나 외부 서비스 의존성이 없다. 동일한 입력에 항상 동일한 출력을 반환한다.

2. raw 보존 — `stdout.raw`는 항상 원본을 유지한다. 파서가 실패하거나 없어도 에이전트는 raw로 폴백할 수 있다. 예외: `output_redaction_enabled=true`이면 raw에도 레덕션이 적용된다. 이 예외는 의도된 것이며, 시크릿 보호가 원본 보존보다 우선한다.

3. YAGNI — 사용 사례가 구체화되지 않은 추상화를 추가하지 않는다. 라이브러리 모드는 안정 API이며, 다음 breaking change는 v3.0.0을 통해서만 이루어진다.

4. 단방향 임포트 DAG — 모듈 계층은 `types → config → engine → parsers → facade → server` 방향만 허용한다. 역방향 의존은 MCP와 라이브러리 배포 면의 분리를 깨뜨린다.

5. 외부 계약의 하위 호환: 기존 필드 (`guard_error`, `stdout.parse_error`)는 deprecation만 하고 삭제하지 않는다. 새 필드 (`failure`, `secrets.env_patterns`)는 기존 필드와 병존한다.

6. 실패는 봉투로 — Guard 차단, 실행 오류, 파서 예외 모두 예외를 던지지 않고 `ok=false` + `failure` 봉투로 반환한다. 에이전트 파이프라인이 예외로 중단되지 않는다.

---

## 8. 참고 자료

- [CHANGELOG.md](CHANGELOG.md) — 버전별 변경 이력
- [SECURITY.md](SECURITY.md) — 위협 모델, 4겹 방어선 한계, 취약점 신고 채널
- [Requirements.md](Requirements.md) — v0.4 피드백 기반 요구사항 원본 (보안·테스트·기능 확장)
- [docs/plans/2026-03-06-benchmark.md](docs/plans/2026-03-06-benchmark.md) — 토큰 비용·CFR 벤치마크 프레임워크 원본 플랜
- [docs/plans/2026-03-06-issue-remediation.md](docs/plans/2026-03-06-issue-remediation.md) — Guard 경로 인자 검증, config 깊은 병합, 버전 정합화 플랜
- [docs/plans/2026-03-07-safe-os-gateway.md](docs/plans/2026-03-07-safe-os-gateway.md) — v0.2 Safe OS Gateway 구현 플랜 (compact 포맷, native JSON 패스스루)
- [docs/plans/2026-03-12-feedback-critical-acceptance.md](docs/plans/2026-03-12-feedback-critical-acceptance.md) — v0.4 비판적 수용 플랜 (경로 가드 완성, 스냅샷 성능, 파서 실패 관측)
- [docs/plans/2026-03-28-parser-sdk-phase1.md](docs/plans/2026-03-28-parser-sdk-phase1.md) — ParserPack SDK v0.5 구현 플랜 (createRegistry DI, CLI 5개 명령어)
