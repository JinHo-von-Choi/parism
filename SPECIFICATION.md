# parism SPECIFICATION

작성자: 최진호
작성일: 2026-10-05
버전: v2.0.3 (Unreleased 변경 반영)

---

## Context

1969년 Ken Thompson이 Unix를 설계할 때 출력 대상은 사람이었다. 커널은 파일시스템 메타데이터를 구조체(`inode`, `mode`, `uid`, `gid`)로 관리하지만 `ls`는 그 구조를 인간이 읽기 좋은 텍스트로 평탄화한다. AI 에이전트는 그 텍스트를 다시 구조로 되돌리려 한다. 한 번 버려진 구조를 재구성하는 데 추론 단계와 토큰이 소모된다.

parism은 두 번째와 세 번째 번역 사이에 개입한다. 셸 없이 명령을 직접 실행하고, 결과를 결정론적 파서로 구조화하여 `ResponseEnvelope`로 반환한다. 에이전트는 `stdout.parsed`를 읽기만 하면 된다. 파서가 없거나 실패해도 `stdout.raw`가 항상 보존된다.

두 배포 면(MCP stdio 서버와 `@nerdvana/parism/engine` 라이브러리)은 v2.0.0부터 아래와 같이 지원한다. FastMCP 기반 stdio 서버로 에이전트와 MCP 프로토콜로 통신하는 방식과, `@nerdvana/parism/engine` 서브패스 export로 Node.js 소비자가 in-process로 직접 사용하는 라이브러리 모드. 두 면 모두 동일한 `ParismEngine` 인스턴스에 위임하므로 비즈니스 로직 drift가 없다.

---

## 변경 이력 (v0.1 → v2.0.x)

| 버전 | 일자 | 결정 | 근거 | 대안 |
|---|---|---|---|---|
| Unreleased | 2026-10-05 | 계약 정규식(noise/rowLine/acceptedValues) 평가를 외부 팩 워커 안으로 이동, compact 무손실화, 리댁션 기본 패턴 복구, find/du 공백 보존, kubectl RESTARTS 열 해석 수정 | 같은 입력 전후 실측: 워커 상한 500ms 를 90초 넘게 넘기던 서버 스레드 정지가 사라졌고(전체 1.5초), 리댁션 합성 비밀 5종 전량 유출이 사라졌다. 계획서 4장 결함 수정 | 정규식 패턴 안전성 휴리스틱 / 격리 팩의 정규식 계약 비활성 — 전자는 우회 가능, 후자는 불변식 검사 상실 |
| Unreleased | 2026-10-05 | 근거 조회(`contract_version: 'next'` + `explain_result`), 토큰 예산(`budget` + `fetch_result`), 의미 diff(`compare_results`), `git status --porcelain` 두 모드 파싱 | 계획서 5~7장. 큰 결과에서 "무엇이 빠졌나"와 "어디서 나왔나"를 실측 가능하게 만들고, 전후 비교에서 거짓 삭제가 0 이어야 한다 | 정밀한 모델 토크나이저 의존 / 지속 감시(워치) 루프 — 전자는 런타임 의존을 늘리고, 후자는 "재실행 없음" 계약과 충돌 |
| v2.0.2 | 2026-10-03 | 파서 계약의 형식 선언(`acceptedFlags`, `requiredFlags`, `outputFlags` 등), `failure.hint`, 서버 측 투영, `describe(cmd)`, 파서 결과 통계, 외부 팩 워커 격리 실행 | 실측 492건에서 조용히 틀린 파서가 81건(16%)이었고, 재시도 왕복을 줄이려면 기계 판독 형식 안내가 필요했다 | 경쟁 도구와 표 형식 경쟁 / LLM 파싱 — 결정론 깨짐 |
| v2.0.0 | 2026-10-03 | 가드의 명령별 허용목록(`policy.ts`), 파서 실패 계약(`unsupported_format`/`unrecognized_output`) | 위험 사례 11종 중 10종이 기본 설정으로 통과했다 | 기존 블랙리스트 + 경로 검사 유지 — 위험 쓰기 옵션이 남음 |
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

라이브러리 모드 (v1.0.0부터 안정 API): `src/facade/engine.ts`의 `ParismEngine`을 직접 import하여 in-process 사용한다. `import { createEngine } from "@nerdvana/parism/engine"`. `ResponseEnvelope` 계약과 `ParismEngine` API는 Semantic Versioning을 따른다.

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
| `select` | string[]? | 없음 | 행마다 남길 필드 이름(1~64개, 지정한 순서) |
| `where` | Condition[]? | 없음 | 행 조건(1~16개). 모두 맞는 행만 남긴다 |
| `sort_by` | `{ field, order? }`? | 없음 | 정렬 필드와 방향(`asc` 기본, `desc`) |
| `limit` | int (≥0)? | 없음 | 남길 행 수. `0`이면 행 없이 `_summary`만 남는다 |
| `array` | string? | 없음 | 대상 배열의 키. 결과에 배열이 여럿일 때 고른다 |

`format=compact`: 파서 결과의 객체 배열 필드를 `{ schema: string[], rows: unknown[][] }` 컬럼 형식으로 압축한다.
`format=json-no-raw`: `stdout.raw`를 빈 문자열로 치환한다. 파서를 신뢰하는 경우 토큰을 절감한다. 파서 부재 시 디버깅이 불가능하므로 기본값으로 사용하지 말 것.

#### 투영과 필터 (`select`, `where`, `sort_by`, `limit`, `array`)

파싱 결과의 최상위 배열 하나에만 적용하고 `stdout.raw`에는 적용하지 않는다. 구현은 `src/engine/projection.ts`다.

- 대상 배열: `array`를 주면 그 키의 배열, 아니면 파서 계약의 `rowsKey`(5.1), 그것도 없으면 결과의 유일한 배열이다. 결과 자체가 배열(native JSON 배열)이면 그 배열이다.
- 순서: `where` → `sort_by` → `limit` → `select`. 정렬 필드는 `select`에 없어도 된다.
- `Condition`은 `{ field, op, value }`이며 알 수 없는 키가 있으면 거부한다.

