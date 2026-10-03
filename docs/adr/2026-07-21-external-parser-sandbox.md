# ADR: 외부 ParserPack 실행 격리 전략

- **작성자**: 최진호
- **작성일**: 2026-07-21
- **수정일**: 2026-10-03
- **상태**: 채택, 구현 완료 (v2.2.0)

## 맥락

`parism add`로 `~/.parism/parsers/`에 등록한 외부 ParserPack은 MCP 서버와 라이브러리 모드(`createEngine`) 시작 시 `loadExternalParsers`(`src/cli/auto-loader.ts`)가 읽는다. 이전에는 서버와 같은 스레드에서 `import`했으므로 팩의 결함이 서버 전체를 멈추거나 죽였다.

- `parse()`가 끝나지 않으면(무한 루프, 파국적 역추적 정규식) 이벤트 루프가 멈추고 모든 요청이 응답을 잃는다.
- 메모리를 과다하게 잡으면 서버 프로세스가 힙 상한으로 종료된다.
- 모듈 최상위 코드와 `console.log`가 서버 스레드에서 돌아 stdio 프로토콜(stdout)을 오염시킬 수 있다.

레지스트리의 `parse()`는 동기 API이고 엔진, CLI, 라이브러리 소비자가 그 계약에 의존한다.

## 결정

외부 팩은 기본적으로 팩마다 하나의 `node:worker_threads` 워커에서 읽고 실행한다(`src/parsers/external/host.ts`, `src/parsers/external/worker.js`). 내장 파서는 기존 경로 그대로 서버 스레드에서 실행한다.

1. **모듈 로드와 메타데이터**: 워커가 `parser.js`를 `import`하고 계약 선언(`headerLines`, `noise`, `acceptedFlags`, `rowsKey` 등)을 구조화 복제 가능한 값으로 바꿔 보낸다. 함수 값(`supports`, `hint`, 서브커맨드 안의 함수)은 위치 표식으로 바뀌고, 메인 스레드는 표식을 호출 때마다 워커에서 평가하는 대리 함수로 바꾼다. 메인 스레드는 팩 모듈의 최상위 코드를 실행하지 않는다. `parism add`도 팩 이름을 워커에서 읽는다.
2. **동기 호출**: 메인 스레드는 요청을 `MessagePort`로 보낸 뒤 `SharedArrayBuffer` 신호를 `Atomics.wait`로 기다리고 `receiveMessageOnPort`로 응답을 꺼낸다. 레지스트리의 공개 parse API는 동기로 남는다.
3. **상한**: 호출 하나의 시간 상한(기본 500ms)을 둔다. 한 `parse()` 호출의 계약 함수(`supports`, `hint`) 왕복, `parse` 왕복, 다시 띄운 워커의 기동 대기가 이 상한 하나를 함께 쓴다. 워커 힙 상한(`resourceLimits.maxOldGenerationSizeMb`, 기본 128MB)은 V8 힙의 old generation만 제한하며 `Buffer`, `ArrayBuffer`처럼 힙 밖에 잡는 메모리는 제한하지 않는다. 워커 기동과 모듈 로드에는 별도 상한 2초를 둔다.
4. **실패 처리**: 시간 상한 초과, 워커의 비정상 종료(`process.exit`, 잡히지 않은 예외), 메모리 상한 초과는 `parse_error.reason = "parser_exception"`과 원인을 밝힌 메시지로 보고한다. 워커를 끝내고 대기 시간(2초에서 시작해 장애가 이어지면 두 배씩, 최대 30초, 성공한 호출 뒤 2초로 돌아감) 동안은 워커를 띄우지 않고 바로 `parser_exception`으로 답한다. 대기 시간이 지난 뒤의 호출이 워커를 다시 띄우고, 기동이 그 호출의 상한 안에 끝나지 않으면 워커를 둔 채 그 호출만 실패로 끝낸다. 기동이 느린 팩이 장애 뒤마다 서버 스레드를 기동 상한만큼 막지 않게 하기 위해서다. 워커가 스스로 끝나면 종료 신호로 즉시 깨어나고, 메모리 상한으로 멈춘 워커는 신호를 남길 수 없어 시간 상한에서 끝난다. 워커의 `error` 이벤트(`ERR_WORKER_OUT_OF_MEMORY` 등)는 stderr 경고로 남긴다.
5. **반환값**: 구조화 복제 가능한 값만 받는다. 함수, Promise, Symbol이 든 반환값은 `parser_exception`이다. 이름이 `UnrecognizedOutputError`인 예외는 기존과 같이 `unrecognized_output`이다.
6. **strict 스키마 검사**: `parsers.strict_schemas`가 켜져 있으면 워커가 팩의 `schema.safeParse`로 검사하고 위반 메시지를 결과와 함께 돌려준다. 레지스트리는 조용한 빈 결과 판정 뒤에 그 메시지를 `schema_violation`으로 쓴다(서버 스레드 실행과 같은 순서).
7. **출력**: 워커 안의 `console`과 `process.stdout.write`는 stderr로 보낸다. 이것으로 막는 것은 이 두 경로의 stdout 오염뿐이다. 파일 기술자 1에 직접 쓰는 출력은 막지 못한다(워커는 보안 경계가 아니다).
8. **설정**: `parsers.external_isolation`(`"worker"` 기본, `"none"`), `parsers.external_time_limit_ms`(기본 500), `parsers.external_memory_limit_mb`(기본 128). 전역 설정에서 정한다. 신뢰하지 않는 프로젝트 설정(전역 `trust_project_config`가 참이 아님)은 격리를 켜거나 상한을 낮추는 방향만 반영하고, 격리를 끄거나 상한을 올리는 값은 경고 후 버린다.
9. **작성자 도구**: fixture replay 도우미(`runFixtureTests`, 예정된 `parism test`가 쓸 경로)는 팩 작성자가 자기 팩을 검사하는 도구이므로 팩 객체를 받아 같은 스레드에서 실행한다. `parism inspect`는 내장 파서만 쓴다.

