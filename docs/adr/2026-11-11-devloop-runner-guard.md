# ADR: 시험 러너와 진단 도구의 실행 인자를 가드에서 다루는 방식

- **작성자**: 최진호
- **작성일**: 2026-11-11
- **상태**: 채택, 구현 완료

## 맥락

시험 러너(vitest, jest, pytest, go test, cargo test)와 진단 도구(tsc, eslint, ruff, mypy, cargo build)의 출력을 구조화하려면 각 도구를 기계용 출력 형식으로 실행해야 한다. 이때 가드와 맞닿는 지점이 세 곳 있다.

1. `run`의 `machine_format` 옵션은 호출자가 주지 않은 인자를 Parism이 덧붙인다.
2. vitest 5의 json 리포터는 표준 출력이 아니라 파일에 보고서를 쓴다. pytest는 표준 출력에 기계용 형식이 없고 JUnit XML 파일로만 보고서를 낸다. 표준 출력으로 받는 방법(`--outputFile=/dev/stdout`)은 Node가 자식의 표준 출력을 소켓으로 연결하기 때문에 `ENXIO`로 실패한다.
3. `cargo build`, `cargo test`, `cargo check`는 build 프로필에서 서브커맨드만 열려 있었고, 대상을 고르는 옵션(`--lib`, `-p`)과 출력 형식(`--message-format`)은 막혀 있었다.

## 결정

### 1. 덧붙인 형식 인자는 가드 검사를 받는다

`machine_format`으로 덧붙이는 인자(`--reporter=json`, `--format json`, `--pretty false`, `--json`, `--message-format=json`, `-json`, `--output-format=json`, `--output=json`)는 호출자 인자와 합친 뒤 `checkGuard`를 통과해야 실행한다. 응답의 `args`에는 이 합친 인자를 싣는다. 인자 변환 때문에 가드 경로가 따로 생기지 않는다.

### 2. 보고서 파일 경로는 가드 검사 뒤에 Parism이 붙인다

보고서를 파일로만 쓰는 러너에는 Parism이 `mkdtemp`로 만든 임시 디렉터리 안의 고정 이름 파일을 출력 경로로 준다. 이 인자는 가드 검사 뒤 실행 직전에 붙이고 응답의 `args`에는 싣지 않는다. git의 `-c` 덮어쓰기, npx의 `--no`와 같은 자리다(`buildExecArgs`).

- vitest에는 `--outputFile=<경로>`, pytest에는 `--junitxml=<경로>`로 준다.
- 경로는 호출자가 정할 수 없다. 호출자가 `--outputFile`이나 `--junitxml`을 직접 주면 `machine_format`은 인자를 바꾸지 않고, 그 경로는 평소처럼 가드의 경로 검사를 받는다.
- 실행이 끝나면 파일을 읽고 임시 디렉터리를 지운다. 읽는 크기는 실행기의 출력 버퍼 상한(10MB)과 같다.
- 임시 디렉터리는 `guard.allowed_paths` 밖에 있다. 이 예외는 Parism이 만든 경로 하나에만 해당한다.

### 3. cargo build, test, check에 대상 선택 옵션과 json 형식을 연다

build 프로필의 cargo 정책에 다음을 더한다.

- 불리언: `--lib`, `--bins`, `--tests`, `--examples`, `--all-targets`, `--workspace`, `--release`, `--all-features`, `--no-default-features`, `--no-fail-fast`, `--locked`, `--offline`, `--frozen`
- 값: `-p`, `--package`, `--bin`, `--test`, `--example`, `--features`, `-j`, `--jobs`, `--message-format`
- `--message-format`의 값은 `json`만 받는다.

`--config`, `--target-dir`, `--manifest-path`는 열지 않는다. 설정을 덮어쓰거나 저장소 밖 경로를 가리킬 수 있기 때문이다.

이 서브커맨드들은 이미 저장소의 빌드 스크립트와 시험 코드를 실행한다. 대상을 고르는 옵션은 실행 범위를 정할 뿐 새 권한을 열지 않는다.

### 4. npx와 직접 실행은 기존 규칙을 그대로 쓴다

- `npx`는 build 프로필에서만 동작하고 `--no`가 붙어 설치되지 않은 패키지를 내려받지 않는다. 이 규칙은 바꾸지 않는다.
- `vitest`, `jest`, `tsc`, `eslint`, `pytest`, `go`, `ruff`, `mypy`를 직접 실행하려면 사용자가 `allowed_commands`에 넣어야 한다. 기본 허용 목록에는 넣지 않는다.
- `npm test`, `npm run <스크립트>`의 출력은 파싱하지 않는다. 어떤 러너가 어떤 형식으로 출력할지 정해져 있지 않다.

## 이 결정이 주는 것과 주지 않는 것

- 준다: 러너의 결과를 구조화해 받는 경로. 호출자가 정하지 않은 경로에 쓰거나 읽는 일은 생기지 않는다.
- 주지 않는다: 러너가 실행하는 저장소 코드에 대한 격리. 시험과 빌드는 저장소의 코드를 그대로 실행한다. 그래서 이 명령들은 build 프로필에서만 열린다.

## 결과

- 러너 출력은 `max_output_bytes`와 관계없이 전체를 읽어 파싱한다. JSON 문서를 중간에서 자르면 읽을 수 없기 때문이다. 실행기의 버퍼 상한(10MB)은 그대로 적용된다. 파싱에 실패했을 때만 원문을 `max_output_bytes`로 잘라 응답에 싣는다.
- 러너가 실패했는데 읽을 출력이 없으면 결과를 만들지 않는다.

## 기각한 방안

| 방안 | 기각한 이유 |
|-|-|
| `/dev/stdout`을 가드의 경로 검사에서 예외로 두기 | Node가 연결한 표준 출력에서는 열리지 않는다. 동작하지 않는 예외를 가드에 남기게 된다 |
| 자식의 표준 출력을 파일 디스크립터로 바꿔 연결하기 | 실행기의 출력 수집, 버퍼 상한, 진행 알림 경로를 모두 바꿔야 한다 |
| 호출자가 보고서 경로를 정하게 하기 | 호출자가 정한 경로를 Parism이 읽고 지우게 된다 |
