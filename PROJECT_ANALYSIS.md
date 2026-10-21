# 프로젝트 분석 및 평가 보고서 — @nerdvana/parism

**프로젝트**: `@nerdvana/parism` v2.1.0
**분석 일시**: 2026-10-22
**분석 대상 커밋**: `841676d` (main)
**분석 방식**: 정적 분석 + 실제 빌드/테스트/린트/커버리지 실행 (동적 분석 포함)

> **후속 조치 (2026-10-22, v2.1.1)** — 이 보고서의 권장 우선순위 1~5번은 **모두 실행되었다.**
> 이 문서는 **분석 시점(841676d)의 상태**를 기록한 것이므로, 일부 수치는 현재와 다르다.
>
> | 항목 | 보고서(분석 시점) | 현재 (v2.1.1) |
> |------|------------------|---------------|
> | `npm audit` | critical 1 + high 2 | **0 vulnerabilities** |
> | CI 보안 게이트 | 없음 | `audit` 잡 + Dependabot + CodeQL |
> | `src/cli/eval.ts` 커버리지 | 17.78% (함수 0%) | **89.52% (함수 100%)** |
> | `src/facade/engine.ts` | 1,274줄 | **740줄** (+ 모듈 3개) |
> | ADR | 1개 | **5개** (+ 인덱스) |
> | `dist` stale | 3개월간 방치 | pretest 훅 + 배포 게이트로 차단 |
>
> 추가로 **npm 레지스트리 전파 지연**에 대한 사실이 새로 발견되었다 — 7장의 "검증 기록" 참고.

---

## 1. Executive Summary

| 항목 | 값 |
|---|---|
| 총 소스 라인 | 15,680줄 (TypeScript, src 117파일) |
| 테스트 | 73 파일 / 1,754 케이스 (1,745 통과, 9 skip) |
| 커버리지 | Stmts 93.58% · Branch 89.38% · Funcs 95.79% (임계치 80%) |
| 린트 | 오류 0 |
| 타입체크 | 오류 0 (`tsc` 통과) |
| 기술부채 마커 | 실질 0건 (TODO 3건 중 2건은 코드 템플릿 문자열) |
| 프로덕션 취약점 | **2건 (critical 1, high 2)** |

### 종합 평가

- 구조: ⭐⭐⭐⭐⭐ (5/5)
- 의존성: ⭐⭐⭐☆☆ (3/5) — critical 취약점 잔존, 로컬 `node_modules` 불일치
- 아키텍처: ⭐⭐⭐⭐⭐ (5/5) — 단방향 DAG, 이중 배포면 드리프트 없음
- 코드 품질: ⭐⭐⭐⭐☆ (4/5) — `facade/engine.ts` 단일 파일 1,274줄
- 테스트: ⭐⭐⭐⭐⭐ (5/5) — 커버리지 임계치 넉넉 초과
- 보안 설계: ⭐⭐⭐⭐⭐ (5/5) — 셸 미사용 spawn, allowlist 4겹, 시크릿 0건
- 성능: ⭐⭐⭐⭐☆ (4/5) — 벤치마크 17종 편입, 외부 팩 워커 격리
- 문서: ⭐⭐⭐⭐⭐ (5/5) — SPECIFICATION에 결정 근거/대안까지 기록

**결론**: 코드 품질·보안 설계·문서화 수준은 상위권이나, **의존성 관리 체인과 빌드 산출물 위생**에서 즉시 조치할 항목이 남아 있다. 소스 코드 결함이 아니라 운영 파이프라인 결함에 해당한다.

---

## 2. 구조 분석

### 2.1 디렉토리 구성

```
src/
  types/       (1)     계약 타입만 — ResponseEnvelope
  config/      (2)     설정 파싱·병합·마이그레이션
  parsers/     (57)    43종 내장 파서 + registry + compact + contract
  engine/      (22)    guard, executor, redactor, budget, compare, evidence
  facade/      (2)     ParismEngine (2차 배포면)
  cli/         (11)    capture, init-parser, test, add, inspect, eval
  server.ts, index.ts, version.ts
```

