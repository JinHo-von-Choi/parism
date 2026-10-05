# Security

## 지원 버전

Parism은 v2.0.0 안정 릴리스 단계다. 보안 패치는 최신 릴리스에 제공된다. 이전 마이너 버전에 대한 백포트는 제공하지 않는다. 보안 수정이 포함된 새 버전이 출시되면 즉시 업그레이드할 것을 권고한다.

| 버전 | 지원 여부 |
|------|----------|
| 2.x (latest) | 보안 패치 제공 |
| 1.x, 0.x | 지원 종료 |

---

## 취약점 신고

보안 취약점은 GitHub Security Advisories를 통해 비공개로 신고한다.

신고 URL: https://github.com/JinHo-von-Choi/parism/security/advisories/new

신고 후 처리 절차:

1. 수신 확인: 며칠 이내에 접수 확인 응답
2. 초기 평가: 재현 가능 여부 및 영향 범위 분석
3. 수정 및 릴리스: 심각도에 따라 우선순위 결정 후 패치 릴리스
4. 공개: 패치 배포 후 적절한 시점에 CVE 또는 advisory 공개

공개 이슈 트래커(GitHub Issues)에 보안 취약점을 보고하지 말 것. 악용 가능성이 있는 세부 내용이 패치 전에 노출될 수 있다.

---

## 위협 모델

### Parism의 성격

Guard는 argv 허용목록이다. 샌드박스가 아니다. 명령 이름, 서브커맨드, 플래그, 위치 인자를 실행 전에 검사해 에이전트가 만든 명령이 예상한 범위를 벗어나지 못하게 하는 가드 레이어이며, 허용된 바이너리가 실행된 뒤의 동작은 제어하지 않는다.

### Parism이 방어하는 것

- `allowed_commands` 허용목록에 없는 명령은 프로세스가 생성되기 전에 차단된다.
- 정책이 정의된 명령(`DEFAULT_POLICIES`)은 서브커맨드, 플래그, 위치 인자가 허용목록에 있을 때만 통과한다. 목록에 없는 것은 모두 `arg_not_allowed`로 차단되며 차단 메시지에 차단된 인자와 정책 출처가 포함된다.
- `allowed_paths` 바깥을 가리키는 `cwd`와 경로 인자는 실행 전에 거절된다. 경로 비교는 심볼릭 링크를 해석한 실경로로 한다.
- `;`, `$(`, 백틱, `&&`, `||`, `|`, `>`, `>>`, `<` 등 셸 인젝션 패턴이 인자에 포함되면 실행하지 않는다.
- `node -e`, `npx --yes`, `curl -o` 등 명령별 위험 플래그를 차단한다.
- 프로젝트 `prism.config.json`은 가드를 넓히지 못한다. 프로젝트 설정은 전역 설정의 범위 안에서 좁히는 방향으로만 병합되며, 넓히려면 전역 설정에서 `trust_project_config: true`를 명시해야 한다. 가드 밖의 `telemetry.enabled`는 신뢰하지 않는 프로젝트 설정으로도 켜지며, 이때 쌓이는 결과 통계는 외부로 보내지 않는 프로세스 안의 명령별 횟수라 메모리 사용이 제한된다.
- 자식 프로세스 환경에서 `guard.secrets.env_patterns`에 일치하는 변수를 제거한다.
- 설정 파일과 환경 변수의 무효 값(음수나 정수가 아닌 상한, 잘못된 타입, 빈 목록)은 stderr 경고 후 무시되어 가드를 풀지 못한다.
- 실행 자원을 제한한다. 시간 초과 시 POSIX에서는 프로세스 그룹 전체를 종료해 자식이 띄운 프로세스를 남기지 않고, 동시 실행 수는 `guard.max_concurrency`(기본 4), `run_paged`의 `page_size`는 `guard.max_page_size`(기본 1000)로 제한한다. 종료시킨 실행은 자식이 끝나고 200ms 뒤 출력 스트림을 닫고 결과를 확정하므로, 그룹 밖으로 분리된 자손이 출력 파이프를 갖고 있어도 결과와 동시 실행 자리가 붙잡히지 않는다. 서버가 SIGINT, SIGTERM을 받거나 종료할 때 실행 중인 프로세스 그룹을 종료한다.