| op | value | 필드 값 |
|---|---|---|
| `eq`, `ne` | 문자열, 유한한 수, 불리언, `null` | `null`이 아닌 value와 같은 형. `eq null`은 값이 없는(null 또는 누락) 행, `ne null`은 값이 있는 행 |
| `prefix`, `contains` | 문자열 | 문자열. 대소문자를 구분한다 |
| `gt`, `gte`, `lt`, `lte` | 유한한 수 | 수 |

  필드 값이 없는 행은 `prefix`, `contains`, 수 비교에 맞지 않고, `null`이 아닌 value의 `ne`에는 맞는다.
- `sort_by`는 안정 정렬이다. 같은 값의 행은 원래 순서를 지키고, 값이 없는 행은 방향과 관계없이 뒤에 둔다. 값이 있는 행은 수, 문자열(코드 단위 순서), 불리언 가운데 한 형이어야 한다.
- `select`는 행에 없는 필드를 만들지 않는다. 결과 행은 프로토타입 없는 객체라 `__proto__` 같은 이름도 일반 필드로 남는다.
- 투영을 요청하면 파서는 `guard.max_items` 없이 전체 행을 내고, `where`와 `sort_by`는 전체 행에 적용한다. 보이는 행은 `limit`과 `guard.max_items` 가운데 작은 값까지이며 `max_items`로 잘렸으면 `_summary.truncated: true`다. 결과 객체 안의 대상이 아닌 배열도 `max_items`로 자르고 자른 배열의 키를 `_summary.truncated_arrays`에 남긴다.
- 결과 요약 `_summary = { total, matched, shown, truncated?, truncated_arrays? }`(`total`은 대상 배열의 행 수, `matched`는 `where`를 통과한 행 수, `shown`은 남긴 행 수). 대상 배열이 결과 객체 안에 있으면 같은 객체의 `parsed._summary`, 결과가 최상위 배열이면 `stdout._summary`에 둔다.
- 투영에 성공하면 `stdout.raw`를 싣지 않는다(raw는 투영 전 전체 출력이다). `format`의 `compact`와 함께 쓰면 투영한 행을 압축하고, 적응형 형식 임계값(`parsers.adaptive_format_threshold`)은 투영한 행 수로 판정한다.
- 문법에 맞지 않는 인자는 실행하지 않고 `failure = { kind: "config", reason: "invalid_projection" }`, `exitCode: -1`이다(guard 검사 뒤). MCP 도구는 같은 문법을 입력 스키마로 검사한다.
- 실행 뒤 투영할 수 없으면 `failure.kind = "config"`이고 `parsed`는 `null`, `stdout.raw`는 남긴다. 사유: `unknown_field`(알려진 필드는 계약의 `rowFields`와 행에 있는 키이며 메시지에 목록이 있다. 행이 객체가 아니면 필드가 없다), `type_mismatch`(필드 값의 형이 연산과 맞지 않음), `array_not_found`, `array_ambiguous`. 파싱 결과가 없으면 투영하지 않고 기존 실패를 그대로 둔다.

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

파라미터:

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `cmd` | string? | 없음 | 자세히 볼 명령 이름. 주면 그 명령의 능력 요약(`CommandDescription`)만 반환한다 |

`cmd` 없는 응답 (`DescribeResult`):

| 필드 | 타입 | 설명 |
|---|---|---|
| `version` | string | Parism 패키지 버전 |
| `allowed_commands` | string[] | guard에서 허용하는 명령 목록 |
| `available_parsers` | string[] | 등록된 파서 이름 목록 |
| `guard_summary` | object | `timeout_ms`, `max_output_bytes`, `block_patterns`, `allowed_paths`, `command_arg_restrictions`, `profile`(`readonly` 또는 `build`), `policies`(명령별 유효 정책: `subcommands`, `flags`, `positionals`) |
| `telemetry_enabled` | boolean | 텔레메트리 활성화 여부 |
| `stats` | object? | `telemetry.enabled=true`일 때만. 명령별 결과 횟수(6.5) |

에이전트가 Parism을 처음 사용하거나 가용 명령을 탐색할 때 호출한다. 실행 파이프라인을 거치지 않는다.

`cmd`를 준 응답 (`CommandDescription`, `src/facade/capabilities.ts`). MCP 도구는 이 응답을 들여쓰기 없이 직렬화하며 기본 명령 40종 모두 2KB 이하다. 이름 목록(서브커맨드, 플래그, 필드)은 공백으로 이은 문자열이다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `cmd` | string | 명령 이름 |
| `profile` | `readonly`\|`build` | guard 프로필 |
| `policy` | object | 유효 guard 정책. `origin`(`default`, `build`, `config`, 정책 없이 허용된 명령은 `none`), `subcommands`, `flags`, `positionals`, 있으면 `sub_positionals`, `sub_verbs`, `sub_flags`(기본 표에 없는 서브커맨드 전용 플래그), `leading_flags`, `allowed_values`, `max_positionals`, `positional_chars`, `positional_prefix`, `file_ref_flags`, `blocked_flags`(`command_arg_restrictions`) |
| `parser` | object\|null | 파서 계약의 형식 선언(5.1). `requires`(하나 이상 필요한 형식 플래그), `values`(허용 값이 정해진 플래그와 전체 일치 패턴), `flags`(그 밖의 처리 플래그), `exclusive`, `positionals`(`min`, `max`, `pattern`), `rows_key`, `row_fields`, `subcommands`(서브커맨드별 같은 모양, 빈 문자열 키는 서브커맨드 없는 실행). 플래그는 guard도 허용하는 것만 싣는다. 형식 선언이 없는 파서는 `{ any_args: true }`, 파서가 없으면 `null` |
| `alternatives` | `{ from, args, reason }[]` | 형식 밖 대표 인자(`from`)에 대한 대체 인자 안내(3.2의 `failure.hint`와 같은 계산) |
| `examples` | string[][] | 예시 인자. 현재 설정의 guard를 통과하는 것만 싣는다 |
| `stats` | object? | `telemetry.enabled=true`일 때만. 이 명령의 결과 횟수 |

