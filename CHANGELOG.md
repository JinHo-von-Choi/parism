# Changelog

모든 주요 변경사항은 이 파일에 기록된다.

이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따르며,
포맷은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따른다.

## [Unreleased]

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
