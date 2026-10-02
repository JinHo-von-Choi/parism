# Changelog

모든 주요 변경사항은 이 파일에 기록된다.

이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따르며,
포맷은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따른다.

## [2.0.1] - 2026-10-03

### Documentation
- README 명령 표의 열 구성과 표기를 정리하고, `terraform plan`에 build 프로필 표시를 추가했다.

## [2.0.0] - 2026-10-03

### Breaking

| 변경 | 영향 대상 | 호환 수단 |
|-|-|-|
| 정책 명령의 미등록 플래그·서브커맨드 차단 | git, npm, pnpm, docker, kubectl, helm, terraform, cargo, apt, brew, systemctl, journalctl, gh, curl, find, env, node, npx 사용자 | `guard.profile: "build"`, `guard.command_policies` 덮어쓰기, 차단 메시지에 차단 인자 명시 |
| `cargo` 기본 정책은 `--version`, `-V`만 허용 | `cargo tree`, `metadata`, `search`, `pkgid` 사용자 | `guard.profile: "build"` |
| `npm audit`은 위치 인자를 받지 않음 | `npm audit <동사>` 사용자 | 없음(의도) |
| `build` 프로필의 `npx`는 설치된 실행 파일만 실행(`--no`를 앞에 붙임) | 설치하지 않은 패키지를 `npx`로 실행하던 사용자 | 패키지를 먼저 설치 |
| `kubectl -o`/`--output`은 `json`, `yaml`, `wide`, `name`, `jsonpath=`, `jsonpath-as-json=`, `custom-columns=`, `go-template=`, `template=`만 허용 | `*-file` 형식 사용자 | 인라인 형식 사용 |
| 값을 붙여서만 받는 플래그: git `--pretty`, `--format`(branch, tag 제외), `-U`, `--unified`, tag `-n`, brew `--json` | 값을 다음 인자로 주던 사용자 | `--pretty=oneline`, `-U3`처럼 붙여 쓴다 |
| git `blame`, `shortlog`의 `-n`과 docker `logs`의 `-f`는 값을 받지 않는 플래그로, journalctl `-n`, `--lines`는 줄 수 형식(N, +N, all)의 다음 인자만 값으로 받는 플래그로 처리 | 해당 플래그 뒤 인자를 값으로 기대하던 사용자 | 없음(각 명령의 실제 문법) |
| `find` 정책에서 `-L` 제거 | `find -L` 사용자 | `guard.command_policies` |
| 정책 없는 명령의 경로 검사 확대: 슬래시를 포함한 위치 인자, cwd 기준으로 존재하는 항목을 가리키는 위치 인자와 플래그 부착 값 | 이 인자가 `allowed_paths` 밖으로 해석되던 사용자 | `allowed_paths`에 경로 추가 |
| `apt` 파서 `name`에서 suite를 분리 | `name`의 `/suite` 부분을 읽던 소비자 | `suite` 필드 |
| `free` 파서 옵션 없는 기본 `unit`이 `"bytes"`에서 `"KB"`로 바뀜 | `unit`을 읽던 소비자 | `*_bytes` 필드 |
| 프로젝트 `allowed_paths`의 상대경로는 설정 파일 디렉터리 기준으로 해석하고, 심볼릭 링크를 해석한 실경로로 비교·저장 | 프로젝트 설정에 상대경로나 링크를 쓰던 사용자 | 기준 경로 안의 실제 디렉터리를 지정 |
| 기본 `allowed_commands`에서 `env` 인자 사용 불가 | `env` 단독은 유지 | 없음(의도) |
| `failure.reason` 값 2종 추가 | reason을 전수 switch 하는 소비자 | CHANGELOG 명시, SPECIFICATION 표 갱신 |
| 지원하지 않는 형식에서 `parsed=null` | `git log` 기본, `ps -ef`, `ss -tln`, `ls`(-l 없음) 등을 쓰던 소비자 | native JSON 폴백 유지, `stdout.raw` 유지 |
| 프로젝트 `prism.config.json`이 가드를 넓히지 못함 | 저장소별로 명령을 추가하던 사용자 | 전역 `~/.parism/prism.config.json`의 `trust_project_config: true` |
| 200개 이상 응답에서 raw 제거 | raw를 직접 읽던 소비자 | `adaptive_format_threshold.json_no_raw: 0`으로 비활성 |

