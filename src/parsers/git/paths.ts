/**
 * git이 따옴표로 감싸 출력하는 경로를 원래 경로로 되돌린다.
 * git은 ASCII 밖 바이트, 제어 문자, 큰따옴표, 역슬래시가 든 경로를 C 문자열 형식("n\303\251w.txt")으로 감싼다.
 * 따옴표로 감싸지 않은 경로는 그대로 돌려준다.
 *
 * **구현은 엔진에 있다**(`src/engine/c-quotes.ts`). 근거 검증도 같은 역변환을 알아야 해서다 —
 * 여기에 두면 `engine → parsers` 역전이 생긴다. 파서는 이미 엔진에 의존하므로
 * 반대 방향이 자연스럽다. 이 파일은 **이름을 유지한 채 재내보내는 얇은 껍데기**다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

export { readQuotedToken, unquoteCQuoted as unquoteGitPath } from "../../engine/c-quotes.js";
