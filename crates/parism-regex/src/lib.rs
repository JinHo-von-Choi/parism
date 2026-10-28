//! 역추적 불가능 정규식 엔진.
//!
//! ## 왜 Rust 인가
//!
//! JavaScript 의 정규식은 역추적(backtracking) 엔진이다. 사용자가 설정한 비밀 패턴이
//! `(a+)+` 같은 형태면 최악 시간에 걸릴 수 있다. `regex` 크레이트는 유한 오토마톤이라
//! **항상 선형 시간**을 보장한다.
//!
//! 하지만 이 크레이트는 **역참조(backreference) 와 lookaround 를 지원하지 않는다.**
//! 그건 버그가 아니라 사양이다 — 지원하지 않는 패턴은 여기서 **런타임 오류**로 알리고,
//! 호출하는 쪽은 TypeScript 엔진으로 되돌린다.
//!
//! ## 좌표계
//!
//! 이 크레이트는 **바이트 오프셋**을 돌려준다. JavaScript 의 문자열 인덱스는 UTF-16 코드유닛이라
//! 두 좌표계가 다르다. 변환은 호출하는 쪽(JS)이 한다 — 여기서 "바이트가 편하니까" 라는 이유로
//! 조용히 섞지 않는다.
//!
//! ## 대소문자 구분
//!
//! 이 크레이트는 **대소문자를 구분하지 않는다**(`i` 플래그 없음).
//! JavaScript 의 `i` 플래그는 ECMA-262 정규화(Canonicalize)를 쓰고 Rust 의 `(?i)` 는
//! 유니코드 단순 케이 폴딩을 쓴다. 두 규칙은 `ſ`(U+017F) 같은 문자에서 달라진다.
//! 그 차이를 감수하지 않으려면 `i` 플래그 패턴은 아예 여기 오면 안 된다.

use regex::{NoExpand, Regex, RegexBuilder};

/// 컴파일된 정규식 프로그램 크기 상한(bytes).
///
/// 패턴이 이 크기를 넘으면 컴파일을 거부한다. 크기를 키우는 패턴은 보통 폭탄이며,
/// 그걸 컴파일해 둔 채 실행하는 것보다 거부하는 편이 낫다.
pub const SIZE_LIMIT: usize = 10 * 1024 * 1024;

/// 한 번의 매칭 결과. 좌표는 **바이트** 오프셋이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub byte_start: usize,
    pub byte_end: usize,
}

/// 오류 종류. 호출하는 쪽은 이 값으로 폴백 여부를 판단한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// 이 엔진이 지원하지 않는 문법. (lookaround, 역참조 등) 호출하는 쪽이 TypeScript 로 되돌린다.
    Unsupported,
    /// 패턴 문법 오류.
    Invalid,
    /// 크기 상한 초과.
    TooLarge,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Unsupported => "unsupported",
            ErrorKind::Invalid => "invalid",
            ErrorKind::TooLarge => "too_large",
        }
    }
}

/// 엔진 오류.
#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Error { kind, message: message.into() }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for Error {}

/// `regex` 크레이트의 컴파일 오류를 우리 종류로 옮긴다.
///
/// `regex` 의 오류 메시지에 "not supported" 가 들어 있으면 **지원하지 않는 문법**이다.
/// 그 구분은 메시지 문자열에 의존한다 — 더 나은 방법이 없기 때문이다.
fn map_compile_error(err: regex::Error) -> Error {
    let message = err.to_string();
    let kind = if message.contains("not supported") || message.contains("backreference") {
        ErrorKind::Unsupported
    } else if message.contains("exceeded the size limit") || message.contains("size limit") {
        ErrorKind::TooLarge
    } else {
        ErrorKind::Invalid
    };
    Error::new(kind, message)
}

/// 패턴을 컴파일한다. 크기 상한을 건다.
fn compile(pattern: &str) -> Result<Regex, Error> {
    RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .build()
        .map_err(map_compile_error)
}

/// 패턴이 이 엔진으로 처리 가능한지 확인한다. 실행은 하지 않는다.
///
/// 지원하지 않는 문법이면 `ErrorKind::Unsupported` 다. 호출하는 쪽은 이 값으로
/// TypeScript 폴백을 결정한다.
pub fn validate(pattern: &str) -> Result<(), Error> {
    compile(pattern).map(|_| ())
}

/// 첫 번째 매칭만 찾는다.
pub fn find_first(pattern: &str, text: &str) -> Result<Option<Match>, Error> {
    let re = compile(pattern)?;
    Ok(re.find(text).map(|m| Match { byte_start: m.start(), byte_end: m.end() }))
}

/// 모든 매칭을 찾는다. 겹치지 않는 매칭이 순서대로 나온다.
///
/// 빈 매칭도 나온다. 호출하는 쪽이 **빈 매칭을 건너뛸지** 판단한다 —
/// JavaScript 의 `exec` 루프와 같은 순서다.
pub fn find_all(pattern: &str, text: &str) -> Result<Vec<Match>, Error> {
    let re = compile(pattern)?;
    Ok(re
        .find_iter(text)
        .map(|m| Match { byte_start: m.start(), byte_end: m.end() })
        .collect())
}

/// 모든 매칭을 치환한다. 치환 문자열의 `$1` `${name}` 는 **캡처 그룹 참조**로 펼쳐진다.
///
/// JavaScript 의 `String.replace` 와 같은 규칙이다. `$&` 처럼 JavaScript 만 지원하는 표기는 없다.
pub fn replace_all(pattern: &str, text: &str, replacement: &str) -> Result<String, Error> {
    let re = compile(pattern)?;
    Ok(re.replace_all(text, replacement).into_owned())
}

