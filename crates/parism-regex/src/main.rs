//! `parism-regex` — 정규식 엔진 프로세스.
//!
//! 호출하는 쪽(JS)과 **길이 프레이밍**으로 통신한다. JSON 을 쓰지 않는다.
//!
//! ## 왜 JSON 이 아닌가
//!
//! 이 크레이트의 의존은 `regex` 하나뿐이어야 한다. 정당한 이유다 — 보안에 걸린 네이티브
//! 컴포넌트는 의존이 적을수록 좋다. JSON 직렬화를 위해 `serde_json` 을 끌어오면 그 근거가 약해진다.
//! 길이 프레이밍은 더 빠르고(이스케이프 비용이 없다) 의존도 없다.
//!
//! ## 프레임
//!
//! 요청은 **little-endian u32** 로 된 필드들이 이어진다.
//!
//! ```text
//! op          u8    1=validate 2=find_first 3=find_all 4=find_all_many 5=replace_all
//! id          u32
//! count       u32          패턴 개수
//! pattern     count × ( u32 길이 + 바이트 )
//! text        u32 길이 + 바이트
//! replacement u32 길이 + 바이트
//! literal     u8           1 이면 리터럴 치환
//! ```
//!
//! 응답
//!
//! ```text
//! status      u8    0=성공 1=오류
//! id          u32
//! kind        u8    0=없음 1=지원하지 않음 2=문법 오류 3=크기 초과
//! message     u32 길이 + 바이트
//! 결과        op 에 따라 달라진다 (아래 handle 참조)
//! ```
//!
//! 좌표는 **바이트 오프셋**이다. JS 쪽이 UTF-16 인덱스로 바꾼다.

use std::io::{self, BufWriter, Read, Write};

use parism_regex::{find_all, find_all_many, find_first, replace_all_js, validate, ErrorKind};

const OP_VALIDATE: u8 = 1;
const OP_FIND_FIRST: u8 = 2;
const OP_FIND_ALL: u8 = 3;
const OP_FIND_ALL_MANY: u8 = 4;
const OP_REPLACE_ALL: u8 = 5;

/// 바이트를 읽는 도우미. 끝에 닿으면 `None`.
struct Reader<R: Read> {
    inner: R,
}

impl<R: Read> Reader<R> {
    fn new(inner: R) -> Self {
        Reader { inner }
    }

    fn u8(&mut self) -> Option<u8> {
        let mut buf = [0u8; 1];
        self.inner.read_exact(&mut buf).ok()?;
        Some(buf[0])
    }

    fn u32(&mut self) -> Option<u32> {
        let mut buf = [0u8; 4];
        self.inner.read_exact(&mut buf).ok()?;
        Some(u32::from_le_bytes(buf))
    }

    fn bytes(&mut self, len: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; len];
        self.inner.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    fn string(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let raw = self.bytes(len)?;
        String::from_utf8(raw).ok()
    }
}

/// 응답을 쌓는 도우미.
///
/// 응답은 **총 길이 접두어**로 시작한다. 스트림을 읽는 쪽이 op 을 몰라도
/// 프레임 경계를 알 수 있어야 하기 때문이다.
struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Writer { buf: Vec::new() }
    }

    fn u8(&mut self, value: u8) {
        self.buf.push(value);
    }

    fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    fn string(&mut self, value: &str) {
        self.u32(value.len() as u32);
        self.buf.extend_from_slice(value.as_bytes());
    }

    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.buf.extend_from_slice(value);
    }

    /// 총 길이 접두어를 붙여 완성된 프레임을 만든다.
    fn finish(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.buf.len() + 4);
        out.extend_from_slice(&(self.buf.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.buf);
        out
    }
}

/// 오류 종류 번호.
fn kind_code(kind: ErrorKind) -> u8 {
    match kind {
        ErrorKind::Unsupported => 1,
        ErrorKind::Invalid => 2,
        ErrorKind::TooLarge => 3,
    }
}

/// 요청 하나를 읽어 처리하고 응답 바이트를 만든다.
fn handle(reader: &mut Reader<impl Read>) -> Vec<u8> {
    let mut out = Writer::new();

    let Some(op) = reader.u8() else {
        return out.finish();
    };
    let Some(id) = reader.u32() else {
        return out.finish();
    };
    let Some(count) = reader.u32() else {
        return out.finish();
    };

    let mut patterns: Vec<String> = Vec::with_capacity(count as usize);
    for _ in 0..count {
        match reader.string() {
            Some(p) => patterns.push(p),
            None => {
                out.u8(1);
                out.u32(id);
                out.u8(kind_code(ErrorKind::Invalid));
                out.string("truncated request");
                return out.finish();
            }
        }
    }
    let Some(text) = reader.string() else {
        return out.finish();
    };
    let Some(replacement) = reader.string() else {
        return out.finish();
    };
    let Some(literal) = reader.u8() else {
        return out.finish();
    };

    let result: Result<Writer, parism_regex::Error> = (|| {
        let mut body = Writer::new();
        match op {
            OP_VALIDATE => {
                validate(&patterns[0])?;
            }
            OP_FIND_FIRST => {
                let found = find_first(&patterns[0], &text)?;
                match found {
                    Some(m) => {
                        body.u8(1);
                        body.u32(m.byte_start as u32);
                        body.u32(m.byte_end as u32);
                    }
                    None => {
                        body.u8(0);
                        body.u32(0);
                        body.u32(0);
                    }
                }
            }
            OP_FIND_ALL => {
                let all = find_all(&patterns[0], &text)?;
                body.u32(all.len() as u32);
                for m in all {
                    body.u32(m.byte_start as u32);
                    body.u32(m.byte_end as u32);
                }
            }
            OP_FIND_ALL_MANY => {
                let results = find_all_many(&patterns, &text)?;
                body.u32(results.len() as u32);
                for all in results {
                    body.u32(all.len() as u32);
                    for m in all {
                        body.u32(m.byte_start as u32);
                        body.u32(m.byte_end as u32);
                    }
                }
            }
            OP_REPLACE_ALL => {
                // 치환은 리터럴로 한다. JavaScript 의 `$1` 확장은 호출하는 쪽이 다룬다.
                let _ = literal;
                let (out_text, exact) = replace_all_js(&patterns[0], &text, &replacement)?;
                body.bytes(out_text.as_bytes());
                body.u8(if exact { 1 } else { 0 });
            }
            other => {
                return Err(parism_regex::Error {
                    kind: ErrorKind::Invalid,
                    message: format!("unknown op: {other}"),
                });
            }
        }
        Ok(body)
    })();

    match result {
        Ok(body) => {
            out.u8(0);
            out.u32(id);
            out.u8(0);
            out.string("");
            out.buf.extend_from_slice(&body.buf);
        }
        Err(err) => {
            out.u8(1);
            out.u32(id);
            out.u8(kind_code(err.kind));
            out.string(&err.message);
        }
    }
    out.finish()
}

fn main() {
    let stdin  = io::stdin();
    let stdout = io::stdout();
    let mut reader = Reader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let response = handle(&mut reader);
        if response.is_empty() {
            break;
        }
        if writer.write_all(&response).is_err() {
            break;
        }
        if writer.flush().is_err() {
            break;
        }
    }
}
