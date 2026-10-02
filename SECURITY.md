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
- 프로젝트 `prism.config.json`은 가드를 넓히지 못한다. 프로젝트 설정은 전역 설정의 범위 안에서 좁히는 방향으로만 병합되며, 넓히려면 전역 설정에서 `trust_project_config: true`를 명시해야 한다.
- 자식 프로세스 환경에서 `guard.secrets.env_patterns`에 일치하는 변수를 제거한다.

Parism은 `execFile`로 프로세스를 직접 실행한다. 셸을 거치지 않으므로 `;`, `$()`, 백틱, 파이프가 인자로 전달돼도 셸이 해석하지 않는다.

### Parism이 방어하지 않는 것

- 경로 검사는 검사 시점과 실행 시점 사이의 경합을 막지 못한다. 심볼릭 링크를 해석해 비교하지만, 검사 직후 실행 직전에 경로의 대상이 바뀌면 검사 결과와 실제 접근 대상이 달라질 수 있다.
- 허용된 바이너리 자체의 동작. 허용된 `git`은 저장소의 `.gitattributes`가 지정한 clean/smudge 필터를 실행할 수 있다. 저장소 설정에서 외부 프로그램이 실행되는 일부 경로는 주입 옵션(`core.fsmonitor=false`, `core.pager=cat`, `--no-textconv`, `--no-ext-diff`)으로 줄였으나 모든 경로를 막지는 못한다. 신뢰할 수 없는 저장소를 다룰 때는 컨테이너 격리를 사용한다.
- `build` 프로필은 프로젝트 코드를 실행한다. `npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose`, `node <script>`, `npx <bin>`은 저장소가 정의한 스크립트와 설정을 실행하므로 신뢰하는 저장소에서만 켠다. `yarn`은 저장소가 지정한 `yarnPath`를 따르므로 `build` 프로필에서만 허용된다.
- 실행되는 바이너리의 커널 수준 익스플로잇, 컨테이너 탈출, 공급망 침해
- 타이밍 사이드 채널, 파일 잠금 경합 등 부채널 공격
- Node.js 프로세스 메모리를 직접 조작하는 공격

---

## 4겹 방어선

### (a) allowed_commands 허용목록

`allowed_commands`에 등록되지 않은 명령은 프로세스를 생성하지 않는다. 차단 시 `failure.kind: "guard"`, `failure.reason: "command_not_allowed"` 응답이 반환된다. 권위 필드는 `failure`이며 하위 호환 필드 `guard_error.reason`도 함께 반환된다.

한계: 허용목록의 범위가 넓으면(예: `bash`, `sh`, `python`) 이 계층의 방어 효과가 크게 줄어든다. 실제로 필요한 명령만 포함해야 한다.

### (b) allowed_paths 경로 제한

`allowed_paths`를 설정하면 `cwd`와 경로 인자를 검사한다. `/`, `./`, `../`로 시작하는 인자, 플래그에 붙은 경로형 값(`--file=./x`, `-C../x`), 경로를 받는 명령의 위치 인자가 허용 경로 밖이면 차단된다. 비교는 심볼릭 링크 해석 후의 실경로로 한다.

한계: 커널이 강제하지 않으며 검사 시점과 실행 시점 사이에 경로가 바뀔 수 있다. 경로를 받지 않는 명령(예: `env`, `id`, `uname`)에는 적용되지 않는다. `allowed_paths`가 비어 있으면 이 계층은 생략된다.

### (c) 인젝션 패턴 차단

인자를 하나씩 순회하며 `block_patterns`(`;`, `$(`, 백틱, `&&`, `||`, `|`, `>`, `>>`, `<`)를 검사한다. 해당 패턴이 포함된 인자가 있으면 실행하지 않는다.

한계: 인자 수준 검사이므로 바이너리가 인자를 내부에서 셸에 위임하는 경우는 막지 못한다.

### (d) 명령별 정책 (command_policies)

명령마다 서브커맨드, 플래그(종류: bool, value, path), 위치 인자 규칙을 허용목록으로 정의한다. 기본 정책은 읽기 전용 조회만 허용한다. 정책이 없는 명령은 기존 방식(`command_arg_restrictions`와 경로 검사)만 적용된다.

- `guard.profile: "readonly"`(기본): 기본 정책만 적용한다.
- `guard.profile: "build"`: 빌드와 시험 실행에 필요한 서브커맨드(`npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose ps` 등)를 더한다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 사용한다.
- `guard.command_policies`: 명령 단위로 정책을 덮어쓴다. 우선순위는 `command_policies`, `build` 프로필, 기본 정책 순이다.
- `curl`의 `-H`, `-w` 값이 `@`로 시작하는 로컬 파일 참조와 `-w`/`--write-out` 값의 `%output{` 지시어는 차단한다.

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

`~/.parism/parsers/`에 등록된 외부 ParserPack은 현재 Node.js 프로세스에서 직접 로드된다. `node:vm`은 보안 메커니즘이 아니므로 `vm` 기반 격리는 채택하지 않는다. 격리 방향은 `worker_threads` 또는 `child_process.fork` 기반이며 근거와 대안은 `docs/adr/2026-07-21-external-parser-sandbox.md`에 있다. 신뢰할 수 없는 제3자 파서를 로드할 계획이라면 Parism 자체를 컨테이너 또는 VM 안에서 실행한다.

### 출력 리댁션 (Output Redaction)

`guard.secrets.output_redaction_enabled`는 기본 비활성이다. 활성화하면 파싱이 끝난 raw/stderr 출력에서 공통 시크릿 패턴을 마스킹한다. 파싱 전에 원본을 변조하지는 않는다. 시크릿이 stdout에 노출될 수 있는 환경에서는 이 옵션과 함께 `guard.secrets.env_patterns`로 자식 프로세스 환경에서 변수를 미리 제거한다.

---

## 참고 문서

- [SPECIFICATION.md](SPECIFICATION.md) §3.2: `failure` 필드 전체 계약
- [CHANGELOG.md](CHANGELOG.md): 버전별 변경 이력
- [README.md](README.md): Guard 설정 예시와 운영 가이드
