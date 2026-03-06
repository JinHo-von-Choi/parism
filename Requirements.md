# Requirements

작성자: 최진호  
작성일: 2026-03-06

## 목적
- Parism 프로젝트의 핵심 이슈 4건(보안, 설정, 버전, CI)을 안정적으로 반영한다.

## 범위
- 포함:
  - `allowed_paths` 우회 방지(인자 경로 검증)
  - config 깊은 병합 처리
  - 서버 버전과 package 버전 정합성 확보
  - lockfile 동기화 및 CI 설치 안정화
- 제외:
  - 명시 요청 없는 배포/릴리스 실행
  - 파서 신규 명령 대규모 확장

## 기능 요구사항
1. Guard는 `cwd`뿐 아니라 경로형 인자도 `allowed_paths` 하위 여부를 검증해야 한다.
2. Guard는 경로 위반 시 `path_not_allowed`로 일관된 에러 봉투를 반환해야 한다.
3. Config 로더는 guard 하위 객체를 깊은 병합하여 기본 보안값 유실을 방지해야 한다.
4. MCP 서버가 노출하는 버전은 `package.json` 버전과 동일해야 한다.
5. `npm ci`가 항상 성공하도록 `package.json`과 `package-lock.json`이 동기화되어야 한다.

## 비기능 요구사항
- 기존 테스트 스위트가 모두 통과해야 한다.
- 신규 보안/설정 회귀 테스트를 포함해야 한다.
- 변경 사항은 최소 침습(minimal invasive)으로 반영한다.

## 검증 기준
- `npm ci` 성공
- `npm run build` 성공
- `npm test` 성공
- `npm run test:coverage` 성공
- guard/config/server 관련 신규 테스트 PASS

## 산출물
- 구현 계획 문서: `docs/plans/2026-03-06-issue-remediation.md`
- 코드/테스트 변경 커밋 세트
- 업데이트된 `Requirements.md`