Parism은 셸 없이 `spawn`으로 프로세스를 직접 실행한다. 셸을 거치지 않으므로 `;`, `$()`, 백틱, 파이프가 인자로 전달돼도 셸이 해석하지 않는다.

### Parism이 방어하지 않는 것

- 경로 검사는 검사 시점과 실행 시점 사이의 경합을 막지 못한다. 심볼릭 링크를 해석해 비교하지만, 검사 직후 실행 직전에 경로의 대상이 바뀌면 검사 결과와 실제 접근 대상이 달라질 수 있다.
- 허용된 바이너리 자체의 동작. 허용된 `git`은 저장소의 `.gitattributes`가 지정한 clean/smudge 필터를 실행할 수 있다. 이 경로는 argv로 막을 수 없다. 저장소 설정에서 외부 프로그램이 실행되는 일부 경로는 주입 옵션(`core.fsmonitor=false`, `core.pager=cat`, `core.hooksPath=/dev/null`, `log.showSignature=false`, `gpg.program=false`, `gpg.ssh.program=false`, `gpg.x509.program=false`, `--no-textconv`, `--no-ext-diff`, log·show의 `--no-show-signature`)으로 줄였으나 모든 경로를 막지는 못한다. 신뢰할 수 없는 저장소를 다룰 때는 컨테이너 격리를 사용한다.
- `build` 프로필은 프로젝트 코드를 실행한다. `npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose`, `node <script>`, `npx <bin>`은 저장소가 정의한 스크립트와 설정을 실행하므로 신뢰하는 저장소에서만 켠다. `yarn`은 저장소가 지정한 `yarnPath`를 따르고, `cargo tree`, `cargo metadata` 등 cargo 조회 서브커맨드는 저장소 `.cargo/config.toml`이 지정한 rustc 래퍼를 실행할 수 있으므로 `build` 프로필에서만 허용된다. `npx`에는 `--no`를 붙여 이미 설치된 실행 파일만 실행하게 한다.
- 실행되는 바이너리의 커널 수준 익스플로잇, 컨테이너 탈출, 공급망 침해
- 타이밍 사이드 채널, 파일 잠금 경합 등 부채널 공격
- Node.js 프로세스 메모리를 직접 조작하는 공격

---

## 4겹 방어선

### (a) allowed_commands 허용목록

`allowed_commands`에 등록되지 않은 명령은 프로세스를 생성하지 않는다. 차단 시 `failure.kind: "guard"`, `failure.reason: "command_not_allowed"` 응답이 반환된다. 권위 필드는 `failure`이며 하위 호환 필드 `guard_error.reason`도 함께 반환된다.

한계: 허용목록의 범위가 넓으면(예: `bash`, `sh`, `python`) 이 계층의 방어 효과가 크게 줄어든다. 실제로 필요한 명령만 포함해야 한다.

### (b) allowed_paths 경로 제한

