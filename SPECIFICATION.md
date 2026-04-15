# parism SPECIFICATION

작성자: 최진호
작성일: 2026-04-15
버전: v1.0.0

---

## Context

1969년 Ken Thompson이 Unix를 설계할 때 출력 대상은 사람이었다. 커널은 파일시스템 메타데이터를 구조체(`inode`, `mode`, `uid`, `gid`)로 관리하지만 `ls`는 그 구조를 인간이 읽기 좋은 텍스트로 평탄화한다. AI 에이전트는 그 텍스트를 다시 구조로 되돌리려 한다. 한 번 버려진 구조를 재구성하는 데 추론 단계와 토큰이 소모된다.

parism은 두 번째와 세 번째 번역 사이에 개입한다. `execFile`로 명령을 직접 실행하고, 결과를 결정론적 파서로 구조화하여 `ResponseEnvelope`로 반환한다. 에이전트는 `stdout.parsed`를 읽기만 하면 된다. 파서가 없거나 실패해도 `stdout.raw`가 항상 보존된다.

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
    │  4겹 검사 │ │execFile  │ │ registry  │
    └──────────┘ └──────────┘ └───────────┘
                                    │
                              ┌─────▼──────┐
                              │ redactor   │
                              │ (opt-in)   │
                              └────────────┘
```

MCP 서버: `src/server.ts` + `src/index.ts`가 `@modelcontextprotocol/sdk` 기반 stdio 서버를 제공한다. 에이전트가 `run` / `run_paged` 도구로 호출한다.

라이브러리 모드 (실험적, v0.6부터): `src/facade/engine.ts`의 `ParismEngine`을 직접 import하여 in-process 사용한다. `import { createEngine } from "@nerdvana/parism/engine"`. v0.7 이전까지 API가 변경될 수 있다.

두 면은 동일한 `ParismEngine`에 위임한다. `server.ts`의 `buildRunResult` / `buildPagedResult`는 `ParismEngine.run` / `runPaged`를 래핑하는 얇은 직렬화 레이어다.

### 1.2 모듈 레이어 (단방향 DAG)

```
src/types/          (envelope.ts — 계약 타입만)
src/config/         (loader.ts — 설정 파싱/병합/마이그레이션)
src/engine/         (guard.ts, executor.ts, redactor.ts, paginator.ts, state-tracker.ts)
src/parsers/        (registry.ts, compact.ts, json-passthrough.ts, 44종 파서)
src/facade/         (engine.ts — ParismEngine 클래스)
src/server.ts       (MCP 도구 정의, 직렬화)
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
| `page_size` | int (≥1) | `guard.default_page_size` (기본 100) | 페이지당 줄 수 |

`run_paged`는 파서를 실행하지 않는다. `stdout.parsed`는 항상 `null`이다. 부분 출력은 구조화 파싱이 불가능하다.

응답에 `page_info` 필드가 추가된다:
- `page_info.page`: 현재 페이지 (0-indexed)
- `page_info.page_size`: 요청한 페이지 크기
- `page_info.total_lines`: stdout 전체 줄 수
- `page_info.has_next`: 다음 페이지 존재 여부

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

`OutputField`:
```
{ raw: string; parsed: unknown | null; parse_error?: ParseErrorField }
```

`raw`는 레덕션이 활성화된 경우를 제외하고 항상 원본을 보존한다.

### 3.2 실패 계약 — failure 필드 (v0.6 신설)

`ResponseEnvelope.failure?: FailureInfo`는 guard / exec / parse / config 네 종류의 실패를 단일 접점에서 표면화한다. 기존 `guard_error` 필드는 하위 호환을 위해 유지되지만, 새 소비자는 `failure`를 권위 필드로 사용한다.

`FailureInfo`:
```typescript
{ kind: "guard" | "exec" | "parse" | "config"; reason: string; message: string }
```

| kind | reason | 트리거 | ok |
|---|---|---|---|
| `guard` | `command_not_allowed` | `allowed_commands` 미포함 명령 | false |
| `guard` | `path_not_allowed` | `allowed_paths` 밖 cwd 또는 경로 인자 | false |
| `guard` | `injection_pattern` | `block_patterns` 일치 인자 | false |
| `guard` | `arg_not_allowed` | `command_arg_restrictions` 차단 플래그 | false |
| `exec` | `timeout` | 프로세스 `killed=true` 또는 `ETIMEDOUT` | false |
| `exec` | `spawn_failed` | `ENOENT` 또는 `EACCES` (바이너리 없음/권한) | false |
| `exec` | `non_zero_exit` | 비정상 종료 코드 | false |
| `parse` | `parser_exception` | 파서 함수가 예외 던짐 | false |
| `parse` | `parser_not_found` | 등록된 파서 없고 native JSON도 아님 | **true** (정보성) |
| `parse` | `schema_violation` | `strict_schemas=true`이고 Zod 검증 실패 | false |
| `config` | (예약) | v0.6에서 트리거 없음, 향후 확장 | — |

`kind=parse, reason=parser_not_found`는 `ok=true`를 유지한다. 파서 부재는 실행 실패가 아니라 구조화 파싱 불가 알림이다. `stdout.raw`는 정상 보존된다.

`kind=exec, reason=non_zero_exit`는 프로세스 종료 코드가 0이 아닌 모든 경우를 포함한다. `e.killed === true` 또는 `e.code === "ETIMEDOUT"`이면 `timeout`으로 분류한다. 분류 로직은 `src/engine/executor.ts`에 위치한다.

---

## 4. Guard — 4겹 방어선