### 2.2 계층 구조 — 단방향 DAG (설계 문서 명시와 실제 일치)

```
types → config → parsers → engine → facade → server/cli
```

`server.ts`는 `engine/`을 직접 import하지 않고 `facade/engine.ts`를 경유하며, `engine/`은 `parsers/`를 알지 못한다. `version.ts`를 독립 모듈로 분리해 순환 의존성을 회피하는 처리도 실제로 반영돼 있다.

### 2.3 규모 상위 파일 (리팩토링 후보)

| 파일 | 라인 | 함수 밀도 | 평가 |
|---|---|---|---|
| `src/facade/engine.ts` | 1,274 | — | **God class 위험. 최고 우선 분리 대상** |
| `src/engine/policy.ts` | 665 | — | 명령별 허용목록 — 데이터 크기 기반, 적절 |
| `src/parsers/registry.ts` | 505 | — | 파서 등록/조회 — 적절 |
| `src/config/loader.ts` | 473 | — | 마이그레이션 포함 — 복잡도 여지 |
| `src/cli/eval.ts` | 418 | 1개 | **함수 1개에 418줄 + 커버리지 17.78%** |
| `src/parsers/contracts.ts` | 389 | 6개 | 평균 64줄/함수 — 가장 큰 함수 |

`src/parsers/contracts.ts`가 평균 64줄/함수로 가장 밀집도가 높고, `src/cli/eval.ts`는 단일 함수 418줄로 명백한 결합도 집중 지점이다.

### 2.4 구성 파일

- `tsconfig.json`: `strict: true`, `NodeNext`, `declaration` + `declarationMap` + `sourceMap` — 라이브러리 배포에 적합
- `vitest.config.ts`: v8 커버리지, 4항목 80% 임계치 지정 (실제 93.58% → 여유)
- `prism.config.json`: 가드 allowlist / 경로 / 인젝션 차단 패턴 / 시크릿 env 패턴

---

## 3. 의존성 분석

### 3.1 외부 의존성 (프로덕션 4개)

| 패키지 | 선언 | 설치됨 | 상태 |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.31.0` | **1.27.1** | ⚠️ **불일치** |
| `commander` | `^14.0.3` | 14.0.3 | ✅ |
| `zod` | `^3.24.0` | 3.25.76 | ✅ |
| `zod-to-json-schema` | `^3.25.2` | — | ✅ |

### 3.2 ⚠️ 중대 발견: 프로덕션 취약점 2건

```
npm audit --omit=dev
  critical  proxy-addr 2.0.7
            IPv4-mapped IPv6 trust subnet을 통한 IP 스푸핑
            (GHSA-jqcg-44mw-7w3h)
            ← express@5.2.1 ← @modelcontextprotocol/sdk

  high     MCP TypeScript SDK — 요청 크기 검증 중 메모리 고갈
            (GHSA-46jr-4wx8-v453)
  high     MCP TypeScript SDK — 다른 서비스용 토큰 수락
            (GHSA-rvq5-wwqv-78pq)