## 이 결정이 주는 것과 주지 않는 것

워커 격리는 결함 격리다. 끝나지 않는 실행, 비정상 종료, V8 힙 과다가 서버를 멈추거나 죽이지 않게 한다. 힙 밖 메모리(`Buffer`, `ArrayBuffer`)의 과다는 막지 못한다.

보안 샌드박스가 아니다. 워커는 같은 프로세스의 권한을 그대로 가진다. 팩 코드는 워커 안에서도 파일을 읽고 쓰며, 네트워크에 접속하고, `child_process`로 프로그램을 실행하고, 환경 변수를 읽을 수 있다. 악의적인 팩을 막지 못한다. 신뢰할 수 없는 제3자 팩은 Parism 전체를 컨테이너나 VM 안에서 실행해야 한다.

## 대안

- **`node:vm` 컨텍스트 분리 (기각)**: Node.js 문서가 "The node:vm module is not a security mechanism. Do not use it to run untrusted code."라고 명시한다. 같은 힙과 이벤트 루프를 공유하므로 끝나지 않는 비동기 코드와 메모리 과다를 막지 못하고(`timeout`은 동기 실행에만 적용된다), 생성자 체인(`this.constructor.constructor`)을 통한 탈출이 알려져 있다. 결함 격리와 보안 격리 어느 쪽도 주지 못한다.
- **`child_process.fork` 격리 (보류)**: 프로세스 단위라 메모리와 비정상 종료를 더 강하게 격리하고 OS 수준 제한(권한 모델, 사용자 분리)을 덧붙일 여지가 있다. 그러나 동기 parse API를 유지하려면 자식 프로세스 응답을 동기로 기다리는 수단이 따로 필요하고, 호출당 IPC 직렬화 비용과 기동 비용이 워커보다 크다. 권한 분리 없이 fork만으로는 보안 경계가 되지 않는다는 점은 워커와 같다.
- **Node.js 권한 모델(`--permission`) (보류)**: 프로세스 전체에 적용되는 플래그라 워커 하나에만 걸 수 없다. 서버 자체가 파일 시스템과 자식 프로세스 권한을 필요로 하므로 서버 프로세스에 걸 수도 없다. 권한 분리는 fork 기반 격리와 함께 다시 검토한다.
- **비동기 parse API로 전환 (기각)**: 워커 기다림을 이벤트 루프에 맡길 수 있지만 레지스트리, 엔진, CLI, 라이브러리 소비자의 동기 계약을 깨는 변경이다.
- **정적 분석으로 사전 검증 (보조로만)**: 동적 `import`, 문자열 조합 호출 등으로 우회할 수 있어 단독 방어가 되지 않는다.

## 결과

- 외부 팩이 서버를 멈추는 시간이 호출 하나당 시간 상한 안으로 줄어든다. 상한을 기다리는 동안 서버 스레드는 막힌다. 장애 뒤 대기 시간 동안의 호출은 서버 스레드를 막지 않는다. 처음 로드(서버 시작, `parism add`)는 기동 상한까지 막힐 수 있다.
- 호출마다 입력과 결과를 구조화 복제하는 비용이 든다. 측정(`npm run benchmark:external`, Node 24, tsx 실행): 20줄 입력에서 호출당 평균 34.5µs(서버 스레드)와 142.1µs(워커), 500줄 입력에서 365.8µs와 2000.3µs. 워커 기동과 모듈 로드는 중앙값 약 158ms이고, 상한 초과 뒤 첫 호출(재기동과 파싱)은 약 165ms다.
- Breaking notes: 외부 팩의 `parse()`는 서버 스레드의 전역 상태를 볼 수 없고, 구조화 복제할 수 없는 값을 돌려주면 `parser_exception`이다. 이전 동작이 필요하면 전역 설정에서 `parsers.external_isolation: "none"`으로 되돌린다.
- 원격 파서 저장소나 자동 설치는 여전히 하지 않는다. 그 전에 권한 분리가 있는 격리(fork와 OS 수준 제한, 컨테이너)가 필요하다.