`allowed_paths`를 설정하면 `cwd`와 경로 인자를 검사한다. 정책이 있는 명령과 없는 명령이 같은 규칙을 쓴다. 위치 인자와 플래그 값(`--file=./x`처럼 붙은 값과 다음 인자로 받은 값 모두) 중 `/`를 포함하거나 `.`, `~`로 시작하거나 `cwd` 기준으로 존재하는 항목(심볼릭 링크 포함)을 가리키는 것은 경로로 검사한다. 정책의 위치 인자 규칙이 `path`인 명령(`cat`, `ls`, `find` 등)의 위치 인자와 `path` 종류 플래그 값은 형식과 관계없이 검사한다. 정책이 없는 명령은 짧은 플래그 묶음(`-abVALUE`)의 각 글자 뒤 나머지도 값 후보로 본다. `key=값`, `+opt=값` 형태의 위치 인자는 첫 `=` 뒤 값이 `/`를 포함하거나 `.`, `~`로 시작하면 그 값도 검사한다(위치 인자 규칙이 `url`인 명령과, 위치 인자를 검색어나 출력 문자열로 받는 `grep`, `echo`는 제외. 인자 전체는 같은 규칙으로 검사한다). 허용 경로 밖이면 차단된다. 비교는 심볼릭 링크 해석 후의 실경로로 한다. 프로젝트 설정의 `allowed_paths`도 실경로로 바꿔 전역 기준 경로 안에 있는지 비교한 뒤 실경로로 저장한다.

한계: 커널이 강제하지 않으며 검사 시점과 실행 시점 사이에 경로가 바뀔 수 있다. 실경로 비교는 인자로 이름이 주어진 경로에만 적용된다. 재귀 탐색 중 만나는 심볼릭 링크를 따라가는 옵션을 쓰면 허용 경로 아래의 링크를 통해 밖의 파일을 읽을 수 있다. 기본 정책은 이 때문에 `find -L`, `grep -R`, `du -L`, `tree -l`, `ls -L`을 허용하지 않는다. `command_policies`로 이런 옵션을 허용하거나 정책이 없는 명령을 추가하면 이 한계가 그대로 남는다. 경로를 받지 않는 명령(예: `env`, `id`, `uname`)에는 적용되지 않는다. 플래그 값 안의 `key=값`은 분리하지 않는다. `allowed_paths`가 비어 있으면 이 계층은 생략된다.

### (c) 인젝션 패턴 차단

인자를 하나씩 순회하며 `block_patterns`(`;`, `$(`, 백틱, `&&`, `||`, `|`, `>`, `>>`, `<`)를 검사한다. 해당 패턴이 포함된 인자가 있으면 실행하지 않는다.

한계: 인자 수준 검사이므로 바이너리가 인자를 내부에서 셸에 위임하는 경우는 막지 못한다.

### (d) 명령별 정책 (command_policies)

명령마다 서브커맨드, 플래그(종류: bool, value, path, attached, count), 위치 인자 규칙을 허용목록으로 정의한다. `attached` 플래그는 `--pretty=oneline`, `-U3`처럼 붙은 값만 받고 다음 인자를 값으로 소비하지 않으므로 다음 인자도 허용목록 검사를 받는다. `count` 플래그(journalctl `-n`, `--lines`)는 다음 인자가 줄 수 형식(N, +N, all)일 때만 값으로 받는다. 실제 명령이 서브커맨드마다 다르게 해석하는 플래그(git `blame`·`shortlog`의 `-n`, docker `logs`의 `-f` 등)는 `subFlags`로 서브커맨드별 종류를 정한다. 기본 정책은 읽기 전용 조회만 허용한다. 기본 `allowed_commands` 40종은 모두 기본 정책을 가진다. 출력 파일을 지정하는 옵션, 시스템 상태를 바꾸는 옵션, 끝나지 않는 반복 실행 옵션은 기본 정책에 없고, `hostname`은 위치 인자를 받지 않으며 `date`는 `+`로 시작하는 출력 형식 하나만 위치 인자로 받는다. `ps`의 위치 인자는 BSD식 옵션 낱말로 보고 허용 글자(`positionalChars`)로만 이루어진 경우에만 받으므로 환경 변수를 함께 출력하는 수식어 `e`는 위치 인자로 통과하지 못한다. procps는 대시 옵션 해석이 실패하면 인자 전체를 BSD식으로 다시 읽고 이때 대시 낱말의 글자도 BSD식 옵션이 된다. 그래서 기본 정책은 UNIX식 해석이 없는 `-x`와 사용자·그룹 선택 옵션(`-u`, `-U`, `-g`, `-G`, `--user`)을 두지 않고, 실행기는 대시 옵션 낱말의 전체 선택 글자 `e`를 같은 뜻의 `A`로 바꿔 넘긴다. `A`는 BSD식 해석에 없는 글자라 다시 읽기가 실패하고, 기본 정책의 값 플래그(`-o`, `-O`, `-p`, `-q`, `-t`)는 BSD식 해석에서도 값을 소비하므로 값 안의 `e`도 수식어가 되지 않는다(procps-ng 4.0.4에서 확인). `command_policies`로 `ps` 정책을 덮어써 다른 대시 옵션을 허용하면 이 조건이 달라질 수 있다. `lsof`는 `+`로 시작하는 인자도 플래그로 검사한다(`plusFlags`). 기본 명령은 인자가 정확히 `--version` 하나이면 정책 검사를 생략하며(`command_policies`로 덮어쓴 명령 제외), `--help`는 허용하지 않는다. 정책이 없는 명령(사용자가 `allowed_commands`에 직접 추가한 명령)은 `command_arg_restrictions`와 경로 검사만 적용된다.

