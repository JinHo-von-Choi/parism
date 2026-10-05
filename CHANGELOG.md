# Changelog

모든 주요 변경사항은 이 파일에 기록된다.

이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따르며,
포맷은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따른다.

## [Unreleased]

### Added — M1 근거 조회
- **근거 조회(`contract_version: 'next'` + `explain_result`)** — 계획서 5장 M1. `run` 에 `contract_version`, `evidence`, `retain` 인자를 추가했다. `review` 는 기존 봉투 필드의 뜻을 바꾸지 않고 옆에 붙는다: `result_id`, `parser_id`, `content_hash`, `schema_version`, `source_complete`, `parse_complete`, `representation_lossless`, `privacy_transform`, `retained`, `warnings`. 완성도는 `true`/`false`/**`unknown`** 세 값을 쓴다 — 확인하지 못한 것을 거짓으로 말하지 않기 위해 `unknown` 을 도입했다.
- 필드 근거는 **마스킹된 정규 원문의 UTF-8 바이트 구간**으로 준다. 원문에 그대로 있는 값은 `verbatim`, 변환이 끼면 `derived` 로 밝히고 그 변환(`parseInt`, `trim`, `strip_tree_prefix`)을 함께 준다. 구간이 정말 그 값을 담는지 검증해 맞지 않으면 근거가 아니라 "근거 없음"으로 남긴다.
- 결과 저장은 서버 인스턴스·세션에 묶인 메모리 TTL/LRU 이다(결과당 2MiB, 합계 32MiB, 16개, 60초). **보관한 결과도 재실행하지 않는다** — 모르는 id 나 만료된 id 는 그 사실과 함께 실패를 돌려준다.
- MCP 도구 `explain_result(result_id, pointer)` 추가. `run` 에 `retain: true` 와 함께 쓸 때만 작동한다.
- `ps` 파서가 근거를 만든다(열 위치가 고정이라 정확하다). 근거는 V8 정규식 `d` 플래그로 얻은 캡처 그룹 위치에서 나온다.
- **`git status --porcelain` 파서와 근거.** 계획서 5장 근거 조회 MVP 의 두 번째. `-z` 는 경로를 가공 없이 내고 NUL 로 레코드를 나누지만, **`-z` 없이 쓰면 줄 구분 + C 스타일 이스케이프 + 따옴표**로 온다. 실측 그대로: 개행 구분 `?? "line\nbreak.txt"`, `-z` `?? line<LF>break.txt`(따옴표 없음). 두 형식을 같은 파서가 읽되 레코드 경계·경로 해석·이름 변경 표기를 나눠 처리한다. 줄 모드에서만 항목에 `quoted: true` 가 붙어 **출력이 가공되었음을 값으로 밝힌다.**
- porcelain 결과는 행 배열(`entries`)로 파싱한다. 각 항목은 `xy`(두 자리 상태), `index`, `worktree`, `path`, 이름 변경·복사 시 `orig_path`. 이름 변경 표기는 형식마다 다르다 — **새 경로가 먼저**이고 원래 경로가 뒤다: `-z` 는 다음 NUL 레코드(`RM renamed.txt<NUL>keep.txt<NUL>`), 줄 모드는 한 줄의 ` -> `(실측: `R  old.txt -> new.txt`). 경로 자체에 `' -> '` 가 들어갈 수 있어 화살표는 **오른쪽에서** 찾는다. 스테이징 안 됨은 공백으로 오므로(`" M src/a.ts"`) 상태 문자 인식에 공백을 넣어야 한다.
- 이 형식의 근거는 **레코드 번호**를 함께 준다. 레코드가 NUL 로 나뉘므로 줄 번호가 통하지 않기 때문이다. 경로에 개행이 있어도 근거 구간이 정확하다 — 줄로 나누어 계산하면 어긋나는 자리다. 줄 모드에서 이스케이프가 풀린 경로는 근거가 원문의 **따옴표 구간**을 가리키고 `transform: 'unescape_c_quotes'` 로 그 변환을 밝힌다.
- `git` 에 `-z`, `--null`, `--branch`, `--verbose`, `-u`, `--untracked-files` 를 가드 정책에 열었다. 파서 계약이 받겠다고 안내하던 인자를 가드가 막아 안내가 거짓말이 되던 곳이다.

### Added — M2 토큰 예산
- **토큰 예산과 누락 내역(`budget`)** — 계획서 6장 M2. 큰 명령 결과를 예산 안에 받으면서 **무엇이 빠졌는지** 알 수 있다. 핵심은 "예산 때문에 사라진 정보"와 "파서 오류 때문에 사라진 정보"를 섞지 않는 것이다. `budget: { max_tokens, tokenizer, required_fields, overflow: 'page' | 'error' }`.
- 응답에 `budget` 보고(`requested`, `measured_tokens`, `tokenizer_id`, `tokenizer_version`, `budget_met`, `tokenizer_exact`, `tokenizer_scope`)와 `omission` 목록이 실린다. omission 은 `stage`('capture'|'parse'|'projection'|'budget'|'privacy')와 `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `unknown_counts`, `next_cursor` 를 구분해 담는다.
- **고정 토크나이저**(`parism/approx`)를 제품 계약으로 넣고 ID·버전·적용 범위를 결과에 노출한다. 새 런타임 의존성은 없다. `byte` 모드는 문자 수로 재 문자 단위로 정확하다. **지원하지 않는 토크나이저는 조용히 대체하지 않고 `tokenizer_unsupported` 로 거절한다** — 추정을 정확한 예산으로 포장하지 않는다. 이 약속은 parism JSON payload 에만 성립하며 전송·클라이언트·모델 내부 토큰은 포함하지 않는다(`tokenizer_scope` 에 밝힌다).
- `fetch_result(result_id, cursor, budget)` 추가 — 재실행 없이 같은 결과의 다음 페이지를 돌려준다. cursor 는 진행 규칙(스냅샷 identity·투영·정책·스키마)과 위치를 함께 묶고 서명된 형태로 실려 **클라이언트가 임의 오프셋을 조립할 수 없다**. 이미 만료·퇴출된 id 는 그 사실과 함께 거절하고 자동 재실행하지 않는다.
- 필수 필드(`required_fields`)는 예산이 빡빡해도 남는다. 파서가 선언한 행 identity 도 생략하지 않는다. **필수 필드가 없으면 조용히 일부만 내보내지 않고 명시적으로 실패한다** — 부분 성공은 조용한 손실이다.
- 예산이 최소 봉투(약 1,200 토큰)에 못 미치면 **실행 전에** `budget_too_small` 로 거절한다. 실행해 놓고 나서야 알리면 명령만 돌고 아무 값도 못 받는 결과가 된다.

### Added — M3 의미 diff
- **의미 diff(`compare_results`)** — 계획서 7장 M3. **이미 존재하는 두 결과만 비교한다.** 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다. 결과에 `comparable`, `refusals`(사유·무시한 차이), `added`, `removed`, `changed`, `unchanged_count`, `ignored_fields`, `partial`, `key_conflicts` 를 담고, 필드 변화에는 이전·현재 근거 포인터를 붙인다.
- **실행 환경 지문(fingerprint)** — `cmd`, argv 해시, 실제 작업 디렉터리, 가드 정책 해시, 파서·스키마·내용 해시, 플랫폼·선택된 도구 버전, locale, 사용자가 명시한 문맥. **지문은 세계 상태를 캡처한 인증서가 아니다** — 같은 지문이어도 그 사이 파일이 바뀌었을 수 있다.
- 비밀 유출을 막는 두 장치를 분리했다. **argv 는 해시로 식별하고 표시에는 마스킹한 값만** 쓴다. **환경 변수는 '이름'만 관찰 기록에 남기고 값은 담지 않는다** — 관찰 기록은 동일성 비교 키에 들어가지 않는다.
- 지문 호환성을 `same`/`compatible`/`unknown`/`incompatible` 네 등급으로 나눈다. OS 나 파서 버전이 달라졌다고 모든 비교를 막지 않되, **판단할 수 없으면 `unknown` 이고 strict 비교는 거절한다.**
- 행 identity 규칙: git 은 저장소 identity(실경로) + 정규 경로, 이름 변경은 확정 정보(원래 경로)가 있을 때만 연결. kubernetes 는 context/namespace/kind + `metadata.uid` 이며 **uid 없는 표 출력으로는 같은 자원이라고 말하지 않는다**(재생성된 같은 이름과 구분이 안 된다). **ps 는 PID 만을 identity 로 삼지 않고 비교를 보류한다**(PID 재사용).
- **거짓 삭제 0**: 어느 한쪽이라도 불완전하면(수집 잘림·파서 실패·표현 손실) 없는 행을 '삭제'로 단정하지 않고 `partial.withheld_reasons` 에 보류를 남긴다. identity 를 확정하지 못한 행이 있어도 '추가'나 '삭제'를 단정하지 않는다 — 못 찾았다고 새로 생긴 것이 아니다.
- 중복 identity 는 오류다. 조용히 한 행을 버리지 않는다(`duplicate_identity`).

### Added — 계획서 8장 실패를 재현하는 fixture 회귀 고리
- **fixture 매니페스트(`manifest_version` 1)** — 계획서 8장 "실패를 재현하는 parser test" 의 저장 형식. `cmd`/`args` 의 정제본, `stdout`/`stderr` 의 정제본, exit 상태, `content_hash`, parism·파서·스키마·플랫폼·도구 버전, `redactions`, 그리고 사람이 검토한 `expected`(값·실패 계약·누락·근거·완전성)를 담는다. **기대값에 `reviewed_by` 가 없으면 '계약'이 아니라 '제안' 이다** — replay 는 이를 계약 위반으로 세지 않는다. 필수로 두면 '기대값은 썼지만 아직 아무도 보지 않았다' 는 상태가 표현 불가능해져 그 상태의 fixture 가 검증에서 조용히 사라진다.
- **캡처 시 정제** — `parism capture` 가 저장하기 전에 시크릿(`ghp_`, `glpat-`, `AKIA`, `xox*-`, JWT), 홈 경로, `--token=` 류 인자 값을 가리고 **무엇을 가렸는지** `redactions` 에 남긴다. 예전에는 출력을 그대로 적어 그 파일을 이슈에 붙이는 순간 원문이 퍼졌다. 민감한 값은 형태를 남기고 값만 바꾸므로 fixture 가 조립된 것처럼 보이지 않는다. argv 는 비교 키가 사라지지 않게 옵션 이름과 **길이**를 남긴다(`--token=<redacted:12>`).
- **오프라인 replay(`parism test <dir>`)** — 저장된 stdout 만 써서(명령을 다시 실행하지 않는다) 현재 파서로 되짚고, 통과/실패가 아니라 **변화된 경로**를 돌려준다: `/evidence/entries/0/path/0/line  value  기대 9 → 실제 0`. `runFixtureTests` 와는 별개 — pack 안의 fixture 와 manifest 로 저장된 fixture 를 각자 되짚고, 판정 방식(변화 경로 목록)만 하나로 통일했다.
- **기대값을 쓰는 경로가 코드에 없다.** 되짚기는 읽기만 한다. 자동 갱신은 회귀를 숨기는 가장 싼 방법이라 막았다. 깨진 매니페스트와 매니페스트가 아닌 파일은 조용히 건너뛰지 않고 이유를 함께 보고한다.
- **근거 기대는 부분 확인이 기본이다.** 파서가 낸 포인터를 전부 적어야 통과하는 방식이면 사람이 쓸 수 없다. 적은 포인터만 확인하고, 전수 대조가 필요할 때만 `exhaustive: true` 로 켠다. 기대 span 에 적지 않은 필드는 이 fixture 가 검증하지 않는다는 뜻이다.

### Changed — M1 · M2 · M3
- Breaking notes: `git status --porcelain` 은 이제 **지원 형식**이므로 더 이상 `failure.hint` 의 '대안 형식 안내' 대상이 아니다. long 형식을 사람이 읽으려 할 때의 안내로만 남았다.
- Breaking notes: `ps` 파서에 `--forest` 트리 접두사 제거가 `depth` 뿐 아니라 근거에서도 드러난다(`strip_tree_prefix`).
- 근거를 요청한 경우(`evidence` 가 `none` 이 아님)에는 적응형 compact 를 켜지 않는다. compact 는 표로 접어 결과 구조를 바꾸므로 근거 포인터가 가리키는 대상이 사라진다. 근거는 '어디서 나왔나'를 묻는 요청이므로 구조 훼손을 감수하지 않는다. `format: 'compact'` 를 명시하면 그대로 압축하고, 근거가 안 만들어진 이유를 `warnings` 로 알린다.
- 결과 원문이 적응형 포맷으로 응답에서 빠져도 보관본과 `content_hash` 는 실제 출력을 가리킨다. 근거 구간이 가리키는 대상이 사라지지 않게 하는 것이 목적이다.
- Breaking notes: `git status --porcelain` 항목에 `quoted` 필드가 추가된다. 줄 모드에서만 값이 채워지며(`-z` 는 가공이 없어 `undefined`), **경로 값의 뜻은 두 모드에서 같다** — 원래 파일 이름이다. 줄 모드의 표시와 원래 이름이 다를 때 그 사실을 알려 주는 것이 이 필드의 목적이다.

### Changed — M0 안정화
- Breaking notes: `toCompact()` 는 `unknown` 대신 `CompactOutcome`(`{ ok: true, value }` | `{ ok: false, reason, message }`)을 돌린다. `parism inspect` 도 이 계약을 따른다.
- Breaking notes: 격리 실행 외부 ParserPack 의 `contract.noise`, `contract.rowLine`, `contract.acceptedValues` 는 메인 스레드에서 `RegExp` 가 아니다. `source`/`flags` 서술자로 접근하거나 워커가 계산한 줄 수(`facts`)를 써야 한다. 이전 동작을 되돌리려면 `parsers.external_isolation: "none"` 을 전역 설정에 둔다. 이 규칙은 내장 파서(44종)에 적용되지 않는다.
- Breaking notes: `DEFAULT_CONFIG.guard.secrets.output_patterns` 의 기본값 `[]` 을 제거했다. 키를 생략하면 기본 패턴 7개를 쓰고, `[]` 를 명시하면 의도적 비활화로 구별된다. 이전처럼 `[]` 를 기본값으로 두려면 설정 파일에 `output_patterns: []` 을 적어야 한다.
- `guard.secrets` 는 이제 하위 키로 병합한다. `output_redaction_enabled` 하나만 켜도 `env_patterns` 기본값이 남는다.

### Fixed
- **토큰 예산이 행 수에 대해 이차로 늘던 결함(M2)**. `applyBudget` 의 이분 탐색이 찾은 행 수를 버리고 전체 행에서 한 행씩 덜며 payload 를 다시 재서 O(n log n) 이 O(n²) 으로 무너졌다. 계측 호출 횟수를 직접 세어 확정했다(2,000행에서 2,012회 — 로그 탐색으로는 11회면 충분). 2,000행에서 **7,959ms → 67ms**. 답은 같고 비용만 줄었다(전 시험 1,399건 동일 통과).
- **근거 구간 변환이 포인터마다 원문 전체를 다시 훑던 결함(M1)**. `evidenceToByteSpans` 가 반복문 안에서 줄 시작 위치 표를 다시 만들어 O(포인터 × 원문 길이) 이었다. 근거·보관 조합에서 1,937ms → **322ms**, on 전체 1,227ms → **487ms**. 근거만 켜면 149ms, 보관만 켜면 93ms 였던 것과 대비해 조합별로 지목했다.
- **호출되지 않던 `toFieldEvidence` 와 `toByteSpan` 제거.** 어느 곳에서도 쓰이지 않는 죽은 코드였고, `toFieldEvidence` 는 근거를 내는 유일한 파서(`git status`)가 쓰는 `line=0` 규약도 처리하지 못했다.
- `parism test` 가 `"not yet implemented"` 을 찍고 exit 1 이던 스텁이었다. 계획서 8장 "CLI 를 닫힌 회귀 고리로 만든다" 가 열려 있었다. capture → 정제된 fixture → replay → 변화 경로 보고로 닫았다.
- **마스킹이 근거 구간을 어긋나게 만들 수 있던 문제**를 미리 막았다. 근거 바이트 오프셋은 마스킹된 정규 원문 기준이라 마스킹 전 위치를 그대로 쓰면 어긋난다. 마스킹 전후 대응표(`src/engine/mask-map.ts`)를 만들어 정확히 옮기고, 가려진 구간 안의 값은 치환 토큰을 가리키며 `masked` 로 드러난다.
- `ps` 근거의 숫자 대조를 문자열이 아니라 수치로 하였다. `"0.0"` 과 `0`, `"1.20"` 과 `1.2` 처럼 표기가 달라도 값이 같으면 근거다. 문자열 비교로는 같은 값을 다른 값으로 판단해 근거를 버리고 있었다.
- **외부 ParserPack 계약 정규식이 서버 스레드에서 실행되던 결함(서버 정지 위험)**. 워커가 보낸 `noise`/`rowLine`/`acceptedValues` 의 `RegExp` 를 메인 스레드가 그대로 만들어 실행해, 외부 팩이 선언한 재귀 역추적 패턴 하나(소스 `^(a+)+b$`)이 워커 시간 상한 500ms 를 무시하고 서버 스레드를 90초 넘게 막았다(실측: 40자 입력에서 호출이 종료되지 않음). 이제 계약 정규식은 워커 안에서만 실행한다. `noise`/`rowLine` 은 원문 줄 분류를, `acceptedValues` 는 플래그 값 판정을 워커가 수행해 줄 수와 참/거짓만 돌려준다. 메인 스레드에는 `{ __parism_regex__: { source, flags } }` 서술자만 전달된다. 판정 결과가 없으면 형식을 거절한다(검증 없는 통과를 막는다). 같은 실측 입력은 이제 상한에 걸려 `parser_exception` 으로 끝나고, 메인 스레드는 0.99ms 안에 다른 요청에 응답한다.
- **리댁션을 켜도 기본 패턴이 적용되지 않던 결함**. 설정 로더가 `guard.secrets.output_patterns` 기본값을 `[]` 로 만들어, 사용자가 패턴을 생략하면 "값이 없다"는 뜻이 아니라 "의도적으로 비활성"이 되어 기본 패턴 7개가 전혀 쓰이지 않았다. 합성 비밀 5종(sk-, ghp_, AKIA, xoxb-, glpat-)이 모두 그대로 반환됐다. 기본값을 두지 않게 바꿔 이제 생략하면 기본 패턴을 쓰고, `[]` 를 명시하면 의도적 비활화로 구별된다. SPECIFICATION이 원래 문서화하던 계약("`undefined` 이면 7개 DEFAULT 패턴, `[]` 이면 레덕션 비활성")에 코드가 맞지 않았다.
- **`guard.secrets` 를 하위 키로 병합하지 않아 기본값이 조용히 사라지던 결함**. `output_redaction_enabled` 하나만 켜면 `secrets` 객체가 통째로 갈아끼워져 `env_patterns` 기본값 6개가 사라지고, 자식 프로세스 환경 변수 시크릿 제거가 통째로 꺼졌다. 이제 `env_patterns`와 `output_patterns`는 사용자가 명시한 값만 덮어쓴다.
- **compact 가 값을 조용히 잃고 있던 결함**. 중첩 배열을 구분자 문자열로 이어 붙여 `["a|b","c"]`와 `["a","b","c"]`가 모두 `"a|b|c"` 가 되었고(복원 불가), 배열 안의 `null`은 문자열 `"null"` 이 되고 객체는 `"[object Object]"` 이 되었다.
- **compact 가 프로세스 예외를 내던 결함**. 객체 뒤에 `null` 이 섞인 행 배열(예: 49개 객체 + `null`)에서 `TypeError: Cannot read properties of null` 로 죽었고, 순환 참조와 `BigInt` 값도 `TypeError` 를 냈다. 헤더가 하는 포맷 변환이 실행 전체를 중단시킬 수 있었다. 이제 `toCompact` 는 예외를 내지 않고 `CompactOutcome` 을 돌리며, 값이 섞인 배열은 압축하지 않고 그대로 두고, 순환/`BigInt`/깊이 64 초과 는 `representation_not_lossless` 로 보고한다. 엔진은 그 경우 압축을 적용하지 않고 원형 JSON 과 `stdout.raw` 를 모두 남긴다.
- **compact 가 첫 항목만 보고 형식을 정하던 결함**. `[{a:1},"str"]` 에서 두 번째 행이 `[null]` 이 되어 조용히 사라졌다. 이제 모든 행의 유형을 확인하고, 섞여 있으면 그 배열을 압축하지 않는다.
- **`find`/`du` 가 파일명 끝의 공백을 지우던 결함**. 줄 구분자로 나눈 뒤 경로에 `trim()` 을 적용해 `report ` 가 `report` 로, `dir /inner  ` 가 `dir /inner` 로 바뀌었다 — 다른 경로로 오인될 수 있는 손실이었다. `find -print0` 경로는 원래 정확했으나 줄바꿈 경로가 아니었다. 이제 두 경로가 같은 값을 낸다.
- **`kubectl get pods` 의 RESTARTS 열 밀림**. 재시작 횟수가 0이 아니면 kubectl 이 `2 (5d ago)` 처럼 괄호 표기를 RESTARTS 뒤에 붙이는데, 이를 한 열로 세어 `age: "(5d"`, `ip: "ago)"`, `node: "8d"` 로 읽었다. 닫는 괄호까지를 RESTARTS 값으로 묶고 그 다음 칸을 AGE 로 읽으며, 괄호 표기를 `last_restart` 로도 보존한다.
- **`git status --porcelain` 에 `-z` 없이 주면 모든 항목이 하나로 뭉치던 결함**. NUL 레코드 전용 파서가 줄 구분 출력을 통째로 한 레코드로 읽었다. 실측: 미추적 파일 4개 + 수정한 파일 1개 + 이름 변경 1건(6건)이 **항목 하나로** 합쳐지고 `path` 에 개행과 ` -> ` 표기가 그대로 남았다. `-z` 여부를 판별해 레코드 경계(NUL vs 개행)·경로 해석(가공 없음 vs C 이스케이프 해제)·이름 변경 표기(다음 레코드 vs ` -> `)를 나눠 처리한다. 두 형식의 항목 수와 경로 집합이 같은지 실제 저장소로 대조했다.

### Breaking notes
- **`parism capture` 가 쓰는 fixture JSON 형식이 바뀌었다.** 최상위 `command`/`args`/`exitCode` 대신 매니페스트가 된다: `tool.command`, `tool.args`, `exit.code`, `stdout`, `stderr`, `captured_at`, 그리고 `manifest_version`·`id`·`content_hash`·`versions`·`redactions` 이 추가된다. 예전 파일에는 형식 버전을 표시할 방법이 없어 조용히 깨졌다. 이제 `parism test` 가 형식이 다른 파일을 통과시키지 않고 그 사실을 보고한다. 읽고 있던 코드가 있으면 `fixture.command` → `fixture.tool.command`, `fixture.exitCode` → `fixture.exit.code` 로 바꾸면 된다. 파일 이름도 `${cmd}-${timestamp}.json` 에서 명령어를 slug 처리한 `${slug(cmd)}-${timestamp}.json` 으로 바뀐다.

### Verified
- **성능 게이트(`experiments/perf-gate.mjs`)** — 계획서 10장. 같은 커밋 안에서 `off`(새 인자 없음)와 `on`(근거+예산+보관)을 1KB/100KB/1MB × concurrency 1/4/16 으로 재고 on 이 기존 경로에 추가한 비용을 공개했다. 필드 근거를 실제로 내는 파서가 `git status`·`ps` 뿐이라 `ls -l` 과 `git status --porcelain` 을 나란히 재었다(한쪽만 재면 근거 구축 비용이 빠져 결론이 거짓이 된다). 실측: 소량이면 on 추가 비용이 3~6% 안이지만 100KB 를 넘으면 p50 +58~276%, 1MB 에서는 +132~548%(conc 16, `ls` 기준 throughput −87.1%). **10% 목표는 규모가 크면 크게 어긋난다 — 이 표는 초기 예산을 대체하지 않는다.** 이전 릴리스 대비 '기능 off 회귀 없음' 판정은 하지 않는다(빌드 차이와 코드 차이를 분리할 수 없다). 워커 CPU 는 외부 ParserPack 이 없어 **측정하지 않았다**. 전체 표와 판독법은 `experiments/README.md` 부록 F.
- **성능 게이트가 잡은 이차 비용 2건**(A-7·A-8) — 값을 정확히 냈지만 규모에서 무너졌다. 예산 7,959ms → 67ms(2,000행), 근거 1,937ms → 322ms(1MB). 수정 후 `git` 1MB conc16 의 on 추가 비용은 +2,105% 에서 +328.9% 로 내려갔지만 10% 목표에는 여전히 멀다.
- **tarball 소비 smoke test** — `npm pack` 한 tarball 을 클린 디렉터리에 설치하고 **설치본만** import 해서 12개 항목 31개 검사를 돌렸다. 통과: bin 버전, 환경변수·설정 파일의 `allowed_paths` 반영, 리댁션 켬/끔 양쪽 계약, porcelain 두 형식의 경로 집합 일치, `-z` 근거 바이트 구간이 원문을 정확히 가리킴, 근거 구간이 원문 범위 안, 수집 절단 시 `review` 가 근거 범위를 알림, 잘못된 포인터 거절, 예산 상한 준수, 미지원 토크나이저 실행 전 거절, 120행을 이어 읽기로 누락·중복 없이 복원, 위조 cursor 거절, 동일 fixture diff 0, 스테이징 전환이 그 행만 변경, 보관 안 된 결과 거절(재실행 없음), 외부 팩 격리가 메인 스레드를 장악하지 않음(13ms), `contract_version` 생략 시 새 필드 없음, 기존 봉투 필드 유지, 허용 밖 cwd·명령 거절.
- 발견(패키지 결함이 아니라 사용 방식): `createEngine({ configPath })` 는 다층 설정 대신 `loadConfig` 단일 층을 쓴다. 그래서 `PARISM_ALLOWED_PATHS` 같은 **환경변수 레이어가 반영되지 않는다** — 허용 경로를 설정 파일에 직접 적어야 한다. 기본 `allowed_paths` 는 프로세스 cwd 이므로 임시 디렉터리에서 시험하려면 명시적으로 지정해야 한다.
- 발견(사용자 놀람 여부): `package.json` 의 `exports` 맵에 `./package.json` 과 `require` 조건이 없다. ESM 전용 패키지이므로 `require` 해석이 막히는 것은 의도된 것으로 보고 **보고만 한다**(패키징 결함으로 단정하지 않음). 다만 소비자가 버전 확인을 위해 `require.resolve('@nerdvana/parism/package.json')` 을 쓰는 패턴은 막힌다.
- 회귀 시험 10건 추가(`tests/parsers/git-status-porcelain.test.ts`), 전체 시험 **59 파일 / 1,392 통과 / 9 생략**, `tsc --noEmit`·`eslint`(경고 0)·`npm run build` 통과.
- **실험 A·B 하네스**(계획서 10장) — `experiments/`에 기계 채점 가능한 부분을 구현해 실행했다. A 19항목·B 21항목 전부 통과. fixture 는 고정 시드로 재현된다. `experiments/README.md` 에 측정한 것과 **측정하지 않은 것**(사람의 판단·확인 시간·토큰 절감률·경쟁 도구 비교)을 구분해 적었다.
  - A: 조건 만족 37건에서 정답 recall 3/3, 근거 구간이 원문을 정확히 가리킴(불일치 0), 최종 payload 898/1400, 근사치임을 `tokenizer_exact: false` 로 밝힘.
  - B: `git status` 는 `?? c.txt → A  c.txt`(새로 생긴 이상)와 `" M b.txt → M  b.txt"`(해결된 이상)를 `changed` 로 잡고 양쪽 근거 포인터를 붙인다. 단순 JSON 비교는 같은 109자를 1줄 어긋난 것으로 보인다.
  - B: `kubectl get pods` 표에는 `metadata.uid` 가 없어 **`comparable: false` 로 보류한다.** 사람이 보면 CrashLoopBackOff(재시작 0→7)가 바로 보이지만, parism 은 그걸 비교로 말하지 않는다 — 재생성된 같은 이름과 구분이 안 되므로 확언할 근거가 없다.
- **harness 자체가 잡은 제품 결함 3건**(모두 실제 저장소·원문과 대조하다 드러남).
- **`retain: false` 로 발급한 id 의 거절 사유가 `unknown_id` 였다.** `not_retained`(처음부터 보관하지 않음)과 `unknown_id`(이 세션이 모르는 id)는 원인이 다른데 타입에 `not_retained` 이 선언돼 있고도 어디서도 나오지 않았다. `ResultStore.markNotRetained()` 로 그 사실을 기록하고 두 사유를 구분한다. 회귀 시험 3건.
- **git 행 identity 가 프로세스 cwd 에 의존했다.** `normalizePath` 가 `resolve(value)` 를 써 저장소 identity 가 넘어와도 쓰이지 않았다. 같은 저장소의 같은 파일이 실행 위치마다 다른 key 를 갖는다. 저장소 기준으로 정규화했다. 회귀 시험 2건.
- **`comparable` 이 항상 `true` 였고 `key_conflicts` 는 항상 빈 배열이었다.** identity 를 확정하지 못한 행이 있어 보류 사유를 남기면서 "비교가 성립했다"고 동시에 말했고, 중복 identity 를 찾아놓고 결과를 버렸다. 둘 다 고쳤다. 회귀 시험 2건.
- `CompareRowResult` 에 `label` 추가. `key` 는 `저장소identity<NUL>경로` 형식이라 사람이 읽을 수 없었고, 무엇이 변했는지 말하려면 이름이 보여야 한다. `key` 는 비교·대조용으로 그대로 둔다.
- 발견(하네스 작성 중): `git status --porcelain` 은 경로순으로 정렬해 **같은 파일 집합으로는 출력 순서를 뒤집을 수 없다.** 계획서가 "순서 변화와 잘린 결과를 섞어"라 한 그 부분은 이 도메인에서 성립하지 않는다. 하네스는 "목록이 1건 늘어남"으로 그 자리를 대신 채우고 그 사실을 주석에 남겼다.
- 발견(실행 환경, 제품 결함 아님): 소스를 tsx 로 직접 실행하면 이 호스트에서 `spawn(detached=true)` 가 ENOENT 를 내 모든 명령이 `spawn_failed` 가 된다. `dist` 는 같은 인자로 정상이다. 실험이 제품에 대한 측정치가 되려면 `npm run build` 후 `dist` 를 재야 한다.
- 회귀 시험 7건 추가(`tests/engine/compare.test.ts`, `tests/engine/result-store.test.ts`, `tests/engine/evidence.test.ts`), 전체 시험 **59 파일 / 1,398 통과 / 9 생략**.
- **60초 데모**(계획서 11장) — `experiments/demo-60s.mjs`. 세 장면(예산→근거→이어 읽기)을 실제로 돌려 README 첫 화면에 실측값을 넣었다. **약속이 아니라 측정값**이며 고정 시드로 재현된다.
  - 장면 1: 200행 중 138행 표시, 68행 생략, measured 19987/20000, 파싱 오류 0건. 표시한 수·뺀 수·이유·파싱 실패가 각각 다른 필드로 분리된다.
  - 장면 2: `git status --porcelain` 은 `byte[3,13) = "changed.ts"` 를 준다. `ls` 는 필드 근거가 없는데 `source_kind: "none"` 으로 **"근거 없음"** 이라고 말한다.
  - 장면 3: 이어 읽기 1회로 206행 전부 복원(중복 0), 명령 실행 횟수 여전히 1회. 그 뒤 `unknown_id` 와 `not_retained` 을 구분해 거절하고 재실행하지 않는다.
- **한 행도 담지 못해 예산을 넘었을 때 그 사실을 밝히지 않던 결함.** 실측: 206행 fixture 에 2,000 토큰 예산을 걸면 0행이 나오는데 최종 payload 는 5,396 토큰이었다. 넘은 것은 행이 아니라 **raw 원문**인데, omission 에 그 사실이 없어 '0행을 내보내면서 왜 5천 토큰인지' 알 수 없었다. 이제 `no row fits the budget ... the remaining N tokens are the response envelope and raw output, not rows` 로 밝힌다. 회귀 시험 1건.

## [2.0.2] - 2026-10-03

### Added
- 파서 계약의 형식 선언: `acceptedFlags`(출력 형식을 검증한 플래그와 값 방식 `bool`, `value`, `attached`), `acceptedValues`(플래그 값 패턴), `acceptedPositionals`(`min`, `max`, `pattern`), `requiredFlags`(하나 이상 필요), `exclusiveFlags`(하나까지만), `leadingFlags`(서브커맨드 앞 전역 옵션), `subcommands`(서브커맨드별 계약, 빈 문자열 키는 서브커맨드 없는 실행), `plusFlags`, `singleDashLong`. 선언 밖의 인자는 파서를 실행하지 않고 `parse_error.reason = "unsupported_format"`이며 메시지에 원인 인자를 밝힌다. raw와 native JSON 폴백은 그대로다. `supports(args)`는 선언 검사를 통과한 뒤 추가로 적용하는 선택 규칙으로 남는다. `ParserPack`도 같은 필드를 쓴다(`ParserPack`이 `ParserContract`를 확장한다).
- 출력 계약 필드 `rowsKey`(데이터 줄마다 행 하나를 담는 배열의 키), `rowLine`(행이 되는 데이터 줄 패턴), `rowFields`(행 필드 이름 목록), `nulRecords`(행이 NUL로 끝남), `blankRecords`(빈 줄과 공백만 있는 줄도 행, `grep`), `outputFlags`(인자에 있으면 출력 모양 필드를 덧씌우는 플래그 표, 예: `find -print0`, `du -0`, `grep -Z`, `wc --total=only`). `contractFor(cmd, args)`는 `outputFlags`까지 반영한다.
- 파서 불변식 모듈 `src/parsers/invariants.ts`: `checkInvariants(parsed, raw, contract)`가 조용한 빈 결과(`silent_empty`), 행 수와 데이터 줄 수 불일치(`row_count`), 유한하지 않은 숫자(`non_finite`), 스키마 밖 필드(`field_names`)를 위반 목록으로 돌려준다. `countDataLines`, `countRowLines`도 내보낸다. 런타임에는 기존 `unrecognized_output` 판정만 이 모듈을 쓴다.
- `failure.hint = { args, reason }`와 `stdout.parse_error.hint`: `unsupported_format`일 때 같은 정보를 내장 파서나 native JSON 폴백이 처리하는 형식으로 얻는 인자를 안내한다. 예: `uname -r` → `-a`, `ls -lh` → `-l`, `git status -s` → `status`, `git status -s --ignored` → `status --ignored`, `git log --oneline --graph` → `log --format=%h %s`, `git log -n 3` → `log -n 3 --format=%h%x09%an%x09%aI%x09%s`(작성자와 작성 시각 포함), `git branch` → `branch -v`, `journalctl -o json -n 5` → `-n 5 -o short-iso`, `free --tera` → `-b`, `docker ps -q` → `ps`, `kubectl get pods -o yaml` → `get pods -o json`, `gh issue list` → `--json` 필드 추가, `npm ls --parseable` → `ls --json`, `git log --oneline --decorate` → `log --oneline --decorate=full`, `git diff --stat HEAD~1`(`--name-only`, `--name-status`, `--numstat` 등) → `diff HEAD~1`, `git branch --show-current` → `branch -v`, `grep -r x .` → `-n -r x .`, `ps -e`(`-A`, `ax`, aux에 있는 열만 고른 `-eo`) → `aux`, `systemctl status cron`(`is-active`, `is-failed`) → `list-units --all cron.service`. 같은 정보를 얻을 인자가 없으면 hint가 없다(`ps -ef`, `ps -eo pid,ppid`, `systemctl is-enabled`). 안내 인자는 readonly 기본 정책을 통과한다.
- `ParserRegistry.contractFor(cmd, args)`(서브커맨드를 반영한 유효 계약)와 `ParserRegistry.parseWithFallback(...)`(native JSON 폴백까지 적용한 결과, 엔진이 쓰는 경로).
- `UnrecognizedOutputError`(`src/parsers/registry.ts`): 파서가 값을 얻을 수 없거나 줄 해석이 모호할 때 던지면 레지스트리가 `parse_error.reason = "unrecognized_output"`으로 보고한다(`parser_exception`이 아니다).
- 내장 파서의 선택 출력 필드(해당 형식일 때만 나타난다): `ls`의 `directory`, `stat`의 `link_target`과 `files[]`, `du`의 `modified_at`, `df`의 `type`, `size`, `block_size`, `ps`의 `depth`, `curl -I`의 `header_values`와 `history`, `grep`의 `byte_offset`과 `context`, `git status`의 `renamed`, `ignored`, `unmerged`, `detached`, `detached_at`, `git log`의 `refs`와 `author`, `date`(`--format=%h%x09%an%x09%aI%x09%s`), `dig`의 `queries`(쿼리가 여럿일 때 응답마다의 결과), `wc --total=only`의 `total`, 개수 플래그가 없거나 여럿인 `wc`의 `lines`, `words`, `chars`, `bytes`, `max_line_length`, `git diff`의 `files[].status`, `old_path`, `binary`, `git branch`의 `detached`, `points_to`, `worktree`, `upstream_gone`, `apt search`의 `description`, `npm ls`의 `deduped`, `problem`, `cargo tree`의 `depth`, `deduped`, `proc_macro`, `source`.
- `run`(MCP 도구와 `ParismEngine.run`)의 서버 측 투영과 필터 인자 `select`, `where`, `sort_by`, `limit`, `array`(`src/engine/projection.ts`). 파싱 결과의 최상위 배열(계약의 `rowsKey`, 배열이 여럿이면 `array`로 지정)에 `where`, `sort_by`, `limit`, `select` 순서로 적용한다. 조건 연산은 `eq`, `ne`, `prefix`, `contains`, `gt`, `gte`, `lt`, `lte`이며 zod 스키마로 검사한다. 결과에 `_summary: { total, matched, shown }`(결과 객체 안이면 `parsed._summary`, 결과가 배열이면 `stdout._summary`)를 남기고 `stdout.raw`는 싣지 않는다. 투영할 때 파서는 `max_items` 없이 전체 행을 내며 보이는 행만 `max_items`로 자른다(`_summary.truncated`). 결과 객체 안의 대상이 아닌 배열도 `max_items`로 자르고 그 키를 `_summary.truncated_arrays`에 남긴다. `select` 결과 행은 프로토타입 없는 객체라 `__proto__` 같은 필드 이름도 일반 필드로 남는다. `compact`, `json-no-raw`와 함께 쓸 수 있고 적응형 형식 임계값은 투영한 행 수를 본다. 문법 오류는 실행 전에 `failure = { kind: "config", reason: "invalid_projection" }`, 알 수 없는 필드와 형 불일치는 실행 뒤 `unknown_field`, `type_mismatch`(`array_not_found`, `array_ambiguous` 포함)이며 raw를 남긴다. 500개 항목의 `ls -l`에서 `select: ["name","size_bytes"], limit: 50`은 응답 토큰을 96% 줄인다.
- `describe`의 선택 인자 `cmd`(`ParismEngine.describe(cmd)`, `src/facade/capabilities.ts`): 한 명령의 유효 정책(서브커맨드, 플래그, 위치 인자 규칙, 출처 `default`/`build`/`config`/`none`), guard도 허용하는 파서 형식 선언(`requires`, `values`, `flags`, `rows_key`, `row_fields`, 서브커맨드별), 대체 형식 안내(`alternatives`), 현재 guard를 통과하는 예시를 한 응답으로 돌려준다. 기본 명령 40종 모두 2KB 이하이며 MCP 도구는 이 응답을 들여쓰기 없이 직렬화한다. 허용되지 않은 명령은 예외 대신 `failure.reason = "command_not_allowed"`를 담은 결과다. `ParserRegistry.declaredContract`, `hasParser`, `formatHint`를 더했다.
- 파서 결과 통계(`OutcomeStats`, `src/engine/telemetry.ts`): `telemetry.enabled=true`일 때만 프로세스 안에 명령별 결과 횟수(`parsed`, `unsupported_format`, `unrecognized_output`, `parser_exception`, `schema_violation`, `parser_not_found`, 사유별 `guard`, `exec`)를 모아 `describe`의 `stats`로 보여 준다. 외부 전송과 저장은 없고, 허용 목록 밖 명령은 `(unlisted)` 한 항목으로 모은다. 활성 시 `run` 한 번에 더해지는 비용은 약 0.12µs다.
- MCP 안내문에 `describe(cmd)`와 투영 인자를 적었다.
- 외부 ParserPack 격리 실행(`src/parsers/external/`): `~/.parism/parsers/`의 팩을 팩마다 워커 스레드에서 읽고 실행한다. 서버 스레드는 팩 모듈을 실행하지 않고 계약 선언만 받으며, 함수 선언(`supports`, `hint`)은 호출마다 워커에서 평가한다. 레지스트리의 `parse()`는 `SharedArrayBuffer`와 `Atomics.wait`로 응답을 기다려 동기 API를 유지한다. 호출 하나(계약 함수와 `parse` 왕복, 다시 띄운 워커의 기동 대기 전부)의 시간 상한, 워커 V8 힙 상한(`resourceLimits.maxOldGenerationSizeMb`, `Buffer`처럼 힙 밖에 잡는 메모리는 제외)을 넘기거나 워커가 비정상 종료하면 `parse_error.reason = "parser_exception"`이다. 워커 기동과 모듈 로드의 상한은 2초다. `strict_schemas` 검사는 워커가 팩 스키마로 수행한다. 워커의 `console`과 `process.stdout.write` 출력은 stderr로 간다(파일 기술자 1에 직접 쓰는 출력은 막지 못한다). 결함 격리이며 보안 샌드박스가 아니다(SECURITY.md, `docs/adr/2026-07-21-external-parser-sandbox.md`).
- 외부 ParserPack 장애 뒤 대기: 워커 장애(시간 상한 초과, 비정상 종료, 메모리 상한 초과, 다시 띄울 때의 기동 실패) 뒤에는 대기 시간 동안 워커를 띄우지 않고 바로 `parser_exception`(`... is paused for N ms after its worker stopped`)으로 답한다. 대기 시간은 2초에서 시작해 장애가 이어지면 두 배씩 늘어 30초에서 멈추고, 워커가 답하고 장애가 없었던 호출 뒤에 2초로 돌아간다. 대기 시간이 지난 뒤의 호출이 워커를 다시 띄우며, 기동이 그 호출의 상한 안에 끝나지 않으면 그 호출만 `parser_exception`(`... is still starting ...`)이고 워커는 기동을 이어 간다. 장애 뒤 다시 읽을 때 최상위 코드가 3초 걸리는 팩에서 호출 하나가 서버 스레드를 막는 최장 시간은 3161ms에서 501ms가 됐다(기본 상한). `IsolationLimits`에 `cooldownMs`, `cooldownMaxMs`를 더했다.
- `ParserRegistry.withCallDeadline(cmd, task)`와 `IsolatedParser.withDeadline(task)`(선택): task 안의 외부 팩 호출이 시간 상한 하나를 함께 쓴다. `parse()`가 스스로 쓰며 엔진의 `run`은 파싱과 투영용 계약 조회를 한 호출로 묶는다.
- 설정 `parsers.external_isolation`(`"worker"` 기본, `"none"`), `parsers.external_time_limit_ms`(기본 500), `parsers.external_memory_limit_mb`(기본 128). 신뢰하지 않는 프로젝트 설정은 격리를 켜거나 상한을 낮추는 값만 반영하고 격리를 끄거나 상한을 올리는 값은 경고 후 버린다.
- `ParserRegistry.registerIsolated(parser)`, `ParserRegistry.close()`, `IsolatedParser`, `IsolatedParseResult` 타입. `loadExternalParsers`의 세 번째 인자(`isolation`, `timeLimitMs`, `memoryLimitMb`)와 `externalParserOptions(config.parsers)`.
- `npm run benchmark:external`(`benchmarks/external-parse.ts`): 서버 스레드 실행과 워커 실행의 호출 지연, 워커 기동, 재기동 비용을 잰다. Node 24(tsx)에서 20줄 입력 호출당 평균 34.5µs와 142.1µs, 500줄 입력 365.8µs와 2000.3µs, 워커 기동 중앙값 157.7ms, 상한 초과 뒤 첫 호출(대기 시간 없이 잰 재기동과 파싱) 164.9ms.
- 플랫폼 시험(`tests/platform/`): 현재 OS에서 쓸 수 있는 명령을 시험 시점에 실행해 실제 출력에 파서 불변식과 기본 필드 검사를 적용한다. 출력은 저장하지 않으며 없는 명령은 건너뛴다. `CI` 환경 변수가 있으면 현재 OS에서 실제로 실행한 사례가 하나 이상이어야 통과한다. CI에 macOS, Windows(Node 22) 플랫폼 작업을 더했다.

### Changed
- 내장 파서의 `supports()` 함수(`src/parsers/supports.ts`)를 명령별 선언(`src/parsers/contracts.ts`)으로 바꿨다. 실측에서 처리를 확인한 인자만 허용하고, 조용히 틀린 결과를 내던 인자는 교정 전까지 `unsupported_format`이다. 형식과 무관한 파서(`head`, `tail`, `cat`, `kill`)와 이 호스트에서 실측하지 못한 명령(`tree`, `terraform`, `brew`, `pnpm`, `yarn`, `tasklist`, `ipconfig`, `systeminfo`)은 인자를 제한하지 않는다.
- `parism init-parser` 템플릿이 `supports` 대신 `acceptedFlags` 예시를 만든다.
- 계약 함수(`supports`, `hint`)가 던진 예외는 `parse()` 밖으로 전파되지 않고 `parser_exception`이다. `contractFor`와 `formatHint`는 이때 `undefined`를 돌려주므로 엔진의 `run`과 `describe(cmd)`는 예외 대신 응답을 돌려준다.
- `parism add`는 팩 이름을 워커에서 읽는다(팩 모듈을 CLI 스레드에서 실행하지 않는다).
- Breaking notes: 외부 ParserPack은 기본적으로 워커 스레드에서 실행한다. `parse()`가 구조화 복제할 수 없는 값(함수, Promise, Symbol이 든 값)을 돌려주거나 서버 스레드의 전역 상태에 기대면 `parser_exception`이거나 결과가 달라진다. 클래스 인스턴스는 프로토타입 없는 일반 객체로 전달된다. 호출 한 번이 500ms를 넘거나 힙이 128MB를 넘으면 `parser_exception`이다. 이전 동작은 전역 설정 `parsers.external_isolation: "none"`으로 되돌린다. `UnrecognizedOutputError`는 클래스가 아니라 예외 이름으로 판정한다. 격리 실행 팩은 `ParserRegistry.getPack()`으로 조회되지 않는다(`listPacks()`에는 있다).
- 실행이 실패했거나(종료 코드, 시간 초과, 스폰 실패) stdout 없이 stderr만 있으면 파싱 오류는 `stdout.parse_error`에만 남고 `failure`는 실행 결과의 것을 유지한다. 실패한 `ping`, `id`, `curl -I`의 `failure`는 `kind: "exec"`, `reason: "non_zero_exit"`이며 메시지에 stderr가 그대로 있다. 시간 초과(`timeout`)와 출력 상한 초과(`output_overflow`)도 파싱 오류에 가려지지 않는다. 이때 `unsupported_format`의 안내는 `stdout.parse_error.hint`에만 있다.
- 선언 범위 확대(실측 출력의 필드 값으로 확인): `wc`는 개수 플래그 없이(`wc file`) 또는 여럿(`-lw`, `-lwc`, `--lines --words`)으로도 받는다(`--total=only`는 개수 플래그 하나와만). `lsof`는 `-u`(사용자 선택, `-u x`, `-ux`, `-u ^root`)를 받는다. `dig`는 `+time=N`, `+tries=N`, `+retry=N`을 받는다.
- readonly, build 기본 정책이 `git`의 `--ignored`(`--ignored=<mode>`)를 받는다. `git status` 계약은 `--ignored`의 `traditional`, `matching`, `no`를 받고, `git log` 계약은 `--format=%h%x09%an%x09%aI%x09%s`(`%H`, `--pretty=format:` 형식 포함)를 받는다.
- Breaking notes: 다음 인자는 이제 `unsupported_format`이다(raw는 그대로, JSON 출력이면 native JSON 폴백).
  - `ls`: `-Q`, `-b`, `-g`, `-o`, `-G`, `-i`, `-s`, `-h`, `--si`, `--quoting-style`, `--block-size`, `--time-style`(`long-iso`, `full-iso` 외), `--color=always`, `-l` 없는 호출. `-R`, `-F`, `-p`, `--full-time`, 위치 인자 2개 이상은 `-l`과 함께 받는다.
  - `find`: `-ls`, `-printf`, `-exec` 등 출력을 바꾸는 식. `stat`: `-c`, `-t`, `-f`, `--printf`. `df`: `-B`(1K, 1M 외), `-i`, `--output`.
  - `ps`: BSD user 형식(`ps aux` 계열) 외의 대시 형식(`-ef`, `-eo`, `-p` 등). `ss`: `-s`. `lsof`: `-t`, `-F`, `-R`.
  - `dig`: `+short`, `+trace`, `+nocomments`, 뒤에 `+answer`가 없는 `+noall`, `-u`. `curl -I`: `-i`, `-w`, URL 2개 이상.
  - `grep`: `-n` 없는 `-A`, `-B`, `-C`, `-NUM`, `-o`나 `-c`와 함께 쓴 문맥 옵션, `-l`/`-L` 없는 `-Z`, `-z`, `-d`/`--directories`의 `read`, `skip`, `recurse` 밖 값, `-D`/`--devices`의 `read`, `skip` 밖 값. `wc`: `--total`의 `auto`, `always`, `only`, `never` 밖 값. `free`: `-w`, `--tera`, `--peta`, `--tebi`, `--pebi`. `id`: `-n`, `-r`, `-z` 조합.
  - `systemctl`: `list-units` 외의 서브커맨드. `journalctl`: short 계열 외의 `-o`(`json`, `cat`, `verbose`, `export`).
  - `apt`: `show`, `policy`. `npm`: `ls`/`list`의 `--json`, `--parseable`, 그 밖의 서브커맨드. `cargo`: `tree` 외의 서브커맨드와 `--prefix`(`none`, `indent` 외), `-e`.
  - `docker`: `ps`의 `-q`, `-s`, `--format`, `ps`와 `stats --no-stream` 외의 서브커맨드. `gh`: `pr list` 외의 서브커맨드, `-q`, `-w`. `kubectl get`: `-o` 값 `wide` 외, `-A`, `-w`, `--show-labels`.
  - `git`: `status`의 `-s`, `--porcelain`, `-z`. `log`는 `--oneline`, `--format=oneline|%h %s|%H %s`, `--pretty=oneline` 가운데 하나가 있어야 하며 `--graph`, `--stat`, `-p`, 짧은 참조 꼬리표(`--decorate`, `--decorate=short`)는 형식 밖이다(`--decorate=full`은 받는다). `branch`는 `-v`가 있어야 한다. `diff`의 `--stat` 계열, `--name-only`, `--summary`.
  - `grep -r`(`-R`, `-d recurse`)에서 파일 이름 열이 나오는 실행은 `-n`이나 `-b`가 있어야 한다(`-h`, `-l`, `-L`, `-c`는 그대로 받는다). 번호 열이 없으면 콜론이 든 파일 이름과 구분자를 가를 수 없다. 안내는 `-n`을 더한다.
  - `git log`의 `--decorate`, `--decorate=short`: 짧은 참조 이름(`feature`)은 괄호로 시작하는 제목(`(wip) first`)과 모양이 같다. `--decorate=full`을 안내한다.
  - 서브커맨드를 선언한 명령(`git`, `docker`, `gh`, `kubectl`, `helm`, `npm`, `apt`, `systemctl`, `cargo`)의 선언 밖 서브커맨드(`git show`, `docker images`, `gh issue list` 등)는 `failure.reason`이 `parser_not_found` 대신 `unsupported_format`이다. 출력이 JSON이면 이전과 같이 native JSON 폴백이 `parsed`를 채운다.
  - `dir`은 Windows에서만 파싱한다.
- Breaking notes: 기존 필드의 값이 다음과 같이 정해진다.
  - `git status.branch`: detached HEAD는 `HEAD`. `git diff.files_changed`: 새 파일, 삭제 파일, 이름 바꾼 파일(새 경로)을 포함한다. `git branch.upstream`: `-v`의 `[ahead N]`, `[gone]`는 `null`이고 상류 이름은 `-vv`에서만 채운다. `message`가 대괄호로 시작해도 상류로 읽지 않는다.
  - `dig.query_type`: QUESTION 섹션이 없으면 빈 문자열. `systemctl.units[].failed`: ACTIVE 열이 `failed`인 유닛(행 앞 기호와 무관). `lsof.entries[].state`: TCP 상태 이름일 때만 채우고 `(readlink: ...)` 같은 안내는 `name`에 남는다. `lsof.entries[].device`: 값이 없는 열은 빈 문자열.
  - `df.filesystems[].blocks_1k`: 1K 블록일 때만 있다. 단위 붙은 크기(`-h`, `-H`, `--si`)는 `size`에 값 그대로("547G") 담고, 다른 블록 단위(`-m`, `-B1M`)는 `size`와 `block_size`다. `stat.file`: 링크 이름만(대상은 `link_target`). `curl -I.headers`: 같은 이름의 헤더는 `, `로 이은 값. `apt.packages[].status`: 설치되지 않은 패키지는 빈 문자열.
  - `ss.connections[]`: 유닛 소켓은 `local_address`가 경로, `local_port`가 inode, `peer_port`가 상대 inode. Netid 열이 없는 출력은 `netid`가 필터에서 정해지며(`-t`면 `tcp`) 정할 수 없으면 빈 문자열이고, State 열이 없으면 `state`는 빈 문자열.
  - `ls.entries[].name`, `target`: `-F`, `-p`의 표시 기호는 포함하지 않는다. `ps.processes[].command`: 공백을 그대로 보존한다. `journalctl.entries[].hostname`: `--no-hostname`이면 빈 문자열. `free.unit`: 10진 단위는 `kilo`, `mega`, `giga`.
  - `ping`, `id`, `curl -I`, `lsof`, `env`는 값을 얻지 못하면 기본값으로 채운 결과 대신 `unrecognized_output`이다.
  - `dig`: 쿼리가 여럿이면 맨 위 `query`, `query_type`, `answers`, `query_time_ms`, `server`는 첫 응답의 것이고 응답마다의 결과는 `queries[]`에 있다. 루트 이름은 `"."`, 루트를 가리키는 값(MX `0 .`)은 점을 지킨다.
  - `wc --total=only`: 이름이 빈 항목 대신 `{ total }`이다.
  - `git log.commits[].refs`: `--decorate=full`이 찍은 전체 이름 그대로다(`HEAD -> refs/heads/main`, `tag: refs/tags/v1.0`, `refs/remotes/origin/main`).
  - `git branch.branches[].ahead`, `behind`: 상류가 사라졌으면(`[gone]`, `[origin/x: gone]`) `0` 대신 `null`이고 `upstream_gone: true`다.
  - `wc.entries[]`: 개수 플래그가 없거나 여럿이면 `count` 대신 `lines`, `words`, `chars`, `bytes`, `max_line_length` 가운데 고른 열이다.
- 실행기가 `execFile` 대신 `spawn`으로 프로세스를 띄운다. stdout, stderr 각각의 버퍼 상한(10MB)과 `failure.reason` 분류는 그대로다.
- 새 설정 `guard.max_page_size`(기본 1000): `run_paged`의 `page_size`가 이 값을 넘으면 이 값으로 줄이고 `page_info.requested_page_size`에 요청값을 남긴다.
- 새 설정 `guard.max_concurrency`(기본 4): 동시에 실행하는 자식 프로세스 수 상한. 넘는 요청은 대기한다.
- `guard.secrets`와 `parsers.adaptive_format_threshold`는 레이어 사이에서 하위 키 단위로 병합한다.
- `SPECIFICATION.md`의 기본 명령 수와 `describe`·`dry_run`·`failure` 표, `SECURITY.md`의 경로 검사 범위를 실제 동작에 맞췄다.
- 기본 정책이나 `build` 프로필 정책을 쓰는 기본 명령은 인자가 정확히 `--version` 하나이면 정책 검사 없이 통과한다. `guard.command_policies`로 정책을 덮어쓴 명령은 그 정책을 따른다. `--help`는 허용하지 않는다(일부 명령은 페이저나 매뉴얼 뷰어를 띄운다).
- 기본 정책에 읽기 용도의 인자를 더했다: `date`의 `+`로 시작하는 출력 형식 위치 인자 하나, `ls`의 `-f`, `-q`, `-T`, `-D`, `--zero`, `--hyperlink`, `ps`의 `--width`, `-q`, `tree`의 `--filesfirst`, `-H`, `which`의 `--all`, `grep`의 `--exclude-from`(값은 경로 검사). `echo`는 `-n`, `-e`, `-E`를 받는다.
- 명령 정책 필드 `positionalChars`(위치 인자 허용 문자), `positionalPrefix`(위치 인자 접두사), `maxPositionals`(위치 인자 최대 개수), `plusFlags`(`+` 인자를 플래그로 분해), `textPositionals`(위치 인자를 검색어나 출력 문자열로 보고 `key=값`의 `=` 뒤 값을 따로 경로 검사하지 않음)를 추가했다. `guard.command_policies`에서도 쓸 수 있다.
- Breaking notes:
  - 새로 정책을 받은 24종은 정책에 없는 플래그와 위치 인자를 `arg_not_allowed`로 거부한다. 필요하면 `guard.command_policies`로 허용한다. 의도적으로 거부하는 정상 사용은 다음과 같다.
    - 24종 모두: `--help`
    - 끝나지 않는 추적과 반복 실행: `tail -f`, `tail -F`, `tail --follow`, `free -s`, `netstat -c`, `lsof -r`, `lsof +r`, `ping -f`
    - 재귀 중 심볼릭 링크를 따라가는 옵션: `grep -R`, `du -L`, `tree -l`, `ls -L`
    - 출력 파일과 덤프 파일: `tree -o`, `ss -D`
    - 시스템 상태 변경: `ss -K`, `ss -E`, `date -s`, `date --set`, `hostname`의 위치 인자, `hostname -F`, `hostname -b`
    - 파일 목록이나 묶음 입력을 읽는 옵션: `wc --files0-from`, `date -f`, `dig -f`
    - `ps`의 환경 표시 수식어 `e`와 허용 글자 밖의 위치 인자(숫자 pid 목록은 `-p`로 지정한다)
    - `ps`의 `-x`(BSD식 위치 인자 `x`는 받는다)와 사용자·그룹 선택 옵션 `-u`, `-U`, `-g`, `-G`, `--user`(사용자별 목록은 `-o`로 `user` 열을 출력해 거른다)
    - `lsof`의 `+`로 시작하는 옵션 전부(`+D`, `+d`, `+c`, `+L` 등)
    - `echo`의 `-n`, `-e`, `-E` 밖의 대시로 시작하는 인자
    - `date`의 위치 인자 중 `+`로 시작하지 않는 것과 두 번째 위치 인자
  - 위치 인자 `key=값`, `+opt=값`의 값이 허용 경로 밖으로 해석되면 `path_not_allowed`가 된다(`curl`, `grep`, `echo`의 위치 인자 제외).
  - 정책이 있는 명령의 위치 인자와 플래그 값도 위 경로 규칙으로 검사하므로, 허용 경로 밖으로 해석되는 값(중간 `..`, 밖을 가리키는 링크 이름)은 `path_not_allowed`가 된다.
  - 무효한 설정 필드는 이전처럼 적용되지 않고 무시된다. 정수가 아닌 수치 환경 변수(`1.5` 등)도 무시된다.
  - `guard.secrets`의 일부 하위 키만 지정하면 나머지 하위 키는 기본값을 유지한다. 이전에는 지정하지 않은 하위 키가 비었다. `adaptive_format_threshold`도 같다.
  - `run_paged`의 `page_size`는 최대 1000이며, 페이지 출력은 `max_output_bytes`로 잘린다.
  - `git log --format=%G?` 같은 서명 상태 표시는 검증 프로그램을 실행하지 않으므로 검증 결과를 보여 주지 않는다.

### Fixed
- `systemctl list-units`: 대기 작업이 있을 때 붙는 `JOB` 범례 줄과 UTF-8 화살표 범례를 출력 검사에서 데이터 행으로 세지 않는다.
- `df`: macOS가 사용률 뒤에 붙이는 inode 열(`iused`, `ifree`, `%iused`)을 읽는다. 마운트 위치가 `mounted_on`에 정확히 담기고, inode 값은 `inodes_used`, `inodes_free`, `inodes_use_percent` 필드에 담긴다.
- `parism add`: 팩 이름이 영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `-`로 된 1~64자가 아니거나 설치 경로가 `~/.parism/parsers/` 바로 아래가 아니면 디렉터리를 만들기 전에 거부한다. 시작 시 로더는 `registry.json`에서 형식 밖 이름의 항목을 경고와 함께 건너뛴다.
- `git status`: 이름 바꾸기(`renamed: a -> b`)를 경로로 쓰지 않고 `renamed[]`의 `{old, new}`로 가르며 `staged`에는 새 경로를 둔다. 따옴표로 감싼 비ASCII 경로를 푼다. detached HEAD는 `branch: "HEAD"`와 `detached`, `detached_at`로 나타낸다. `--ignored` 대상은 `untracked`와 따로 `ignored[]`에 담는다. 병합 충돌 항목은 `unmerged[]`다.
- `git diff`: 새 파일, 삭제 파일, 이름 바꾸기, 모드만 바뀐 파일, 바이너리 변경이 `files_changed`에 들어가며 이름을 바꾼 파일의 `path`는 새 경로다. 따옴표 경로와 끝 탭이 붙은 공백 경로를 푼다.
- `git branch`: detached HEAD 항목(`* (HEAD detached at abc1234) ...`)과 `-a`의 `origin/HEAD -> origin/main` 줄을 읽는다. `-v`에서 `[ahead 2]`는 상류 이름이 아니라 `ahead`로 읽는다. `git log --decorate=full`의 참조는 `refs[]`로 가른다.
- `grep`: `-r`에 피연산자가 하나일 때 파일인지 디렉터리인지 출력으로 가린다(가릴 수 없으면 `unrecognized_output`). 문맥 줄(`-A/-B/-C/-NUM`, `-n` 필요)을 `context`로 표시하고 `--` 구분자를 버린다. `-b`, `-L`, `-Z`(파일 목록), `-T`를 읽는다.
- `stat`: 파일 여러 개는 `files[]`로, 심볼릭 링크는 `file`과 `link_target`으로 가른다. `curl -I`: 리다이렉트를 따라간 응답(`-L`)은 최종 응답을 본문으로 하고 앞선 응답을 `history`에 담으며, 반복 헤더는 `header_values`로 보존한다.
- `ping`, `id`, `curl -I`: 통계 줄, `uid=`/`gid=`, HTTP 상태 줄이 없으면 0과 빈 값으로 채운 결과 대신 `unrecognized_output`이다. `ping`은 `+N errors` 구획과 소수 손실률을 읽는다. `env`: `NAME=value`가 아닌 줄(여러 줄 값)이 있으면 `unrecognized_output`이며 `-0` 출력을 읽는다.
- `apt list`/`apt search`: 대괄호가 없는 줄(설치되지 않은 패키지)을 포함한 모든 행을 읽고 `search`의 설명 줄을 `description`으로 담는다.
- `npm ls`: UTF-8 트리의 부모 행(`├─┬`)을 읽고, `deduped` 표시를 이름과 버전에서 떼며, 마지막 자식 아래 들여쓰기까지 반영해 깊이를 센다.
- `ss`: Netid, State 열이 없는 출력과 머리 줄이 없는(`-H`) 출력을 읽고, 유닉스 소켓의 경로와 inode를 주소와 포트로 읽으며, `-i`의 이어지는 줄을 행으로 세지 않는다. `lsof`: 머리 줄의 열 위치로 가르므로 DEVICE, SIZE/OFF, NODE가 빈 줄에서도 NAME이 밀리지 않는다. `state`는 TCP 상태 이름(`LISTEN`)일 때만 담고 `(readlink: Permission denied)` 같은 안내는 `name`에 둔다.
- `systemctl list-units`: `failed`는 ACTIVE 열이 `failed`인 유닛이다. 행 앞 기호는 not-found 같은 로드 상태에도 붙으므로 쓰지 않는다. `--no-legend`와 `--plain` 출력을 읽는다. `journalctl`: short 계열 형식(기본 `short`, `short-precise`, `short-iso`, `short-iso-precise`, `short-full`, `short-unix`, `short-monotonic`, `with-unit`)과 `--no-hostname`을 읽으며 시각으로 시작하지 않는 줄은 직전 항목의 `message`에 붙인다.
- `dig`: QUESTION 섹션이 없으면 `query_type`은 `A`가 아니라 빈 문자열이다. `+multiline` 괄호 레코드와 `+noall +answer` 출력을 읽는다. `df`: 1K가 아닌 블록 단위(`-m`, `-B1M`)는 `blocks_1k`에 담지 않고 `size`와 `block_size`로 나타내며 공백이 든 마운트 위치를 지킨다. `-T`의 종류 열을 읽는다.
- `ls -l`: `-R`과 피연산자 둘 이상의 구획을 `directory`로 나누고 `-F`, `-p`의 표시 기호를 이름과 링크 대상에서 뗀다. `--time-style=long-iso`, `--full-time`의 시각을 읽는다.
- `ps`: `--no-headers`의 첫 줄과 `--headers`가 되풀이하는 머리 줄을 올바르게 처리하고, `f`, `--forest` 트리의 가지를 떼어 `depth`로 나타내며 command의 공백을 보존한다. `du --time`, `du -0`, `find -print0`을 읽는다.
- `free -h`의 `0B`와 `--si`, `--kilo`, `--mega`, `--giga`를 읽는다. `docker stats --no-stream`의 pids `0`은 `null`이 아니라 `0`이다. `cargo tree`는 `(*)`, `(proc-macro)`를 경로로 읽지 않는다.
- `compact` 형식은 객체 배열의 모든 행에서 키를 모아 열을 만든다(첫 행에 없는 선택 필드도 열이 된다).
- `grep -d recurse`(`--directories=recurse`)는 `-r`처럼 파일 이름 열을 읽는다. 재귀 여부는 `-r`, `-R`, `-d`의 마지막 것이 정한다.
- `du`: 단문자 묶음 안의 `-0`(`-s0`, `-sh0`)도 NUL 구분으로 읽고, 값 옵션 뒤의 `0`(`-d0`)은 값으로 본다.
- 불변식 검사: `git log`, `git branch`, `git diff`의 `rowFields`에 선택 필드(`refs`, `author`, `date`, `detached`, `points_to`, `worktree`, `status`, `old_path`, `binary`)를 넣었다. NUL로 끝나는 출력(`find -print0`, `du -0`, `grep -Z -l`)은 NUL로, `ps`의 머리 줄은 위치가 아니라 모양으로(`--no-headers`, `--headers`), 출력 전체가 JSON 배열이면 원소 수로 행을 센다.
- `grep`: 빈 줄과 공백만 있는 일치 줄(`grep -v`, 빈 패턴, `^$`)을 버리지 않고 행으로 담는다(`text: ""`). 불변식도 빈 줄을 행으로 센다(`blankRecords`).
- `git log --decorate=full`: 꼬리표는 git의 참조 모양(`HEAD`, `HEAD -> refs/...`, `tag: refs/...`, `refs/...`)일 때만 `refs`로 읽는다. 꼬리표 없는 커밋의 `(wip) first` 같은 제목은 제목 그대로다. 마지막 `--no-decorate`는 꼬리표 해석을 끈다.
- `git branch`: `-a -v`, `-r -v`, `-avv`에서 열을 맞추느라 공백이 여럿 든 `origin/HEAD        -> origin/main` 줄을 버리지 않고 `points_to`로 읽는다. 사라진 상류(`[gone]`)를 앞섬, 뒤짐 0으로 읽지 않는다.
- `npm ls <패키지>`: 설치되지 않은 패키지를 찾은 트리의 `(empty)` 표시를 의존성으로 담지 않고 빈 `dependencies`로 돌려준다.
- `wc`, `ls -l`, `stat`: 파일 이름을 공백까지 그대로 담는다(겹친 공백, 탭, 앞뒤 공백). `wc`는 개수 열 다음 한 칸 뒤, `ls -l`은 시각 열 다음 한 칸 뒤, `stat`은 `File: ` 다음부터가 이름이다.
- 설정 값 검증: 전역·프로젝트 설정 파일, 환경 변수, `loadConfig(configPath)`의 각 필드를 스키마(`src/config/schema.ts`)로 검사한다. 형식이 틀린 필드는 stderr에 한 번 경고하고 무시하며 앞 레이어의 값을 유지한다. 수치 상한은 유한한 0 이상 정수만 받는다. 잘못된 타입의 필드가 있어도 기동은 계속한다.
- 빈 `PARISM_ALLOWED_PATHS`, `PARISM_ALLOWED_COMMANDS`는 경고 후 무시한다.
- `loadConfig(configPath)`도 실행 디렉터리가 `/`이면 기본 `allowed_paths`를 홈 디렉터리로 제한한다.
- 경로 검사 대상 수집을 정책이 있는 명령과 없는 명령에 같은 규칙으로 적용한다. 위치 인자와 플래그 값 중 `/`를 포함하거나 `.`, `~`로 시작하거나 `cwd` 기준으로 존재하는 항목(링크 포함)을 가리키는 것을 검사하고, 정책의 `path` 위치 인자와 `path` 플래그 값은 항상 검사한다.
- 기본 `allowed_commands` 40종 모두에 기본 정책을 둔다. 새로 정책을 받은 명령: `ls`, `stat`, `du`, `df`, `tree`, `ps`, `ping`, `netstat`, `lsof`, `ss`, `dig`, `grep`, `wc`, `head`, `tail`, `cat`, `pwd`, `which`, `echo`, `date`, `uname`, `hostname`, `free`, `id`.
- `git` 실행 인자에 `-c core.hooksPath=/dev/null`, `-c log.showSignature=false`, `-c gpg.program=false`, `-c gpg.ssh.program=false`, `-c gpg.x509.program=false`를 더하고, `log`, `show`에 `--no-show-signature`를 붙인다.
- 시간 초과 시 POSIX에서는 프로세스 그룹 전체를 종료한다. 자식이 띄운 프로세스가 남지 않는다.
- 시간 초과나 버퍼 상한 초과로 종료시킨 실행은 자식이 끝나고 200ms 뒤 stdout, stderr 스트림을 닫고 결과를 확정한다. 프로세스 그룹 밖으로 분리된 자손이 출력 파이프를 갖고 있어도 결과 반환과 동시 실행 자리가 그 자손의 종료를 기다리지 않는다.
- 실행 중인 프로세스 그룹을 추적하고, 서버가 SIGINT, SIGTERM을 받거나 프로세스가 끝날 때 종료한다. 다른 처리기가 없으면 신호의 기본 종료 동작을 유지한다.
- `ps`의 위치 인자는 BSD식 옵션 낱말로 보고 `auxfwrljsvhcmnSHTgZ` 글자로만 이루어진 경우에만 받는다. 환경 변수를 함께 출력하는 수식어 `e`, 값을 받는 글자, 숫자 pid 목록 등 그 밖의 위치 인자는 `arg_not_allowed`다.
- `ps`의 대시 옵션에서 `-x`와 사용자·그룹 선택 옵션 `-u`, `-U`, `-g`, `-G`, `--user`를 뺐다. procps는 대시 옵션 해석이 실패하면 인자 전체를 BSD식으로 다시 읽고, 이때 대시 낱말의 글자도 BSD식 옵션이 된다.
- `ps`를 실행할 때 대시 옵션 낱말의 전체 선택 글자 `e`를 같은 뜻의 `A`로 바꿔 넘긴다(`-ef`는 `-Af`로 실행). `A`는 BSD식 해석에 없는 글자라 다시 읽기가 실패하므로 대시 옵션의 `e`가 환경 표시 수식어로 쓰이지 않는다. 값 플래그의 값, 긴 옵션, 위치 인자는 바꾸지 않으며 봉투의 `args`는 호출자가 준 값 그대로다.
- `lsof`의 `+`로 시작하는 인자는 `-` 옵션과 같이 플래그로 보고, 정책에 없으면 `arg_not_allowed`다.
- `key=값`, `+opt=값` 형태의 위치 인자는 첫 `=` 뒤 값이 `/`를 포함하거나 `.`, `~`로 시작하면 그 값도 경로 검사를 받는다. 정책이 있는 명령과 없는 명령 모두에 적용하며, 위치 인자 규칙이 `url`인 명령(`curl`)과 위치 인자를 검색어나 출력 문자열로 받는 명령(`grep`, `echo`)은 제외한다. 제외한 명령도 인자 전체는 같은 경로 규칙으로 검사한다.
- 설정을 읽을 때 `default_page_size`가 `max_page_size`보다 크면 `max_page_size`로 줄인다. `page_info.requested_page_size`는 호출자가 상한보다 큰 `page_size`를 준 경우에만 표시된다.
- 검증하지 않은 설정 객체로 `ParismEngine`을 만들 때 `max_concurrency`가 1 미만이면 1로, 유한한 수가 아니면 기본값 4로 본다. 이전에는 생성자에서 `RangeError`가 났다.
- `run_paged`의 페이지 출력(stdout, stderr)에 `max_output_bytes`를 적용하고, 넘으면 `truncated: true`를 표시한다.
- `id -u`, `id -g`가 `0`을 출력할 때 `unrecognized_output`으로 처리하던 문제를 고쳤다. 최상위 값이 모두 숫자인 결과의 `0`은 인식된 값으로 본다.

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