`allowed_commands`에 없는 명령은 예외 없이 `{ cmd, failure: { kind: "guard", reason: "command_not_allowed", message } }`를 반환한다.

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
{ raw: string; parsed: unknown | null; parse_error?: ParseErrorField; _summary?: ProjectionSummary }
```

`_summary`는 투영(2.1)을 적용했고 파싱 결과가 최상위 배열일 때만 있다. 결과가 객체이면 요약은 `parsed._summary`에 있다.

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
| `config` | `invalid_projection` | `select`, `where`, `sort_by`, `limit`, `array`가 문법(2.1)에 맞지 않음. 실행하지 않는다 | false |
| `config` | `unknown_field`, `type_mismatch`, `array_not_found`, `array_ambiguous` | 실행 뒤 투영할 수 없음(2.1). `parsed`는 `null`, `stdout.raw`는 남긴다 | 실행 결과 |

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

플랫폼 시험(`tests/platform/`)은 현재 OS에서 쓸 수 있는 명령(Linux와 macOS의 `ls`, `ps`, `df`, `du`, `stat`, `find`, `uname`, `id`, `ping -c 1 127.0.0.1`, 시험 안에서 띄운 로컬 HTTP 서버에 대한 `curl -I`, `netstat`, `lsof`, `wc`, `grep`, `which`, `git`, Linux의 `ss`, `free`, `systemctl`, Windows의 `cmd /d /c dir`, `tasklist`, `ipconfig`, `systeminfo`, `curl`, `git`)을 시험 시점에 실행해 출력을 받고, 그 출력에 위 불변식과 기본 필드 검사를 적용한다. 출력은 저장하지 않는다. 자식 환경은 실행기와 같이 `LC_ALL=C`, `LANG=C`이고, 다른 OS의 명령과 설치되지 않았거나 실패한 명령은 건너뛴다. CI는 Linux 시험 작업(`tests/**` 전체)과 macOS, Windows 작업(`npx vitest run tests/platform`)에서 이 시험을 돌린다.

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

compact 는 **값을 보존하지 않는다면 압축하지 않는다.**

- 중첩 배열과 객체는 구분자 문자열로 이어 붙이지 않고 원래 값으로 둔다. `["a|b","c"]`를 `"a|b|c"`로 만들면 `["a","b","c"]`와 구별할 수 없어 복원이 불가능해진다.
- 행 배열에 객체가 아닌 값(null, 문자열 등)이 섞여 있으면 그 배열은 압축하지 않고 그대로 둔다. 첫 항목만 보고 형식을 정하지 않는다.
- 순환 참조, `BigInt`, 깊이 64를 넘는 중첩은 변환하지 않는다. 프로세스 예외를 내지 않고 `failure = { kind: "parse", reason: "representation_not_lossless" }` 를 내며, 원형 JSON 과 `stdout.raw` 를 모두 남긴다.

복원은 `schema` 와 같은 순서로 행 값을 다시 짝지으면 되므로 `decode(encode(x)) = x` 가 성립한다.

`schema`는 `z.ZodTypeAny`다. v0.5까지 JSON Schema 객체를 직접 사용하던 방식에서 v0.6에서 Zod 단일 소스로 전환되었다. `exportJsonSchema(pack)` 헬퍼로 JSON Schema 객체를 파생할 수 있다 (`zod-to-json-schema` 기반).

`fixtures`의 각 항목은 `{ input: string; args: string[]; expected: unknown }` 쌍이다. `parism test` CLI 실행 시 및 내장 테스트의 fixture replay 시 항상 Zod 스키마 검증을 적용한다.

### 5.2 등록 경로

`ParserRegistry`에는 두 등록 경로가 있다.

`register(cmd, fn, contract?)`: `ParserFn` 함수를 직접 등록한다. `contract`는 5.1의 `ParserContract` 형태의 선택 인자다. 내장 44개 파서가 사용하는 경로다. Zod 스키마가 없어 `strict_schemas` 모드에서도 런타임 검증이 적용되지 않는다.

`registerPack(pack)`: `ParserPack` 객체를 등록한다. `packs` Map과 `parsers` Map 양쪽에 등록된다. `strict_schemas=true`일 때 Zod 스키마로 파서 출력을 검증한다. 서버 스레드에서 실행하는 커스텀 파서와 `parsers.external_isolation: "none"`인 외부 파서가 사용하는 경로다.

`registerIsolated(parser)`: 다른 실행 단위에서 도는 파서(`IsolatedParser`: `name`, `contract`, `parse(args, raw, ctx, strictSchemas)`, `close()`, 선택 `withDeadline(task)`)를 등록한다. `withCallDeadline(cmd, task)`는 task 안의 그 명령 실행 단위 호출이 시간 상한 하나를 함께 쓰게 하며 `parse()`가 스스로 이 범위를 쓴다. 계약 선언은 `parser.contract`를 쓰고, strict 검사는 실행 단위가 수행해 위반 메시지를 결과와 함께 돌려준다. `listPacks()`에는 나타나고 `getPack()`으로는 조회되지 않는다. 같은 이름을 다시 등록하면 이전 실행 단위를 닫는다. `ParserRegistry.close()`는 모든 실행 단위를 끝낸다.

계약 함수(`supports`, `hint`)가 예외를 던지면 `parse()`는 예외를 전파하지 않고 `parser_exception`으로 보고한다.

### 5.2.0 근거 조회 (opt-in)

결과는 `contract_version: "next"` 로 요청했을 때만 `review` 를 함께 실는다. 기본값은 `"stable"` 이고 결과에 새 필드가 붙지 않아 기존 소비자는 그대로 동작한다.

`review` 는 기존 봉투 필드의 뜻을 바꾸지 않는다. 들어가는 값:

| 필드 | 뜻 |
|---|---|
| `result_id` | 이 결과를 가리키는 식별자. `retained=false` 여도 결과 안에는 남는다 |
| `parser_id` | 값을 낸 파서. native JSON 폴백이면 `native_json` |
| `content_hash` | 정규 원문 내용의 해시. 같으면 출처가 같음을 뜻한다(원격 인증이나 서명이 아니다) |
| `schema_version` | 봉투 스키마 버전 |
| `source_complete` | 실행 출력이 잘리지 않았는지 |
| `parse_complete` | 지원한 레코드를 모두 인식했는지 |
| `representation_lossless` | 표시 변환이 값을 보존했는지 |
| `privacy_transform` | `none` / `masked` |
| `retained` | 서버가 결과를 보관했는지. `false` 면 continuation 을 약속하지 않는다 |
| `warnings` | 판단을 못 한 이유 |

세 완성도 필드는 `true`(확인함), `false`(확인했고 위배됨), **`unknown`(확인하지 못함)** 세 값을 쓴다. 확인하지 못한 것을 거짓으로 말하지 않기 위한 값이다.

**근거는 값이 참이라는 보증이 아니다.** 명령이 거짓을 출력하거나 환경이 바뀌면 근거는 '그 시점 출력의 증거'일 뿐이다. MCP 도구 설명에도 이 문장을 그대로 적었다.

`explain_result(result_id, pointer)` 는 JSON Pointer로 값을 다시 보고 어디서 나왔는지 알려 준다. 결과는 `value`, `source_kind`, `source_spans`, `transform`, `masked`, `quoted` 이다.

- `source_spans` 는 **마스킹된 정규 원문의 UTF-8 바이트 구간** `[start, end)` 이다. 줄 번호를 함께 준다. 문자열 인덱스와 바이트 오프셋을 섞지 않는다.
- 원문에 그대로 있는 값은 `verbatim`, 계산·변환한 값은 `derived` 로 밝히고 그 변환을 설명한다(`parseInt`, `trim`, `strip_tree_prefix`). 파생값이 원문에 그 대로 있다고 말하지 않는다.
- 구간이 정말 그 값을 담는지 검증해 맞지 않으면 근거가 아니라 "근거 없음"(`source_kind: "none"`)으로 남긴다.
- native JSON 폴백이 값을 냈다면 필드 단위 구간을 지어내지 않고 "원문 전체"를 가리킨다.

**저장**은 서버 인스턴스·세션에 묶인 메모리 TTL/LRU다(결과당 2MiB, 합계 32MiB, 16개, TTL 60초). 마스킹된 결과만 보관하며 디스크 영속은 없다. **보관한 결과도 재실행하지 않는다** — 모르는 id, 퇴출된 id, 만료된 id, 보관하지 않은 id 를 구분해 그 사실과 함께 실패를 돌려준다.

거절 사유는 원인이 다르면 다르게 말한다. `unknown_id`(이 세션이 모르는 id)와 `not_retained`(요청에서 보관하지 않았다)는 다른 사실이고, 합치면 무엇을 해야 하는지 알 수 없다. `run` 은 `retain: true` 가 없어도 `review.result_id` 를 돌려주므로, 그 id 로 조회하면 `not_retained` 이 나온다.

근거를 요청한 경우(`evidence` 가 `none` 이 아님)에는 적응형 compact 를 켜지 않는다. compact 는 결과 구조를 바꾸어 근거 포인터가 가리키는 대상을 지우기 때문이다. `format: "compact"` 를 명시하면 그대로 압축하고, 근거가 만들어지지 않은 이유를 `warnings` 에 적는다.

현재 근거를 만드는 파서는 `ps` 와 `git status --porcelain` 둘이다.

`ps` 는 열 위치가 고정이라 정확하다.

`git status --porcelain` 은 **레코드 구분 방식이 두 가지**다. 파서는 `-z`/`--null` 유무로 판별해 레코드 경계·경로 해석·이름 변경 표기를 나눠 처리한다. 한 규칙으로 둘 다 읽으면 둘 중 하나를 반드시 놓친다.

| | `-z` 없음(줄 구분) | `-z` 있음(NUL 레코드) |
|---|---|---|
| 레코드 경계 | 개행 | NUL |
| 경로 표시 | C 이스케이프 + 필요하면 따옴표 | 가공 없음 |
| 이름 변경 | 한 줄의 `원래 -> 새` | **새 경로가 먼저**, 원래 경로가 다음 레코드 |

- 실측: 개행 구분 `?? "line\nbreak.txt"`, `-z` `?? line<LF>break.txt`(따옴표 없음)
- 실측: 이름 변경은 `-z` 면 `RM renamed.txt<NUL>keep.txt<NUL>`, 줄 모드면 `R  old.txt -> new.txt`
- 스테이징 안 됨은 공백으로 온다(`" M src/a.ts"`)
- 경로 자체에 `' -> '` 가 들어갈 수 있어 화살표는 **오른쪽에서** 찾는다

**두 형식의 `path` 값은 같다** — 원래 파일 이름이다. 줄 모드에서만 항목에 `quoted: true` 가 붙어 출력이 가공되었음을 밝힌다.

근거는 `-z` 레코드 기준으로 **레코드 번호**를 함께 준다(줄 번호가 통하지 않기 때문). 줄 모드에서 이스케이프가 풀린 경로의 근거는 원문의 **따옴표 구간**을 가리키고 `transform: "unescape_c_quotes"` 로 그 변환을 밝힌다 — 근거는 값이 아니라 원문을 가리켜야 한다.

경로에 개행이 있어도 근거 구간이 정확해야 한다. 줄로 나누어 위치를 계산하면 이 자리에서 어긋난다.

다른 파서는 근거가 없음을 `warnings` 로 알린다 — 지어내지 않는다.

### 5.2.2 토큰 예산과 누락 내역

큰 명령 결과를 예산 안에 받으면서 **무엇이 빠졌는지** 알 수 있다. 핵심은 "예산 때문에 사라진 정보"와 "파서 오류 때문에 사라진 정보"를 섞지 않는 것이다. 사용자 정의 필터·필수 필드가 우선이며, 서버가 대신 골라 주지 않는다.

**예산은 실행시간이나 수집량을 줄이는 기능이 아니다.** 이미 얻은 결과를 어디까지 내보낼지 정한다.

`run` 의 새 인자 `budget: { max_tokens, tokenizer, required_fields, overflow: 'page' | 'error' }`

- `required_fields` 는 모든 반환 행에서 보존해야 할 필드다. 내장 파서가 정의한 행 identity 도 생략하지 않는다.
- 예산이 최소 봉투(약 1,200 토큰)에 못 미치면 **실행 전에** `failure = { kind: "config", reason: "budget_too_small" }` 로 거절한다. 실행해 놓고 나서야 알리면 명령만 돌고 아무 값도 못 받는 결과가 된다.
- **필수 필드가 없으면 조용히 일부만 내보내지 않는다.** 명시적으로 실패한다 — 부분 성공은 조용한 손실이다.

응답에 `budget` 보고와 `omission` 목록이 실린다.

| 필드 | 뜻 |
|---|---|
| `budget.requested` | 요청한 상한과 토크나이저 |
| `budget.measured_tokens` | 최종 payload 를 실제로 센 수 |
| `budget.tokenizer_id` / `tokenizer_version` | 어느 토크나이저로 셌는지 |
| `budget.budget_met` | 상한 안에 들어갔는지 |
| `budget.tokenizer_exact` | 근사인지, 문자 단위 정확한지 |
| `budget.tokenizer_scope` | 이 약속이 어디까지 성립하는지 |

`omission` 은 `stage`(`capture`·`parse`·`projection`·`budget`·`privacy`), `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `unknown_counts`, `next_cursor` 를 구분해 담는다. **수집 상한에 걸렸는데 전체 행 수를 안 다고 꾸미지 않는다** — `capture` 단계에 `unknown_counts` 로 남긴다.

**고정 토크나이저**는 `parism/approx`(근사)와 `byte`(문자 단위 정확) 둘이다. ID·버전·적용 범위를 결과에 노출한다. 이 약속은 parism JSON payload 에만 성립하며 **MCP transport·클라이언트·모델 내부 토큰까지 보장하지 않는다.** 미지원 토크나이저는 조용히 대체하지 않고 `tokenizer_unsupported` 로 거절한다 — 추정을 정확한 예산으로 포장하지 않는다.

`fetch_result(result_id, cursor, budget)` 는 저장된 같은 결과의 다음 페이지를 **재실행 없이** 돌려준다. cursor 는 진행 규칙(스냅샷 identity·투영·정책·스키마)과 위치를 함께 묶으므로 클라이언트가 임의 오프셋을 조립할 수 없다. 이미 만료·퇴출된 id 는 그 사실과 함께 거절하고 자동 재실행하지 않는다. 근거 조회에도 같은 예산·마스킹 정책이 적용된다.

적용 순서는 고정이다.

1. 가드·실행·완전성 판정
2. 파싱과 표준 마스킹
3. `where` / `sort_by`
4. 필수 필드 검증
5. 행·필드를 줄이며 **실제 직렬화한 최종 payload** 로 매번 센다
6. 누락 메타데이터와 continuation 을 포함한 **최종 크기를 재검증**한다 — 넘으면 한 행씩 더 덜어낸다

마지막 검사를 빠뜨리면 "본문만 예산 안에 들었다"고 잘못 말하게 된다. 표면이 붙으면 크기가 더 늘기 때문이다.

예산을 요청하면 적응형 compact 를 켜지 않는다. compact 는 결과 구조를 바꾸어 필수 필드 검증과 행 계산 대상을 지운다.

### 5.2.3 의미 diff

`compare_results(base_id, current_id, { keys, ignore_fields, strict })` 는 **이미 존재하는 두 결과만** 비교한다. read 단계다 — 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다. 파일 mtime 을 쓰는 `includeDiff` 와 이름·도구로 노출한다.

결과에 `comparable`, `refusal_reasons`, `added`, `removed`, `changed`, `unchanged_count`, `ignored_fields`, `partial` 을 담고, 필드 변화에는 이전·현재 근거 포인터를 연결한다. 사용자가 무시한 필드는 결과에 그대로 공개한다.

**거짓 삭제가 가장 나쁜 실패다.** compact 가 값을 잃은 상태에서 diff 를 만들면 거짓 변경·거짓 삭제가 생긴다. 그래서 M1 의 저장·identity·마스킹이 선행이다.

- **불완전 결과의 누락 행을 `removed` 로 단정하지 않는다.** 어느 한쪽이라도 수집이 잘렸거나 파서가 놓쳤으면 '보이지 않은 것'과 '사라진 것'을 구별하지 못하고 `partial.withheld_reasons` 에 보류를 남긴다.
- **identity 를 확정하지 못한 행이 있어도 `added`/`removed` 를 단정하지 않는다.** 못 찾았다고 새로 생긴 것이 아니다.
- 중복 identity 는 오류다. 조용히 한 행을 버리지 않는다.

**행 identity**

| 도메인 | 규칙 |
|---|---|
| git | 저장소 identity(실경로) + 정규 경로. 이름 변경은 확정 정보(원래 경로)가 있을 때만 연결 |
| kubernetes | context/namespace/resource kind + `metadata.uid`. **uid 없는 표 출력만으로 같은 자원이라고 꾸미지 않는다** |
| ps | **비교를 보류한다.** PID 만을 identity 로 삼으면 PID 재사용 때문에 다른 프로세스를 같은 것으로 본다 |

**git 정규 경로는 저장소 기준이다.** porcelain 은 cwd 기준 상대 경로를 주지만 정규화는 **저장소 identity(실경로)** 를 기준으로 삼는다. 프로세스 cwd 를 기준으로 정규화하면 같은 저장소의 같은 파일이 실행 위치마다 다른 identity 를 갖는다.

**결과 행은 `label`(사람이 읽는 이름)과 `key`(내부 식별자)를 함께 준다.** `key` 는 `저장소identity<NUL>경로` 형식이므로 사람이 읽기 어렵다. 무엇이 변했는지 말하려면 이름이 보여야 한다.

**`comparable` 은 보류 사실과 함께 말한다.** 어느 한쪽이라도 identity 를 확정하지 못한 행이 있거나 키가 충돌하면 `comparable: false` 다. "비교가 성립했다"와 "비교하지 못했다"를 동시에 말하지 않는다. 그래도 뺀 값(`changed` 등)과 보류 사유는 그대로 준다 — 무엇을 봤는지는 숨기지 않는다. 중복 identity 를 찾아놓고 `key_conflicts` 를 비워 두지 않는다 — 조용히 한 행을 버리는 셈이 된다.

**환경 변화 확인(지문)** 에 `cmd`/argv, 실제 작업 디렉터리, 적용된 가드 정책 해시, 파서·스키마·내용 해시, 플랫폼·선택된 도구 버전, 허용한 locale, 사용자가 명시한 문맥을 담는다. **지문은 세계 상태를 캡처한 인증서가 아니다.**

- argv 는 비밀을 담을 수 있으므로 **해시로 식별하고** 표시에는 마스킹한 값을 쓴다.
- 환경 변수는 **'이름'만 관찰 기록에** 담고 값은 담지 않는다. 관찰 기록은 동일성 비교 키에 들어가지 않는다.
- OS·파서 버전이 달라졌다고 모든 비교를 막지는 않는다. `same`/`compatible`/`unknown`/`incompatible` 로 나누고 `unknown` 에서는 strict 비교를 거절한다.
- **Kubernetes context 이름만으로 클러스터 동일성을 완벽히 입증할 수 없다는 한계를 남긴다.**

### 5.2.4 fixture 매니페스트와 오프라인 replay

`parism capture <command>` 는 실행 결과를 **정제한** fixture 매니페스트로 저장한다. 계획서 8장의 요구다: "fixture manifest 에는 cmd/args 의 정제본, stdout/stderr 의 정제본, exit 상태, parser/content/schema 버전, 플랫폼·도구 버전, expected 값·expected 실패·출처 span·완전성 기대값을 둔다. 마스킹 때문에 바뀐 필드도 명시한다."

| 필드 | 뜻 |
|---|---|
| `manifest_version` | 매니페스트 형식 버전(현재 1) |
| `id` | 안정 식별자. 파일명이 아니라 이 값을 쓴다 |
| `tool.command` / `tool.args` | 정제된 대상 명령 |
| `exit.code` / `exit.signal` | 실행 결과 |
| `stdout` / `stderr` | 정제본 |
| `content_hash` | 정제본 stdout 의 지문 |
| `versions` | parism·파서·스키마·플랫폼·도구 버전 |
| `redactions` | 가린 것의 종류·무엇으로·몇 번 |
| `expected` | 사람이 검토한 기대값(아래) |

**정제는 저장 전에 한다.** 시크릿성 토큰, 홈 경로, `--token=` 류 인자 값을 가리고 **무엇을 가렸는지** `redactions` 에 남긴다. 지운 흔적이 없으면 '원래 없던 것인지 가린 것인지' 구분할 수 없어 검증 자체가 무의미해진다. 민감한 값은 **형태를 남기고 값만 바꾼다** — 통째로 지우면 fixture 가 조립된 것처럼 보인다. argv 는 비교 키(identity)에도 들어가므로 옵션 이름과 **길이**를 남긴다(`--token=<redacted:12>`). **자동으로 사용자 원문을 서버에 업로드하지 않는다.** 정제는 로컬 파일 안에서 끝난다.

**기대값에는 사람이 검토했다는 표시가 있어야 계약이 된다.** `expected.reviewed_by` 가 비면 그 fixture 는 **미검토** 다 — '계약'이 아니라 '제안' 이다. `parism test` 는 이를 계약 위반으로 세지 않는다. 필수로 두면 "기대값은 썼지만 아직 아무도 보지 않았다" 는 상태가 표현 불가능해져 그 상태의 fixture 가 매니페스트 검증에서 조용히 사라진다.

`parism test <dir>` 는 저장된 stdout 만 써서(명령을 **다시 실행하지 않는다**) 현재 파서로 되짚는다. 다시 실행하면 그때의 환경이 섞여 "파서가 바뀌었다" 와 "기계가 바뀌었다" 를 구분할 수 없게 된다. 판정은 통과/실패가 아니라 **변화된 경로 목록**이다:

```
의도치 않은 계약 변화 3건
  git-fixture-1  (git)
  [parsed] 1건
    /entries/5  extra  기대 undefined → 실제 {"xy":"??", …}
  [evidence] 3건
    /evidence/entries/0/path/0/line  value  기대 9 → 실제 0
```

- **키 순서만 바뀐 것은 변화로 보지 않는다.** 파서가 객체 키 순서를 바꿨다고 계약이 바뀐 것은 아니다. 배열 순서는 값이므로 변화로 센다.
- **근거 기대는 부분 확인이 기본이다.** `expected.evidence.pointers` 에 적은 포인터만 확인한다 — 사람이 검토할 수 있는 것은 "내가 본 이 주장" 이지 "파서가 낼 수 있는 모든 주장" 이 아니다. 전수 대조가 필요할 때만 `exhaustive: true` 로 켠다.
- **누락 내역은 replay 로 확인하지 않는다**(`not_checked` 로 밝힌다). 누락은 예산 층이 **실제 응답 표면**을 재서 결정하고, 저장된 stdout 을 되짚는 경로에는 그 표면이 없다. 수치를 지어내지 않는다.
- **깨진 매니페스트와 매니페스트가 아닌 파일은 조용히 건너뛰지 않는다.** 형식이 다른 파일을 통과시키면 '회귀 0건' 이라는 거짓말이 된다.
- **`parism test` 는 기대값을 쓰지 않는다.** 되짚기는 읽기만 한다. 자동 갱신은 회귀를 숨기는 가장 싼 방법이다.

`runFixtureTests`(`src/cli/test-runner.ts`)는 **ParserPack 안의** fixture 를 되짚는 별개 경로로 그대로 둔다. 새로 포장한 기능이 아니라 양쪽을 잇는 고리다.

### 5.2.1 외부 ParserPack 격리 실행

`loadExternalParsers`는 기본적으로 외부 팩마다 워커 스레드(`node:worker_threads`) 하나를 띄워 `parser.js`를 그 워커에서만 읽는다(`src/parsers/external/host.ts`, `src/parsers/external/worker.js`). 내장 파서는 서버 스레드에서 실행한다.

- 메타데이터: 워커가 계약 선언을 구조화 복제 가능한 값으로 보낸다. 함수(`supports`, `hint`, 서브커맨드 계약 안의 함수)는 호출할 때마다 워커에서 평가하는 대리 함수가 되고, `RegExp` 는 `{ "__parism_regex__": { source, flags } }` 서술자로 전달된다. 서버 스레드는 팩 모듈의 최상위 코드를 실행하지 않는다.
- **계약 정규식은 워커 안에서만 실행한다.** 서버 스레드는 팩이 보낸 `RegExp` 를 다시 만들어 실행하지 않는다. `noise`, `rowLine` 은 원문 줄 분류를, `acceptedValues` 는 플래그 값 판정을 워커가 수행하고 줄 수와 참/거짓 결과만 돌려준다. 정규식은 워커 밖에서 돌리면 워커의 시간·메모리 상한을 우회해 서버 스레드를 멈출 수 있다(재귀 역추적 패턴은 40자 입력으로 상한 500ms 를 90초 넘게 넘겼다). 판정 결과가 없으면 검증되지 않은 것이므로 형식을 거절한다.
- Breaking notes: 격리 팩 계약의 `noise`, `rowLine`, `acceptedValues` 를 메인 스레드에서 `RegExp` 로 쓰는 코드는 동작하지 않는다. `source`/`flags` 서술자로 접근하거나, `parse` 가 돌려주는 계산된 줄 수(`facts`)를 쓰면 된다. 이 규칙은 내장 파서에 적용되지 않는다(내장 계약은 소스에 있고 검수가 가능하다).
- 동기 호출: 서버 스레드는 요청을 보낸 뒤 `SharedArrayBuffer` 신호를 `Atomics.wait`로 기다리고 `receiveMessageOnPort`로 응답을 꺼낸다. `parse()`는 동기 API 그대로다. 기다리는 동안 서버 스레드는 막힌다. `parse()` 호출 하나의 계약 함수(`supports`, `hint`) 왕복과 `parse` 왕복, 다시 띄운 워커의 기동 대기는 시간 상한 하나를 함께 쓰므로 호출 하나가 서버 스레드를 막는 시간은 시간 상한에 수 ms를 더한 정도다. 엔진의 `run`은 파싱과 투영용 계약 조회(`contractFor`)를 한 호출로 묶는다. 예외는 처음 로드(서버 시작, `parism add`)이며 기동 상한까지 막힐 수 있다.
- 상한: 호출 하나(계약 함수와 `parse` 왕복 전부) `parsers.external_time_limit_ms`(기본 500ms), 워커 V8 힙의 old generation `parsers.external_memory_limit_mb`(기본 128MB, `resourceLimits.maxOldGenerationSizeMb`. `Buffer`, `ArrayBuffer`처럼 힙 밖에 잡는 메모리는 제한하지 않는다), 워커 기동과 모듈 로드 2초(설정으로 바꾸지 않는다).
- 실패: 시간 상한 초과, 워커의 비정상 종료(`process.exit`, 잡히지 않은 예외), 메모리 상한 초과는 `parse_error.reason = "parser_exception"`이며 메시지가 원인과 대기 시간을 밝힌다(`External parser 'x' did not answer within 500 ms; its worker was stopped and restarts after 2000 ms`). 스스로 끝난 워커는 종료 신호로 바로 알리고(호출 사이에 끝난 경우 포함), 메모리 상한으로 멈춘 워커는 시간 상한에서 끝난다. 워커 `error` 이벤트는 stderr 경고(`ERR_WORKER_OUT_OF_MEMORY` 등)로 남는다. 처음 로드할 때의 기동 상한 초과와 로드 실패는 그 팩만 건너뛰고 경고한다.
- 장애 뒤 대기: 워커 장애(시간 상한 초과, 비정상 종료, 메모리 상한 초과, 다시 띄울 때의 기동 상한 초과와 로드 실패, 호출 밖에서 스스로 끝남) 뒤에는 워커를 끝내고 대기 시간 동안 워커를 띄우지 않고 바로 `parser_exception`(`External parser 'x' is paused for N ms after its worker stopped`)으로 답한다. 대기 시간은 2초에서 시작해 장애가 이어질 때마다 두 배로 늘어 30초에서 멈추며, 워커가 답하고 장애가 없었던 호출 뒤에 2초로 돌아간다. 대기 시간이 지난 뒤의 호출이 워커를 다시 띄운다. 그 호출의 상한 안에 기동이 끝나지 않으면 워커는 그대로 두고 그 호출만 `parser_exception`(`... is still starting; the call stopped at its 500 ms limit`)이며, 다음 호출이 기동을 이어서 기다린다.
- 계약 조회: `contractFor`와 `formatHint`는 계약 함수가 예외를 던지면(워커 장애와 대기 포함) `undefined`다. 투영은 이때 계약의 `rowsKey`, `rowFields` 없이 대상 배열을 고른다.
- 반환값: 구조화 복제 가능한 값만 받는다. 함수, Promise, Symbol이 든 값은 `parser_exception`(`Parser returned a value that cannot be passed between threads: ...`)이다. 이름이 `UnrecognizedOutputError`인 예외는 `unrecognized_output`이다.
- strict 검사: `strict_schemas=true`이면 워커가 팩의 `schema.safeParse`로 검사한다. `safeParse`가 없는 스키마는 검사하지 않는다. 조용한 빈 결과 판정이 스키마 위반보다 먼저다.
- 출력: 워커 안의 `console`과 `process.stdout.write`는 stderr로 간다(`process.stderr.write`는 그대로). 워커는 보안 경계가 아니므로 파일 기술자 1에 직접 쓰는 출력은 막지 못한다.
- 팩 이름: `parism add`는 디렉터리를 만들기 전에 팩 이름이 영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `-`로 된 1~64자인지, 설치 경로가 `parsers/` 바로 아래인지 검사하고 맞지 않으면 설치하지 않는다. 시작 시 로더도 `registry.json`의 항목 이름을 같은 형식으로 검사해 맞지 않는 항목을 경고와 함께 건너뛴다.
- `parism add`도 팩 이름을 워커에서 읽는다. fixture replay 도우미(`runFixtureTests`)는 작성자 도구라 팩 객체를 같은 스레드에서 실행하고, `parism inspect`는 내장 파서만 쓴다.

워커 격리는 결함 격리이며 보안 경계가 아니다. 워커는 서버 프로세스의 권한을 그대로 가진다. [SECURITY.md](SECURITY.md)와 `docs/adr/2026-07-21-external-parser-sandbox.md` 참조.

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

등록된 외부 파서는 MCP 서버 / 라이브러리 모드 시작 시 `loadExternalParsers`가 자동으로 로드한다. 실행 방식과 상한은 5.2.1과 6.4를 따른다.

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
      "output_redaction_enabled": false
    }
  }
}
```

| 필드 | 기본값 | 설명 |
|---|---|---|
| `env_patterns` | 6개 패턴 | 자식 프로세스 환경 변수에서 제거할 변수명 패턴 (대소문자 무관 substring 매칭) |
| `output_patterns` | 키 없음(`undefined`) | stdout/stderr 레덕션 패턴. 값을 생략하면 7개 DEFAULT 패턴을 쓴다. `[]`를 명시하면 의도적 비활화이므로 아무것도 가리지 않는다. 기본값으로 `[]`를 넣지 않는다 — 넣으면 생략과 의도적 비활화를 구별할 수 없어, 리댁션을 켰는데 아무것도 가려지지 않는 상태가 된다 |
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
| `strict_schemas` | `false` | `registerPack` 파서 출력 Zod 검증 활성화. 격리 실행 외부 팩은 워커가 검증한다 |
| `external_isolation` | `"worker"` | 외부 ParserPack 실행 방식. `"worker"`는 팩마다 워커 스레드, `"none"`은 서버 스레드 |
| `external_time_limit_ms` | `500` | 외부 팩 호출 하나(계약 함수와 parse 왕복 전부)의 시간 상한. 1 이상 정수 |
| `external_memory_limit_mb` | `128` | 외부 팩 워커의 V8 힙(old generation) 상한. 힙 밖 메모리는 제한하지 않는다. 1 이상 정수 |

`external_*` 값은 전역 설정에서 정한다. 신뢰하지 않는 프로젝트 설정(전역 `trust_project_config`가 참이 아님)은 격리를 `"worker"`로 켜거나 상한을 기준값 이하로 낮추는 값만 반영하고, 격리를 끄거나 상한을 올리는 값은 stderr 경고 후 버린다. 환경 변수로는 바꿀 수 없다.

### 6.5 telemetry

| 필드 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `false` | 파이프라인 단계별 성능 메트릭 활성화 |

`config.telemetry.enabled=true`로 설정하면 `ResponseEnvelope.telemetry` 필드에 `guard_ms`, `exec_ms`, `parse_ms`, `redact_ms`, `total_ms`, `raw_bytes`가 포함된다. 기본 비활성이므로 응답 크기에 영향이 없다.

같은 설정이 켜져 있으면 엔진은 프로세스 안에 명령별 결과 횟수를 모으고 `describe`의 `stats`로 보여 준다(`describe(cmd)`는 그 명령의 것만). 외부로 보내거나 파일에 저장하지 않으며 재시작하면 비워진다. `run` 한 번은 결과 하나로 센다. guard 거부는 `guard.<reason>`, 실행 실패는 `exec.<reason>`, 그 밖에는 파싱 결과(`parsed`, `unsupported_format`, `unrecognized_output`, `parser_exception`, `schema_violation`, `parser_not_found`)이며 native JSON 폴백이 결과를 냈으면 `parsed`다. `run_paged`는 파싱하지 않으므로 guard 거부와 실행 실패만 센다. 허용 목록 밖의 명령은 `(unlisted)` 한 항목으로 모은다. 예: `{ "ls": { "parsed": 12, "unsupported_format": 1, "guard": { "path_not_allowed": 2 } } }`. 활성 시 `run` 한 번에 더해지는 비용은 1µs 미만이다.

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

3. YAGNI: 사용 사례가 구체화되지 않은 추상화를 추가하지 않는다. 라이브러리 모드는 안정 API이다.

4. 단방향 임포트 DAG — 모듈 계층은 `types → config → engine → parsers → facade → server` 방향만 허용한다. 역방향 의존은 MCP와 라이브러리 배포 면의 분리를 깨뜨린다.

5. 외부 계약의 하위 호환: 기존 필드 (`guard_error`, `stdout.parse_error`)는 deprecation만 하고 삭제하지 않는다. 새 필드 (`failure`, `secrets.env_patterns`)는 기존 필드와 병존한다.

6. 실패는 봉투로 — Guard 차단, 실행 오류, 파서 예외 모두 예외를 던지지 않고 `ok=false` + `failure` 봉투로 반환한다. 에이전트 파이프라인이 예외로 중단되지 않는다.

---

## 8. 참고 자료

- [CHANGELOG.md](CHANGELOG.md) — 버전별 변경 이력
- [SECURITY.md](SECURITY.md) — 위협 모델, 4겹 방어선 한계, 취약점 신고 채널
- [Requirements.md](Requirements.md) — v0.4 피드백 기반 요구사항 원본 (보안·테스트·기능 확장)
- [docs/failure-cases-2026-10-05.md](docs/failure-cases-2026-10-05.md) — 실측으로 잡은 결함과 **재현하지 못한 주장**. 근거 조회·예산·의미 diff 도입 기간의 측정 기록
- [docs/plans/2026-03-06-benchmark.md](docs/plans/2026-03-06-benchmark.md) — 토큰 비용·CFR 벤치마크 프레임워크 원본 플랜
- [docs/plans/2026-03-06-issue-remediation.md](docs/plans/2026-03-06-issue-remediation.md) — Guard 경로 인자 검증, config 깊은 병합, 버전 정합화 플랜
- [docs/plans/2026-03-07-safe-os-gateway.md](docs/plans/2026-03-07-safe-os-gateway.md) — v0.2 Safe OS Gateway 구현 플랜 (compact 포맷, native JSON 패스스루)
- [docs/plans/2026-03-12-feedback-critical-acceptance.md](docs/plans/2026-03-12-feedback-critical-acceptance.md) — v0.4 비판적 수용 플랜 (경로 가드 완성, 스냅샷 성능, 파서 실패 관측)
- [docs/plans/2026-03-28-parser-sdk-phase1.md](docs/plans/2026-03-28-parser-sdk-phase1.md) — ParserPack SDK v0.5 구현 플랜 (createRegistry DI, CLI 5개 명령어)