- `guard.profile: "readonly"`(기본): 기본 정책만 적용한다.
- `guard.profile: "build"`: 빌드와 시험 실행에 필요한 서브커맨드(`npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose ps` 등)를 더한다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 사용한다.
- `guard.command_policies`: 명령 단위로 정책을 덮어쓴다. 우선순위는 `command_policies`, `build` 프로필, 기본 정책 순이다.
- `curl`의 `-H`, `-w` 값이 `@`로 시작하는 로컬 파일 참조와 `-w`/`--write-out` 값의 `%output{` 지시어는 차단한다.
- `kubectl -o`/`--output`은 `allowedValues`에 열거된 형식만 허용하며 로컬 템플릿 파일을 읽는 `*-file` 형식은 허용하지 않는다.
- `npm audit`은 위치 인자를 받지 않는다.

한계: 정책에 없는 플래그는 모두 차단되므로 정상 사용이 막히면 `command_policies`로 명시적으로 허용해야 한다. `describe`의 `guard_summary.policies`로 유효 정책을 확인할 수 있다.

`command_arg_restrictions`는 정책과 별개로 모든 명령에 먼저 적용되는 차단 플래그 목록이다. 기본값은 `node`(`-e`, `--eval`, `-r`, `--require`, `-p`, `--print`, `--input-type`), `npx`(`--yes`, `-y`), `curl`(`-d`, `--data`, `-F`, `--upload-file`, `-T`, `-K`, `--config`, `-o`, `--output`, `-O`)이다.

---

## 신뢰할 수 없는 입력에 대한 권고

Parism을 신뢰할 수 없는 외부 호출자에게 노출하거나 신뢰할 수 없는 저장소를 대상으로 쓸 경우 Guard 단독으로는 충분하지 않다.

컨테이너 또는 VM 격리: Parism 인스턴스를 격리된 컨테이너나 VM 안에서 실행한다. Guard가 뚫리더라도 호스트로의 피해 확산을 막는 마지막 방어선이 된다. 신뢰할 수 없는 저장소의 `git` 조회에는 필수에 가깝다.

최소 권한 원칙: Parism 프로세스를 실행하는 OS 계정의 권한을 최소화한다. 루트로 실행하지 않는다.

allowed_commands 최소화: 실제로 쓰는 명령만 포함한다. `bash`, `sh`, `python`, `perl` 등 범용 인터프리터는 포함하지 않는다.

allowed_paths 명시: 비워 두면 경로 제한이 없다. 작업 범위가 명확하면 반드시 설정한다.

### 커스텀 파서 격리