추가 변경:
- `guard.env_secret_patterns` 키를 제거했다. 설정에 남아 있으면 stderr에 경고하고 무시한다. `guard.secrets.env_patterns`를 사용한다.
- `yarn`은 기본 `allowed_commands`와 기본 정책에서 빠졌고 `build` 프로필에서만 허용된다.
- 기본 `allowed_commands`에 읽기 전용 명령 `free`, `id`, `lsof`, `ss`, `dig`를 추가했다. 프로젝트 설정이 가드를 넓히지 못하므로 파서가 있는 명령을 기본 목록에 둔다.
- 실행 디렉터리가 `/`이면 기본 `allowed_paths`는 홈 디렉터리이며 stderr에 경고한다.
- 숫자가 아닌 `PARISM_TIMEOUT_MS`, `PARISM_MAX_OUTPUT_BYTES`, `PARISM_MAX_ITEMS`, `PARISM_DEFAULT_PAGE_SIZE`, `PARISM_ADAPTIVE_FORMAT_*` 값은 무시하고 stderr에 경고한다.
- 객체 프로토타입 키 이름(`constructor` 등)의 명령은 정책이 없는 명령으로 검사한다.
- `failure.reason`에 `output_overflow`(출력이 실행기 버퍼 상한을 넘음)가 추가됐다.
- `package.json`의 `files`에서 `prism.config.json`을 뺐다. 저장소의 `prism.config.json`은 예시이며 패키지에 포함되지 않는다.

### Added
- `guard.profile`(`readonly` 기본, `build`)과 `guard.command_policies`: 명령별 서브커맨드·플래그·위치 인자 허용목록.
- `trust_project_config`: 전역 설정에서만 켤 수 있는 프로젝트 설정 신뢰 옵션.
- 파서 계약 `ParserContract`(`supports`, `headerLines`, `noise`)와 실패 사유 `unsupported_format`, `unrecognized_output`.
- `run_paged` 실행 결과 재사용: 같은 명령의 후속 페이지는 30초 안에서 재실행하지 않으며 `page_info.cache = { hit, age_ms }`로 알린다. 성공한 실행만 저장하고 `includeDiff`가 다르면 따로 저장한다. 최대 16항목, 합계 32 MiB, LRU.
- `ls` 파서의 `char_device`, `block_device` 유형과 `target`, `free` 파서의 `*_bytes` 필드, `apt` 파서의 `suite` 필드.

### Changed
- 적응형 포맷: `json_no_raw` 임계값 이상이면 compact이면서 raw를 비우고, `compact` 임계값 이상이면 compact로 응답한다.
- 실행기: stderr에도 `max_output_bytes`를 적용하고 버퍼 상한 초과를 `output_overflow`로 분류한다.
- 파서: `ls`(setuid, sticky, 장치, ACL, 심볼릭 링크), `free`(단위 환산), `id -u/-g/-G`, `grep`(출력 형식 판정, 옵션 값을 파일 인자로 세지 않음), `git`(앞에 오는 전역 옵션을 건너뛰고 서브커맨드 판정), `npm ls`(ASCII 트리), `netstat`(UDP), `uname -a`, `apt`(`name`과 `suite` 분리), `tree`(들여쓰기 기반 디렉터리 판정), `systemctl list-units`(대기 작업이 있을 때 붙는 `JOB` 열과 `job` 필드).
- `curl`: `-w`/`--write-out` 값의 `%output{` 지시어를 차단한다.
- `git`: 서브커맨드 조회가 객체 프로토타입 키에 영향을 받지 않는다.
- `@modelcontextprotocol/sdk`를 1.31.0으로 갱신했다.

### Removed
- `guard.env_secret_patterns`(위 Breaking 참조).

### Known limitations
- `ls`는 `-h`/`--si`, `--time-style` 변형을 처리하지 않는다(`unsupported_format` 또는 `unrecognized_output`).
- `tree`는 비어 있는 디렉터리를 파일로 분류한다.
- `uname`은 `-a` 외 단일 옵션 출력을 해석하지 않는다.

### Documentation
- `SECURITY.md` 위협 모델을 argv 허용목록 기준으로 다시 썼다.
- `docs/adr/2026-07-21-external-parser-sandbox.md`의 격리 방식을 `worker_threads` 또는 `child_process.fork`로 바꿨다.

## [1.1.0] - 2026-07-21