Guard는 에이전트가 생성한 명령이 시스템에 예상치 못한 범위로 실행되는 것을 막는 가드 수준 방어선이다. 커널 샌드박스가 아니며, 각 레이어에는 한계가 있다. 상세 위협 모델은 [SECURITY.md](SECURITY.md) 참조.

### (a) 화이트리스트

`guard.allowed_commands`에 없는 명령은 프로세스를 생성하지 않는다. `execFile`을 호출하기 전에 차단하므로 어떤 실행도 발생하지 않는다.

한계: 화이트리스트 범위가 너무 넓으면 (`bash`, `sh`, `python` 등 포함 시) 방어 효과가 크게 줄어든다.

### (b) 경로 제한

`guard.allowed_paths`가 설정된 경우 두 가지를 검사한다.

1. `cwd`가 허용 경로의 하위인지 (`path.resolve` 후 접미 슬래시 기반 prefix 비교)
2. 경로 인자: `/`, `./`, `../`로 시작하는 인자 + `PATH_TAKING_COMMANDS`(`cat`, `find`, `ls`, `grep`, `stat`, `du`, `tree`, `head`, `tail`, `wc`)의 positional 인자

`allowed_paths`가 빈 배열이면 경로 제한이 생략된다. 기본값은 `[process.cwd()]`다 (서버 시작 시점 CWD).

한계: 커널 레벨 강제가 아니다. 경로를 직접 받지 않는 명령(`env`, `uname`)에는 경로 검사가 적용되지 않는다.

### (c) 인젝션 패턴 차단

인자 배열 전체를 join한 문자열에서 `block_patterns`에 포함된 패턴을 검사한다. 기본 패턴: `;`, `$(`, `` ` ``, `&&`, `||`, `>`, `>>`, `<`, `|`.

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
export interface ParserPack {
  name:      string;
  parse:     (raw: string, args: string[], ctx?: ParseContext) => unknown;
  schema:    z.ZodTypeAny;
  fixtures:  Fixture[];
  meta?:     { os?: string[]; version?: string };
}
```

`schema`는 `z.ZodTypeAny`다. v0.5까지 JSON Schema 객체를 직접 사용하던 방식에서 v0.6에서 Zod 단일 소스로 전환되었다. `exportJsonSchema(pack)` 헬퍼로 JSON Schema 객체를 파생할 수 있다 (`zod-to-json-schema` 기반).

`fixtures`의 각 항목은 `{ input: string; args: string[]; expected: unknown }` 쌍이다. `parism test` CLI 실행 시 및 내장 테스트의 fixture replay 시 항상 Zod 스키마 검증을 적용한다.

### 5.2 등록 경로

`ParserRegistry`에는 두 등록 경로가 있다.

`register(cmd, fn)`: `ParserFn` 함수를 직접 등록한다. 내장 44개 파서가 사용하는 경로다. Zod 스키마가 없어 `strict_schemas` 모드에서도 런타임 검증이 적용되지 않는다.

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
| `allowed_commands` | 44종 목록 | 허용 명령어 화이트리스트 |
| `allowed_paths` | `[process.cwd()]` | 허용 경로. 빈 배열이면 경로 제한 없음 |
| `timeout_ms` | `10000` | 프로세스 타임아웃 (밀리초) |
| `max_output_bytes` | `102400` (100 KB) | stdout 최대 크기. `0`이면 무제한 |
| `max_items` | `500` | 리스트 파서 최대 항목 수. `0`이면 무제한 |
| `default_page_size` | `100` | `run_paged` 기본 줄 수 |
| `block_patterns` | 9개 인젝션 패턴 | 인자 차단 패턴 |
| `command_arg_restrictions` | node/npx/curl 제한 | 명령별 차단 플래그 |
| `secrets` | 하위 참조 | 시크릿 설정 통합 객체 (v0.6) |
| `env_secret_patterns` | 6개 패턴 | deprecated — `secrets.env_patterns` 사용 |

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

레거시 `guard.env_secret_patterns` 자동 마이그레이션: 사용자가 레거시 필드만 지정하면 `guard.secrets.env_patterns`에 자동 복사하고 stderr에 deprecation 경고를 출력한다. 둘 다 지정하면 `guard.secrets.env_patterns`가 우선하며 경고가 출력된다.

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

---

## 7. 설계 원칙

1. 결정성 유지 — 파서는 deterministic code다. LLM 추론이나 외부 서비스 의존성이 없다. 동일한 입력에 항상 동일한 출력을 반환한다.

2. raw 보존 — `stdout.raw`는 항상 원본을 유지한다. 파서가 실패하거나 없어도 에이전트는 raw로 폴백할 수 있다. 예외: `output_redaction_enabled=true`이면 raw에도 레덕션이 적용된다. 이 예외는 의도된 것이며, 시크릿 보호가 원본 보존보다 우선한다.

3. YAGNI — 사용 사례가 구체화되지 않은 추상화를 추가하지 않는다. 라이브러리 모드는 실험적으로 표시하고, API가 안정화되기 전에 배포 보장을 하지 않는다.

4. 단방향 임포트 DAG — 모듈 계층은 `types → config → engine → parsers → facade → server` 방향만 허용한다. 역방향 의존은 MCP와 라이브러리 배포 면의 분리를 깨뜨린다.

5. 외부 계약의 하위 호환 — 기존 필드 (`guard_error`, `env_secret_patterns`, `stdout.parse_error`)는 deprecation만 하고 삭제하지 않는다. 새 필드 (`failure`, `secrets.env_patterns`)는 기존 필드와 병존한다.

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