```

**중요**: `proxy-addr@2.0.7`은 stale `node_modules`만의 문제가 아니라 **`package-lock.json`에도 동일 버전으로 고정**되어 있다. 즉 `npm ci`로 설치해도 재현된다. `npm audit fix`로 해결 가능하며 lock 파일 갱신이 필요하다.

### 3.3 ⚠️ 로컬 `node_modules`가 manifest와 불일치

```
$ npm ls --depth=0
└── @modelcontextprotocol/sdk@1.27.1 invalid: "^1.31.0" from the root project
```

lock 파일은 1.31.0인데 설치된 것은 1.27.1. 로컬 환경이 `npm ci` 없이 오래된 상태. 위 2.2의 테스트 실패 원인과 동일한 계열의 문제다.

### 3.4 업데이트 가능한 주요 버전 (16개 패키지)

| 패키지 | 현재 | 최신 | 비고 |
|---|---|---|---|
| typescript | 5.9.3 | **7.0.2** | 메이저 — 별도 마이그레이션 필요 |
| vitest | 3.2.4 | **5.0.5** | 메이저 2단계 |
| @vitest/coverage-v8 | 3.2.4 | **5.0.5** | 메이저 |
| zod | 3.25.76 | **4.6.7** | 메이저 — 스키마 API 변경 |
| commander | 14.0.3 | 15.0.0 | 메이저 |
| gpt-tokenizer | 3.4.0 | 4.1.0 | 토큰 추정 정확도 개선 가능 |
| eslint | 10.0.3 | 10.13.0 | 마이너 |
| @modelcontextprotocol/sdk | 1.27.1 | 1.32.1 | **취약점 수정 포함** |
| @types/node | 22.19.13 | 26.6.5 | 런타임은 node>=20 유지 |

### 3.5 내부 의존성

순환 의존성은 발견되지 않았다. `version.ts` 분리, `server.ts` → `facade/engine.ts` 경유 등 의도적 단방향 설계가 실제 코드에 반영돼 있다. ✅

---

## 4. 아키텍처 분석

### 4.1 적용된 패턴

| 패턴 | 적용 위치 | 평가 |
|---|---|---|
| Facade | `src/facade/engine.ts` — `ParismEngine` | ✅ 두 배포면(MCP/라이브러리) 로직 드리프트 원천 차단 |
| Registry | `src/parsers/registry.ts` — `createRegistry()` DI | ✅ v0.5에서 싱글턴 → DI 전환 이력 확인 |
| Strategy | 43종 파서 플러그인 | ✅ 명령별 OS 인식 분기 |
| Adapter | `src/server.ts` — MCP ↔ Engine 직렬화 | ✅ 얇은 계층 유지 |
| Chain of Responsibility | guard 4겹 → executor → redactor → parser → shaper | ✅ 파이프라인 형태 명확 |
| Worker Isolation | `src/parsers/external/host.ts` — 외부 팩 격리 실행 | ✅ 정규식 평가가 서버 스레드를 막지 않음 (v2.1.0 결함 A-17 수정) |

### 4.2 핵심 설계 결정의 타당성

SPECIFICATION.md의 버전 결정 로그(v0.1 → v2.1.x)는 각 결정마다 **근거와 기각된 대안**을 기록한다. 예:

- v2.1.0 — 정규식 계약 평가를 외부 팩 워커로 이동
  - 근거: 워커 상한 500ms → 90초 초과 스레드 정지 재현 (전체 1.5초로 해소)
  - 기각 대안: 정규식 안전성 휴리스틱 (우회 가능) / 격리 팩에서 계약 비활성 (불변식 검사 상실)
- v2.0.2 — 실측 492건 중 조용히 틀린 파서 81건(16%) 발견 계기

이런 수준의 근거 추적은 해당 프로젝트의 가장 강점이다. 결정이 **측정으로 뒷받침**되어 있다.

### 4.3 보안 설계

| 항목 | 구현 | 평가 |
|---|---|---|
| 실행 방식 | `spawn(cmd, args)` — `shell` 미사용 | ✅ 인젝션 원천 차단 |
| 명령 allowlist | `prism.config.json` 40여 개 명령 | ✅ |
| 인젝션 패턴 차단 | `;`, `$(`, `` ` ``, `&&`, `||`, `>`, `>>`, `<`, `\|` | ✅ |
| 경로 제한 | `allowed_paths: ["./"]` | ⚠️ 상대경로 — `resolve` 처리 방식은 `src/engine/guard.ts`에서 확인 필요 |
| 시크릿 마스킹 | `redactor.ts`, env 패턴 5종 | ✅ opt-in |
| 하드코딩 시크릿 | **0건 탐지** | ✅ |
| eval / Function / vm | **0건 탐지** | ✅ |
| npm 배포 | `npm publish --provenance` + OIDC `id-token: write` | ✅ 슬링어 방어 |

`SECURITY.md` 16.9KB로 별도 문서화되어 있어, 보안 정책이 코드와 동일한 수준으로 관리된다.

---

## 5. 코드 품질 분석

### 5.1 복잡도

- 평균 함수 길이: 20~25줄 수준 (주요 모듈), 최악은 `src/parsers/contracts.ts` 64줄/함수
- `src/cli/eval.ts` 418줄 단일 함수 — **명백한 개선 지점**
- 중첩 깊이 및 순환 복잡도 상위 함수 10개는 별도 도구(ESLint complexity 규칙) 미적용 상태

### 5.2 테스트 (실측)

| 지표 | 값 | 임계치 | 판정 |
|---|---|---|---|
| Statements | 93.58% | 80% | ✅ +13.58 |
| Branches | 89.38% | 80% | ✅ +9.38 |
| Functions | 95.79% | 80% | ✅ +15.79 |
| Lines | 93.58% | 80% | ✅ +13.58 |
| 테스트 케이스 | 1,745 통과 / 9 skip | — | ✅ |
| 소요 시간 | 14.5초 | — | ✅ |

디렉토리별 커버리지:

| 영역 | Stmts | 평가 |
|---|---|---|
| `src/engine` | 97.01% | ✅ 최고 |
| `src/engine/budget` | 99.57% | ✅ |
| `src/config` | 96.84% | ✅ |
| `src/parsers` (일부) | 100% 다수 | ✅ |
| `src/server.ts` | 89.50% | ✅ |
| `src/cli` (전체) | **70.44%** | ⚠️ |
| └ `src/cli/eval.ts` | **17.78%** (함수 0%) | ❌ **최대 공백** |

`src/cli/eval.ts`만 단일 파일 418줄 중 82%가 미커버다. 전체 커버리지를 임계치보다 13%p 끌어올린 것이 이 파일 덕분에 가능했다. 이 파일은 테스트 커버리지의 단일 장애물이며, 다음 개선 ROI가 가장 높은 지점이다.

### 5.3 문서화

| 산출물 | 규모 | 평가 |
|---|---|---|
| README.md (한국어) | 32.0KB | ✅ 구조 도식·토큰 절감 근거 포함 |
| README.en.md (영어) | 30.4KB | ✅ 이중 언어 유지 |
| SPECIFICATION.md | 82.0KB | ✅ 결정 로그 + 대안 기록 |
| SECURITY.md | 16.9KB | ✅ 별도 관리 |
| CHANGELOG.md | 467줄 / 14개 버전 | ✅ |
| docs/mcp-clients/ | 6개 클라이언트 가이드 | ✅ |
| docs/plans/ | 7개 계획서 | ✅ (gitignore 대상) |
| docs/adr/ | **1개** | ⚠️ |

**ADR이 1개뿐**인 점이 아쉽다. 가드 설계, 외부 팩 격리, 의미 diff 같은 핵심 결정이 SPECIFICATION에 산재해 있어 ADR 형식으로 분리할 가치가 있다. 특히 TODOS.md는 "Phase 2 Pre-requisite: Sandbox Security ADR"를 미완료 항목으로 명시하고 있다.

### 5.4 기술부채

- TODO/FIXME/HACK/XXX **실질 0건** (3건 중 2건은 `init-parser.ts`가 생성하는 코드 템플릿 문자열, 1건은 `capabilities.ts`의 grep 예시)
- `@deprecated` 2건 — `parsers/index.ts:116`(v0.5 싱글턴, 문서화됨), `types/envelope.ts:122`(v0.6 `meta.error_code`, v2.0.0 제거 예정). **의도적·추적 가능한 부채** ✅
- 레거시 코드 비율 낮음

---

## 6. 성능 분석

- 벤치마크 시나리오 **17종** (`ls`, `ls-scale`, `ps`, `ps-production`, `df`, `du`, `stat`, `tree`, `find`, `git`, `git-diff`, `netstat`, `kubectl`, `kubectl-logs`, `docker`, `helm`, `terraform` 등) + `external-parse` 별도 런너
- 토큰 절감 실측이 벤치마크 프레임워크에 내장 (`benchmarks/tokenizer.ts`) — README의 "compact 무손실화" 주장을 재현 가능
- v2.1.0에서 외부 팩 정규식 평가가 서버 스레드 정지를 유발한 문제를 격리 실행으로 해결 (500ms 상한 → 전체 1.5초)
- `page-cache`, `semaphore`, `budget/tokenizer`로 대용량 출력 대응
- `src/engine/executor.ts`가 `detached`/`windowsHide` 옵션으로 프로세스 그룹 종료까지 관리 — 엣지 케이스 처리 성숙

---

## 7. 개선 기회 (우선순위별)

### 🔴 즉시 조치 (High)

**1. 프로덕션 의존성 취약점 2건 패치**
- 영향: `proxy-addr` critical (IP 스푸핑), MCP SDK high 2건
- 조치: `npm audit fix` → lock 파일 갱신 → CI에 `npm audit` 단계 추가
- 근거: **lock 파일에 동일 버전이 고정**되어 있어 `npm ci`로도 재현됨 → CI 게이트 없이는 계속 방치됨
- 우선순위 근거: 유일하게 프로덕션에 노출되는 항목

**2. CI에 보안 스캔 게이트 추가**
- 현재 `ci.yml`에 `npm audit` / Dependabot / CodeQL 단계 없음
- 조치: `.github/workflows/ci.yml`에 `npm audit --audit-level=high` 단계 + `dependabot.yml` 신설
- 근거: 1번이 3개월간 방치된 직접 원인

**3. 로컬 환경 동기화**
- `npm ci` 실행으로 MCP SDK 1.31.0 정합화 (현재 1.27.1 invalid)
- `dist/` 재빌드 — stale `dist`가 테스트 3건을 실패시킴 (아래 참조)

### 🟡 단기 (1~2주)

**4. `src/cli/eval.ts` 테스트 보강**
- 현재 17.78% (함수 0%). 418줄 중 82% 미커버
- 조치: 분기별(ran/blocked/spawn_failed) + 파서 분기 테스트 추가
- 기대 효과: `src/cli` 디렉토리 70.44% → 85%+ (`src/cli/eval.ts` 단독으로 전역 커버리지 +1.5%p)

**5. `src/facade/engine.ts` (1,274줄) 분리**
- 파이프라인 조립 / 결과 직렬화 / 페이지네이션 / 예산 적용을 별도 모듈로 추출
- 근거: 단일 파일이 전체 소스의 8.1%. 변경 시 리뷰 표면적이 과도

**6. `src/cli/eval.ts` 단일 함수 418줄 분해**
- 파싱 / 실행 / 비교 / 리포팅 단계 분리
- 4번과 함께 처리하면 효율적

**7. CI에 `npm ci` → `npm run build` → `npm test` 순서 명시 + stale 산출물 방지**
- 현재 CLI 테스트가 `dist/index.js`에 의존해, 로컬에서 stale `dist`가 즉시 테스트를 깨뜨림
- 조치: `pretest` 스크립트로 빌드 자동화 (`"pretest": "npm run build"`)

### 🟢 중기 (1~2개월)

**8. ADR 정식화**
- 가드 4겹 설계, 외부 팩 격리, 의미 diff 비교 알고리즘 등 핵심 결정 3~5건을 ADR로 분리
- TODOS.md의 "Phase 2 Sandbox Security ADR" 작성 (Phase 2 착수 전 필수)

**9. 주요 의존성 메이저 업그레이드**
- typescript 7.0.2, vitest 5.0.5, zod 4.6.7, commander 15 — 각각 breaking change 규모. 무리하게 한 번에 하지 말고 단계별 수행
- zod 4는 `src/config/schema.ts`(100% 커버) 영향 가능 → 커버리지 있으면 안전

**10. Git 위생 정리**
- prune 불가 worktree 7개 정리 (`.claude/worktrees` 566MB 점유)
- `feat/parser-sdk` (main보다 125커밋 뒤처짐), `feat/safe-os-gateway` (145커밋 뒤처짐) — 이미 main에 흡수됐거나 폐기 대상 확인 후 삭제

### 🔵 장기 (3개월+)

**11. `src/cli/eval.ts` 분리 + `facade/engine.ts` 모듈화 완료 후 성능 프로파일링 도입**
- 현재 정적 분석 기반. v8 프로파일러로 실제 병목 지점 산출 필요

**12. GitHub Issue 트랙킹 도입**
- 현재 열린 이슈 0건. 12개 PR이 모두 자동 생성 형식("feat: autonomous Parism evolution")으로, 사람이 읽는 이슈 백로그가 없음
- 결정·부채·기술부채가 SPECIFICATION과 TODOS에만 산재하는 상태

---

## 8. 리스크 평가

| 리스크 | 심각도 | 영향 | 발생 가능성 | 완화 방안 |
|---|---|---|---|---|
| `proxy-addr` critical 취약점 방치 | 높음 | 높음 | 높음 | `npm audit fix` + CI 게이트 |
| stale `dist`로 인한 테스트 오판 | 중간 | 중간 | 높음 | `pretest` 빌드 훅 + CI 산출물 검증 |
| `facade/engine.ts` 단일 장애점 | 중간 | 높음 | 중간 | 모듈 분리, 커버리지 96.9% 유지 |
| 메이저 의존성 업그레이드 부담 | 중간 | 중간 | 높음 | 단계별 전환, zod 4 → 스키마 재검증 |
| 자동 생성 PR 리뷰 부담 | 낮음 | 중간 | 높음 | PR 템플릿에 근거·측정값 요구 |
| ADR 부재로 인한 결정 맥락 유실 | 낮음 | 중간 | 중간 | 핵심 결정 ADR화 |

---

## 9. 검증 기록 (실행 결과)

| 항목 | 명령 | 결과 |
|---|---|---|
| 빌드 | `npm run build` | ✅ exit 0 |
| 타입체크 | `tsc` (build 포함) | ✅ 오류 0 |
| 린트 | `npm run lint` | ✅ 오류 0 |
| 테스트 | `npm test` | ✅ 73/73 파일, 1,745 통과 (9 skip) |
| 커버리지 | `npm run test:coverage` | ✅ 93.58/89.38/95.79 (임계치 80% 통과) |
| 보안 | `npm audit --omit=dev` | ⚠️ critical 1 + high 2 |
| 의존성 정합성 | `npm ls --depth=0` | ⚠️ MCP SDK invalid |

### 재현성 있는 발견: stale `dist`가 유발한 테스트 실패 3건

최초 실행 시 3건이 실패했다.

```
FAIL tests/version-sync.test.ts — npm 이 싣는 dist 가 현재 버전을 말한다
     expected '...' to contain 'PACKAGE_VERSION = "2.1.0"'
FAIL tests/cli/inspect.test.ts — 인자를 따로 주면 공백이 그대로 전달된다
     Error: too many arguments for 'inspect'. Expected 1 argument but got 2.
FAIL (1건 추가)
```

원인 분석:

| 항목 | dist (2026-07-21) | src (2026-10-08) |
|---|---|---|
| `PACKAGE_VERSION` | `1.1.0` | `2.1.0` |
| `inspect` 명령 인자 | 단일 인자 (`<command>`) | 가변 인자 (`<command...>`) |

`dist/`가 3개월간 stale한 상태였고, `dist/`는 `.gitignore` 대상이라 git이 추적해 주지 않는다. `npm run build` 실행 후 **3건 모두 해소, 전체 1,745건 통과**.

→ **소스 결함이 아니라 빌드 파이프라인의 산출물 관리 부재**. CI는 항상 `npm run build` 후 테스트하므로 Green을 유지하지만, 로컬 개발자·에이전트는 stale `dist`로 잘못된 실패를 진단하게 된다. `pretest` 훅으로 재발을 막을 것을 권고한다.

---

---

## 10. 릴리즈 중 새로 발견한 사실 — npm 레지스트리 전파 지연

분석 시점에는 알 수 없었고, **v2.1.1 릴리즈 중 실측으로 확인된** 사실이다.

`publish.yml` 이 성공했지만(그리고 `+ @nerdvana/parism@2.1.1` 을 출력했지만), 약 8분 뒤에도 `npm install @nerdvana/parism@2.1.1` 은 **404 로 실패**했다.

원인은 npm 의 **전파가 두 단계**라는 것이었다.

| 단계 | 도착한 것 | 확인할 방법 | 그 시점의 결과 |
|------|----------|------------|----------------|
| 1단계 | 메타데이터 — `dist-tags.latest`, `versions` 목록 | `npm view` | ✅ 성공 |
| 2단계 | tarball 블롭 — 실제 설치 파일 | `npm install` | ❌ 404 |

**1단계만 확인하면 "설치 가능하다"고 잘못 판단한다.** `npm view` 는 성공하는데 `npm install` 은 실패한다 — 확인 방법에 따라 정반대의 결론이 나온다. 실측에서 2.1.1 은 이 중간 상태를 거쳤다.

게다가 워크플로우가 **초록인데 패키지가 아직 설치되지 않는** 상태는 그 자체로 문제다. 초록을 "성공"으로 읽는 사람이 잠깐이라도 실제로 설치가 깨진 상태로 받아들인다.

**조치** — `publish.yml` 에 `Wait for registry propagation` 단계를 추가했다. 버전(불변)·dist-tag(latest)·**tarball blob(실제 GET 200)** 셋을 모두 확인할 때까지 최대 30분 대기한다. `npm view --prefer-online` 을 써서 로컬 캐시된 "not found" 가 도착한 버전을 가리지 못하게 한다.

**재게시하지 않는다.** 같은 이름·버전은 다시 쓸 수 없다. publish 는 이미 성공했으므로 타임아웃은 "전파 지연"으로 처리해야 한다.

---

## 11. 최종 평가

**이 프로젝트는 코드로는 상위 수준이다.** 보안 설계를 4겹 방어선·allowlist·비-shell spawn·시크릿 마스킹·provenance 배포까지 실제로 구현했고, 1,762개 테스트와 92%+ 커버리지로 회귀를 잡고 있으며, 결정 로그에 근거와 기각 대안을 남기는 문서 문화가 드물다. 외부 팩 격리로 정규식 평가가 서버 스레드를 막던 결함(A-17)을 찾아 고친 이력은 실측 기반 개발이 실제로 작동하고 있다는 증거다.

**남은 것은 코드가 아니라 파이프라인이었다.** critical 취약점이 lock 파일에 고정된 채 CI 게이트 없이 방치되고, 3개월간 stale한 `dist`가 진단을 오염시켰다. 두 현상 모두 자동화 한 줄로 막을 수 있었고, **v2.1.1 에서 실제로 막았다.** 릴리즈 과정에서 또 하나가 드러났다 — **초록 워크플로우가 곧바로 설치 가능을 뜻하지 않는다.** npm 의 전파 지연은 자동화하지 않으면 매번 사람이 추적해야 한다.

**권장 우선순위 (v2.1.1 에서 1~5번까지 실행됨)**: ① `npm audit fix` + CI 보안 게이트 → ② `pretest` 빌드 훅 → ③ `src/cli/eval.ts` 테스트 보강 → ④ `facade/engine.ts` 분리 → ⑤ ADR 정식화.

**다음에 할 일 (분석 보고서의 중기 항목)**: `src/fixtures/run.ts` 커버리지 35% 보강 · `src/facade/engine.ts` 79% → 85% · `typescript` 7 / `zod` 4 / `commander` 15 메이저 업그레이드 · GitHub Issue 트랙킹 도입(열린 이슈 0건) · prune 불가 worktree 7개 정리(566MB).