### Added
- `describe` MCP 도구 — 허용 명령, 사용 가능 파서, guard 제한, 버전 정보를 단일 호출로 반환. 에이전트 온보딩에 사용.
- `dry_run` MCP 도구 — 실제 실행 없이 guard 통과 여부만 확인. `would_pass`, `reason`, `message` 반환.
- `TelemetryField` 타입 (`types/envelope.ts`) — `guard_ms`, `exec_ms`, `parse_ms`, `redact_ms`, `total_ms`, `raw_bytes` 단계별 성능 메트릭.
- `PipelineTimer` 유틸 (`src/engine/telemetry.ts`) — `performance.now()` 기반 파이프라인 스톱워치.
- `PrismTelemetryConfig` 설정 (`config/loader.ts`) — `config.telemetry.enabled` 로 텔레메트리 활성화.
- `ResponseEnvelope.telemetry?` 필드 — `config.telemetry.enabled=true` 시에만 응답 봉투에 포함.
- `ParismEngine.describe()` / `ParismEngine.dryRun()` 메서드 — 라이브러리 모드에서도 사용 가능.
- `src/version.ts` — `PACKAGE_VERSION` 상수를 독립 모듈로 분리하여 순환 의존성 방지.
- `ParserRegistry.listCommands()` — 내장 파서 43종의 명령 이름 목록 반환.
- `createEngine({ configPath })` — 지정된 설정 파일 경로를 단일 로더로 로드하여 `ParismEngine` 인스턴스에 반영. 미지정 시 기존 multi-layer 로드 유지.

### Changed
- `MCP_INSTRUCTIONS` 에 `describe`, `dry_run` 도구 안내 추가 및 사용 순서 권고 (describe 먼저 호출).
- `ParismEngine.run()` 에 텔레메트리 계측 삽입 (guard/exec/parse/redact 각 단계 타이밍).
- `describe().available_parsers` — 내장 파서 43종 명령 이름과 등록된 커스텀 ParserPack 이름을 합쳐 반환.
- `DEFAULT_CONFIG.telemetry`, `loadConfig()`, `loadConfigMultiLayer()`/`mergeConfig()` — `telemetry` 필드를 설정 로딩 경로 전체에 포함. `envToConfig()` 에 `PARISM_TELEMETRY_ENABLED` 처리 추가로 설정 파일 또는 환경 변수로 `telemetry.enabled` 활성화 가능.
- `PATH_TAKING_COMMANDS` 에 `node`, `npx`, `npm` 추가 — 슬래시로 시작하지 않는 상대경로 스크립트 인자도 `allowed_paths` 경로 검사 대상에 포함.
- 배포 `prism.config.json` 의 `guard.block_patterns` 를 DEFAULT_CONFIG 수준으로 복원.

### Fixed
- `envToConfig()` — `PARISM_*` 환경 변수 미설정 시 빈 배열이 이전 설정 레이어를 덮어쓰던 버그 수정. `Partial<PrismGuardConfig>` 사용하여 실제 설정된 필드만 emit.
- Guard 인젝션 패턴 검사 — `args.join(" ")` 방식에서 개별 인자 순회로 변경하여 교차 경계 오탐 방지 (예: `["foo>", ">bar"]` → `>>` 오탐 제거).
- `PATH_TAKING_COMMANDS` 에 `git`, `docker`, `kubectl`, `cargo` 추가 — 경로 인자를 받는 명령의 경로 guard 검증 누락 수정.

### Documentation
- `SPECIFICATION.md` §6.6, `README.md`, `README.en.md` — 설정 3레이어 병합과 `PARISM_*` 환경 변수 오버레이 목록 기록.
- `SECURITY.md`, `SPECIFICATION.md` — `allowed_paths` 경로 인자 검사 명령 목록에 `node`, `npx`, `npm` 반영.
- `README.md` — `describe` guard_summary 필드명, `parse_error.reason` 값 집합, `parism test` 상태 표기 정정.
- `docs/adr/2026-07-21-external-parser-sandbox.md` — 외부 ParserPack 실행 격리 전략 ADR 신설.

## [1.0.0] - 2026-04-15

### Changed
- 첫 stable 릴리스. API 안정성 보장: Semantic Versioning 을 따르며, `ResponseEnvelope` 계약, `ParismEngine` 라이브러리 API, `ParserPack` SDK 는 v2.0.0 전까지 breaking change 없이 유지된다.
- v0.6.0-alpha.1 / v0.6.0-alpha.2 의 모든 개선 항목을 포함하며, alpha 레이블만 제거된다.

### Deprecated
- `guard.env_secret_patterns` 제거 예정 버전을 v0.7.0 → v2.0.0 으로 조정 (stable 릴리스 이후 breaking 정책 정합화).
- `ResponseEnvelope.guard_error` 권고 — v2.0.0 에서 제거 예정. 새 소비자는 `ResponseEnvelope.failure` 를 사용한다.

## [0.6.0-alpha.2] - 2026-04-15

