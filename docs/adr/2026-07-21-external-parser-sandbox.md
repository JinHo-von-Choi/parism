# ADR: 외부 ParserPack 실행 격리 전략

- **작성자**: 최진호
- **작성일**: 2026-07-21
- **수정일**: 2026-10-03
- **상태**: 제안 (Phase 2 구현 전 선결 조건)

## 맥락

`~/.parism/parsers/`에 등록된 외부 ParserPack은 `parism add`로 영구 등록된 뒤, MCP 서버 시작 시 현재 Node.js 프로세스 컨텍스트에서 직접 `import`되어 로드된다(`src/cli/auto-loader.ts`). 이 로드 경로는 프로세스 격리, `vm` 기반 컨텍스트 분리, 모듈 접근 제한 중 어느 것도 적용하지 않는다.

외부 ParserPack의 `parse()` 함수는 임의의 Node.js 모듈(`child_process`, `fs`, 네이티브 애드온 포함)에 제약 없이 접근할 수 있다. 파서가 로컬에서 사용자 본인이 작성한 것이라면 위험 반경이 제한적이나, Phase 2에서 계획된 원격/공유 파서 배포 또는 다중 사용자 환경으로 확장될 경우 신뢰할 수 없는 코드가 동일 프로세스 권한으로 실행되는 구조가 된다.

TODOS.md는 이미 이 항목을 "Phase 2 Pre-requisite: Sandbox Security ADR"로 등재하고 있다: `vm.runInContext`의 `require` 제한, 허용 모듈 화이트리스트, `child_process`/네이티브 애드온 차단 전략의 설계가 Phase 2 구현 전 필요하다.

## 결정

Phase 2(원격/공유 ParserPack 실행)에 착수하기 전, 다음 세 가지를 설계·문서화한다.

1. **`worker_threads` 또는 `child_process.fork` 기반 격리**: 외부 ParserPack의 `parse()`는 메인 이벤트 루프와 분리된 실행 단위에서 수행한다. 메인 프로세스와는 메시지 전달(구조화 복제 또는 IPC)로만 `raw` 문자열과 결과를 주고받는다. 실행 단위마다 호출 시간 제한을 두고 초과하면 종료한다. 더 강한 메모리 격리가 필요하면 `fork`를, 호출 지연이 우선이면 워커 풀을 선택한다.
2. **허용 모듈 제한**: ParserPack이 사용할 수 있는 모듈을 순수 파싱에 필요한 범위로 한정한다. 워커 또는 자식 프로세스는 최소 권한 환경(정제된 `env`, 작업 디렉터리 고정, 리소스 한도)으로 기동하며, `child_process`와 네이티브 애드온으로 이어지는 로드 경로는 허용 목록에서 제외한다. Node.js 권한 모델(`--permission`)을 지원하는 버전에서는 파일 시스템과 자식 프로세스 권한을 거부한 채 기동한다.
3. **순수 함수 계약 유지**: 파서는 `raw` 문자열 입력을 받아 구조화된 값을 반환하는 순수 함수 계약을 유지하며, 그 외 I/O나 프로세스 생성 권한을 가지지 않는다.

`node:vm` 모듈은 보안 메커니즘이 아니다. Node.js 공식 문서는 "The node:vm module is not a security mechanism. Do not use it to run untrusted code."라고 명시한다. 따라서 `vm.runInContext`는 격리 수단으로 채택하지 않는다.

## 대안

- **`vm.runInContext` 기반 컨텍스트 분리 (기각)**: 컨텍스트에 주입하는 전역 객체에서 `require`, `process.binding`, `process.mainModule` 등을 제거해 상위 프로세스 접근 경로를 끊는 안이다. 같은 V8 힙과 같은 프로세스 권한을 공유하므로 생성자 체인(`this.constructor.constructor`) 등을 통한 탈출이 알려져 있고, Node.js 문서가 보안 용도로 쓰지 말 것을 명시한다. 허용 모듈 화이트리스트 `require` 셔틀을 더해도 탈출 경로 전체를 막는다고 보장할 수 없어 기각한다.
- **정적 분석만으로 사후 검증**: ParserPack 코드를 로드 전 AST 스캔하여 위험 API 호출을 탐지하는 방식. 동적 `eval`/문자열 조합 호출 등 정적 분석을 우회하는 패턴에 취약하여 단독 방어로는 불충분하다. 보조 수단으로만 쓴다.
- **현행 유지(격리 없음)**: 단일 사용자·로컬 신뢰 환경에서는 즉시 위험이 낮으나, Phase 2의 원격/공유 배포 전제와 충돌한다. Phase 2 착수 전 최소한 설계 결정을 문서화해 두어야 구현 시점에 재작업을 피할 수 있다.

## 결과

- `worker_threads` 또는 `child_process.fork` 격리, 모듈 제한, 순수 함수 계약 세 가지를 Phase 2 구현의 선결 설계로 확정한다.
- 호출당 메시지 전달과 기동 비용은 `benchmarks/`에 파서 실행 시나리오를 추가하여 Phase 2 구현과 함께 측정한다. `describe → dry_run → run` 온보딩 루프의 지연이 늘지 않도록 워커 재사용 여부를 그 결과로 정한다.
- 허용 모듈 목록과 실행 단위 기동 옵션의 세부 사양은 Phase 2 구현 착수 시 별도 설계 문서로 확정한다.