/// 치환 결과와 **JavaScript 와 같은 결과임의 보장**.
///
/// JavaScript 의 `String.replace(re, replacement)` 은 전역 정규식일 때 **빈 매칭도 치환한다.**
/// Rust 의 반복자는 **비어 있지 않은 매칭 직후의 빈 매칭을 건너뛴다.** 그래서 그대로 쓰면 결과가 다르다.
///
/// 여기서는 `find_at` 을 직접 써서 JavaScript 의 순서를 그대로 따른다.
/// 마지막 값이 `false` 면 **Rust 로 재현할 수 없다는 뜻**이다.
/// 호출하는 쪽은 그때 TypeScript 로 되돌려야 한다.
///
/// 언제 그런가 — 빈 매칭이 하나라도 나왔고, 텍스트에 BMP 밖 문자가 있을 때.
/// JavaScript 는 UTF-16 코드유닛으로, Rust 는 문자로 세기 때문에 빈 매칭의 개수가 달라진다.
pub fn replace_all_js(pattern: &str, text: &str, replacement: &str) -> Result<(String, bool), Error> {
    let re = compile(pattern)?;
    let mut out = String::new();
    let mut last = 0usize;
    let mut at = 0usize;
    let mut emitted_empty = false;

    while at <= text.len() {
        let Some(m) = re.find_at(text, at) else { break };
        out.push_str(&text[last..m.start()]);
        out.push_str(replacement);
        last = m.end();
        if m.start() == m.end() {
            emitted_empty = true;
            at = next_boundary(text, m.end());
        } else {
            // 다음 탐색을 매칭 끝에서 시작한다. `find_at` 이 거기 있는 빈 매칭을 준다.
            at = m.end();
        }
    }
    out.push_str(&text[last..]);

    let exact = !(emitted_empty && has_astral(text));
    Ok((out, exact))
}

/// 다음 문자 경계. JavaScript 는 UTF-16 코드유닛으로 한 칸 가지만 Rust 는 문자로 간다.
fn next_boundary(text: &str, at: usize) -> usize {
    if at >= text.len() {
        return text.len() + 1;
    }
    let mut next = at + 1;
    while next < text.len() && !text.is_char_boundary(next) {
        next += 1;
    }
    next
}

/// BMP 밖 문자(서로게이트 쌍)가 있는가.
fn has_astral(text: &str) -> bool {
    text.chars().any(|c| c as u32 > 0xffff)
}

/// 모든 매칭을 **리터럴로** 치환한다. 치환 문자열의 `$` 도 그대로다.
///
/// `src/fixtures/sanitize.ts` 가 쓰는 방식이다. 거기서는 치환 문자열을 `$1` 로 이식하지 않는다.
pub fn replace_all_literal(pattern: &str, text: &str, replacement: &str) -> Result<String, Error> {
    let re = compile(pattern)?;
    Ok(re.replace_all(text, NoExpand(replacement)).into_owned())
}

/// 같은 텍스트에 여러 패턴을 한 번에 적용해 매칭 목록을 얻는다.
///
/// 패턴마다 텍스트가 달라지지 않을 때(펙스처 새니타이즈) 라운드 트립을 줄이는 용도다.
pub fn find_all_many(patterns: &[String], text: &str) -> Result<Vec<Vec<Match>>, Error> {
    let mut out = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        out.push(find_all(pattern, text)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 찾는다() {
        let m = find_first("b+", "abbbc").unwrap().unwrap();
        assert_eq!((m.byte_start, m.byte_end), (1, 4));
    }

    #[test]
    fn 없으면_없다() {
        assert!(find_first("zzz", "abc").unwrap().is_none());
    }

    #[test]
    fn 바이트_오프셋이다() {
        let m = find_first("é", "aéb").unwrap().unwrap();
        assert_eq!((m.byte_start, m.byte_end), (1, 3));
    }

    #[test]
    fn 역참조는_지원하지_않는다() {
        let err = validate(r"(a)\1").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Unsupported);
    }

    #[test]
    fn lookaround는_지원하지_않는다() {
        for pat in [r"(?=a)", r"(?!a)", r"(?<=a)", r"(?<!a)"] {
            assert_eq!(validate(pat).unwrap_err().kind, ErrorKind::Unsupported, "{pat}");
        }
    }

    #[test]
    fn 문법_오류는_Invalid다() {
        assert_eq!(validate("(").unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn 리터럴_치환은_달러를_그대로_쓴다() {
        assert_eq!(replace_all_literal("x", "axb", "$1").unwrap(), "a$1b");
    }

    #[test]
    fn 그룹_치환은_확장한다() {
        assert_eq!(replace_all("(a)(b)", "zab", "$2$1").unwrap(), "zba");
    }

    #[test]
    fn 빈_매칭도_나온다() {
        let all = find_all("x*", "abc").unwrap();
        assert_eq!(all.len(), 4);
        assert!(all.iter().all(|m| m.byte_start == m.byte_end));
    }

    #[test]
    fn js_치환은_빈_매칭을_지우지_않는다() {
        // JavaScript: "abc".replace(/.*/g, "-") === "--"
        let (out, exact) = replace_all_js(".*", "abc", "-").unwrap();
        assert_eq!(out, "--");
        assert!(exact);
    }

    #[test]
    fn js_치환은_빈_매칭_only_패턴도_맞는다() {
        // JavaScript: "abc".replace(/x*/g, "-") === "-a-b-c-"
        let (out, exact) = replace_all_js("x*", "abc", "-").unwrap();
        assert_eq!(out, "-a-b-c-");
        assert!(exact);
    }

    #[test]
    fn bmp_밖_문자가_있으면_정확함을_보장하지_않는다() {
        let (out, exact) = replace_all_js("x*", "a\u{1F389}b", "-").unwrap();
        assert!(!exact);
        assert!(!out.is_empty());
    }
}