### Added
- `docs/mcp-clients/` 디렉터리 — Claude Desktop, Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot CLI 6개 클라이언트 설정 가이드
- `ResponseEnvelope.guard_error?` 필드 선언 (하위 호환 유지, `failure` 필드가 권위 필드)
- `CHANGELOG.md` 에 v0.1 → v0.6.0-alpha.1 변경 이력 누적 기록

### Changed
- `MCP_INSTRUCTIONS` 에 v0.6 기능 반영 — `failure` 필드, `output_redaction_enabled`, `strict_schemas` 안내 추가 (1,496 chars, 1,500 limit 내)
- `README.md` 에 Guard 응답 예시 `failure` 필드 병기, `prism.config.json` 예시를 `guard.secrets` / `parsers.strict_schemas` 스키마로 교체, 라이브러리 모드 섹션 확장 (+47줄)
- `README.md` 에서 Claude Desktop / Cursor 개별 연동 섹션을 `docs/mcp-clients/` 로 분리하고 단일 표로 consolidation
- `SECURITY.md` 에 `failure.kind: "guard"` 권위 필드 명시, 참고 문서 블록 추가
- `SPECIFICATION.md` 변경이력 v0.6 행의 "대안" 셀에 구체적 철회 이력 기록
- `src/server.ts` `buildRunResult` / `buildPagedResult` 의 `includeDiff` 기본값을 `true` → `false` 로 정정 (@internal test helpers, MCP 도구 기본값과 일치)
- `src/facade/engine.ts` 의 `as unknown as ResponseEnvelope` 캐스트 제거

### Fixed
- `src/config/loader.ts` 의 `guard.env_secret_patterns` deprecation 주석이 `v0.6.0 제거 예정` 으로 잘못 표기되어 있던 것을 `v0.7.0 제거 예정` 으로 정정

## [0.6.0-alpha.1] - 2026-04-15

### Added
- `ResponseEnvelope.failure` 통합 실패 필드 (kind: `guard` / `exec` / `parse` / `config`)
- `guard.secrets` 설정 섹션 통합 (`env_patterns`, `output_patterns`, `output_redaction_enabled`)
- Zod 기반 `ParserPack` 스키마 계약, `config.parsers.strict_schemas` opt-in 런타임 검증
- `src/engine/redactor.ts` — 출력 시크릿 레덕션 레이어 (파싱 후 직렬화 전 단계 적용)
- `ParismEngine` 라이브러리 파사드 (`src/facade/engine.ts`), `createEngine()` 팩토리
- `package.json` `./engine` subpath export — 라이브러리 모드 개방
- `SECURITY.md` — 위협 모델, 4겹 방어선 한계, 신뢰할 수 없는 입력 격리 권고
- `SPECIFICATION.md` — 단일 소스 설계 스펙 (v0.1 → v0.6 변경 이력 포함)

### Changed
- `src/server.ts` 비즈니스 로직을 `ParismEngine` 에 위임 (237 → 129 LOC)
- `package.json` version 0.5.0 → 0.6.0-alpha.1
- 벤치마크 러너는 기존 `defaultRegistry` 경로 유지 (순수 파서 속도 측정 보존)

### Deprecated
- `guard.env_secret_patterns` → `guard.secrets.env_patterns` (v0.7.0 제거 예정)

### Security
- `output_redaction_enabled` opt-in: 활성 시 stdout/stderr raw 필드에 7 개 기본 패턴 (`sk-*`, `ghp_*`, `gho_*`, `glpat-*`, `AKIA*`, `xox[baprs]-*`, `Bearer *`) 을 `[REDACTED]` 로 치환

## [0.5.0] - 2026-03-28

### Added
- ParserPack SDK 도입, CLI 5 개 명령어 (`capture`, `init-parser`, `test`, `add`, `inspect`)
- `createRegistry()` DI 팩토리 (기존 `defaultRegistry` 싱글턴은 deprecated 유지)
- 외부 파서 자동 로더 (`~/.parism/parsers/`)

## [0.4.0] - 2026-03-12

### Changed
- 비판적 수용 피드백 반영: 경로 가드 강화, 스냅샷 성능, 문서 정합성, 파서 실패 관측 개선

## [0.3.0]

### Added
- `run_paged` 도구 및 페이지네이션 (`page_info.total_lines`, `has_next`)

## [0.2.0]

### Added
- Guard 4 겹 방어선 (화이트리스트 / 경로 / 인젝션 패턴 / 인자 플래그)

## [0.1.0] - 2026-03-06

### Added
- 초기 릴리스: MCP 서버 + execFile 게이트웨이, 내장 파서 카탈로그