`~/.parism/parsers/`에 등록된 외부 ParserPack은 기본적으로 팩마다 하나의 워커 스레드(`node:worker_threads`)에서 읽고 실행한다(`parsers.external_isolation: "worker"`). 서버 스레드는 팩 모듈을 실행하지 않고 계약 선언만 받는다. 호출 하나의 시간 상한(`parsers.external_time_limit_ms`, 기본 500ms, 그 호출의 계약 함수 왕복과 워커 기동 대기 포함)과 워커 V8 힙 상한(`parsers.external_memory_limit_mb`, 기본 128MB)을 넘기거나 워커가 비정상 종료하면 `parser_exception`으로 보고한다. 그 뒤 대기 시간(2초에서 시작해 장애가 이어지면 두 배씩, 최대 30초) 동안은 워커를 띄우지 않고 바로 실패로 답하며, 대기 시간이 지난 뒤의 호출이 워커를 다시 띄운다. 신뢰하지 않는 프로젝트 설정은 격리를 끄거나 상한을 올리지 못한다.

힙 상한은 V8 힙의 old generation만 제한한다. `Buffer`, `ArrayBuffer`처럼 힙 밖에 잡는 메모리는 제한하지 않는다. 팩의 `console`과 `process.stdout.write` 출력은 stderr로 보내 stdio 프로토콜을 지키지만, 파일 기술자 1에 직접 쓰는 출력은 막지 못한다.

`parism add`는 디렉터리를 만들기 전에 팩 이름(영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `-`로 된 1~64자)과 설치 경로가 `~/.parism/parsers/` 바로 아래인지 검사한다. 형식 밖의 이름은 설치하지 않으며, 시작 시 로더는 `registry.json`에서 형식 밖 이름의 항목을 경고와 함께 건너뛴다.

이것은 결함 격리(끝나지 않는 실행, 비정상 종료, V8 힙 과다)이며 보안 샌드박스가 아니다. 워커는 서버 프로세스와 같은 권한을 가지므로 팩 코드는 파일 시스템, 네트워크, 자식 프로세스, 환경 변수에 그대로 접근할 수 있다. 팩의 계약 정규식(`noise`, `rowLine`, `acceptedValues`)은 워커 안에서만 실행하고 서버 스레드로는 `{ source, flags }` 서술자만 보낸다. 정규식을 서버 스레드에서 실행하면 워커의 시간·메모리 상한을 우회해 서버 스레드를 멈출 수 있기 때문이다(재귀 역추적 패턴으로 상한 500ms 를 90초 넘게 넘긴 사례가 실측으로 확인됐다). `parse` 가 함께 돌려주는 계산된 줄 수와 판정 결과만 서버 스레드가 쓴다.

`node:vm`은 보안 메커니즘이 아니므로 채택하지 않았다. 직접 작성했거나 검토한 팩만 등록한다. 신뢰할 수 없는 제3자 파서를 써야 한다면 Parism 전체를 컨테이너 또는 VM 안에서 실행한다. 근거와 대안은 `docs/adr/2026-07-21-external-parser-sandbox.md`에 있다.

팩 작성자 도구인 fixture replay 도우미(`runFixtureTests`)는 팩 객체를 같은 스레드에서 실행한다.

### 출력 리댁션 (Output Redaction)

`guard.secrets.output_redaction_enabled`는 기본 비활성이다. 활성화하면 파싱이 끝난 raw/stderr 출력에서 공통 시크릿 패턴을 마스킹한다. 파싱 전에 원본을 변조하지는 않는다. 시크릿이 stdout에 노출될 수 있는 환경에서는 이 옵션과 함께 `guard.secrets.env_patterns`로 자식 프로세스 환경에서 변수를 미리 제거한다.

---

## 참고 문서

- [SPECIFICATION.md](SPECIFICATION.md) §3.2: `failure` 필드 전체 계약
- [CHANGELOG.md](CHANGELOG.md): 버전별 변경 이력
- [README.md](README.md): Guard 설정 예시와 운영 가이드
