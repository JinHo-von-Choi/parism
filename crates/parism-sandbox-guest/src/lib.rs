/**
 * 외부 파서 샌드박스의 시험용 게스트.
 *
 * ## 왜 게스트가 "시험용" 이어야 하는가
 *
 * 경계는 **막는 것의 목록**이 아니라 **못 막은 것을 아는 것**으로 증명된다.
 * 그런데 정상 동작하는 게스트만으로는 아무것도 증명할 수 없다 —
 * 파일을 못 읽은 게 권한 설정 때문인지, 게스트가 시도조차 안 해서인지를 구별할 수 없다.
 *
 * 그래서 이 게스트는 **경계를 시험하는 동작**을 담는다. 원문(raw) 의 접두어로 동작을 고른다.
 *
 * | 접두사 | 하는 일 | 증명하려는 것 |
 * |--------|---------|---------------|
 * | (없음) | 정상 파싱 | 경계가 없을 때도 동작한다 |
 * | `read-file:` | 파일을 열어 읽으려 한다 | 파일 접근이 **거부**된다 |
 * | `secret:` | `secret-exists` 를 부른다 | 값이 아니라 **존재 여부만** 온다 |
 * | `alloc:` | 큰 블록을 연속으로 잡는다 | 메모리 상한이 **트랩**을 일으킨다 |
 * | `spin:` | 무한 루프 | epoch 타임아웃이 **멈춘다** |
 * | `fail:` | 오류를 돌려준다 | 게스트의 오류가 **그대로** 전달된다 |
 *
 * 각 동작은 실패를 **결과 문자열로 보고**한다. 게스트가 죽으면 호스트가 그 사실을 보고한다.
 * 두 경로가 다르면 **누가 막았는지** 알 수 있다.
 *
 * ## WASI 를 직접 부르는 이유
 *
 * `wasi` 크레이트의 preview1 API 는 버전에 따라 모양이 달라진다.
 * 여기 필요한 건 `fd_prestat_get` 과 `path_open` 두 개뿐이라
 * **ABI 를 직접 선언**한다 — 의존성 하나를 줄이고, 무엇을 부르는지 눈으로 보인다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

use serde_json::json;

// `generate!("...")` 의 문자열은 **월드 이름**이다. 경로는 `path:` 옵션으로 준다.
wit_bindgen::generate!({ path: "../../wit", world: "external-parser" });

// wit-bindgen 이 만든 모듈:
//   `exports::parism::parser::parser::Guest` — 게스트가 노출할 인터페이스의 트레이트
//   `parism::parser::host::{log, secret_exists}` — 호스트가 제공하는 인터페이스의 함수
use exports::parism::parser::parser::Guest;

// WASI preview1 의 두 syscall. 경계 시험에만 쓴다.
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    /// preopen 정보를 얻는다. errno 를 돌려준다.
    fn fd_prestat_get(fd: u32, buf: *mut u8) -> u32;
    /// 경로로 파일을 연다. errno 를 돌려준다.
    #[allow(clippy::too_many_arguments)]
    fn path_open(
        dirfd: u32,
        dirflags: u32,
        path: *const u8,
        path_len: u32,
        oflags: u32,
        fs_rights_base: u64,
        fs_rights_inheriting: u64,
        fdflags: u32,
        opened_fd: *mut u32,
    ) -> u32;
}

/// WASI errno.
const ERRNO_SUCCESS: u32 = 0;
const ERRNO_BADF: u32 = 8;

/// `FS_RIGHTS_FD_READ` — 읽기 권한 비트.
const RIGHTS_FD_READ: u64 = 1 << 1;

/// 동작 접두사.
mod mode {
    pub const READ_FILE: &str = "read-file:";
    pub const SECRET:    &str = "secret:";
    pub const ALLOC:     &str = "alloc:";
    pub const SPIN:      &str = "spin:";
    pub const FAIL:      &str = "fail:";
}

/// 게스트 구현.
struct SandboxGuest;

impl Guest for SandboxGuest {
    fn parse(raw: String) -> Result<String, String> {
        if let Some(path) = raw.strip_prefix(mode::READ_FILE) {
            return Ok(try_read_file(path));
        }
        if let Some(name) = raw.strip_prefix(mode::SECRET) {
            // 값이 아니라 존재 여부만 온다.
            let exists = parism::parser::host::secret_exists(name);
            return Ok(json!({ "mode": "secret", "name": name, "exists": exists }).to_string());
        }
        if let Some(size) = raw.strip_prefix(mode::ALLOC) {
            return Ok(try_allocate(size));
        }
        if raw.starts_with(mode::SPIN) {
            return Ok(spin_forever());
        }
        if let Some(reason) = raw.strip_prefix(mode::FAIL) {
            // 게스트가 "이 형식은 모른다" 고 말하는 경로.
            return Err(format!("UnrecognizedOutputError: {reason}"));
        }
        Ok(json!({ "mode": "parse", "echo": raw }).to_string())
    }
}

/// preopen 디렉터리 fd 목록.
///
/// preview1 에서는 게스트가 목록을 못 보고 `fd_prestat_get` 으로 하나씩 물어봐야 한다.
/// **호스트가 preopen 을 하나도 주지 않으면 이 목록이 비어 있다** — 그게 거부다.
fn preopened_dirs() -> Vec<u32> {
    let mut out = Vec::new();
    // preopen 은 fd 3 부터 시작한다.
    let mut fd = 3u32;
    while fd < 64 {
        let mut buf = [0u8; 8];
        let errno = unsafe { fd_prestat_get(fd, buf.as_mut_ptr()) };
        if errno != ERRNO_SUCCESS {
            break;
        }
        out.push(fd);
        fd += 1;
    }
    out
}

/// 파일을 열어 읽으려 한다. 실패하면 **실패 이유를 보고한다.**
fn try_read_file(path: &str) -> String {
    let dirs = preopened_dirs();
    let Some(dir) = dirs.first().copied() else {
        return json!({ "mode": "read-file", "path": path, "ok": false, "error": "no preopened directory" }).to_string();
    };
    let bytes = path.as_bytes();
    let mut opened = 0u32;
    let errno = unsafe {
        path_open(
            dir,
            0,
            bytes.as_ptr(),
            bytes.len() as u32,
            0, // oflags — 읽기 전용
            RIGHTS_FD_READ,
            RIGHTS_FD_READ,
            0, // fdflags
            &mut opened,
        )
    };
    if errno != ERRNO_SUCCESS {
        return json!({ "mode": "read-file", "path": path, "ok": false, "errno": errno }).to_string();
    }
    // 열렸다면 실제로 내용을 읽어 **값이 새지 않았는지** 확인할 수 있게 돌려준다.
    json!({ "mode": "read-file", "path": path, "ok": true, "fd": opened }).to_string()
}

/// 큰 블록을 연속으로 잡는다. 메모리 상한을 넘으면 **트랩**이 나야 한다.
fn try_allocate(size: &str) -> String {
    let bytes: usize = size.trim().parse().unwrap_or(1024 * 1024);
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    for _ in 0..1024 {
        blocks.push(vec![0u8; bytes]);
    }
    let total: usize = blocks.iter().map(|b| b.len()).sum();
    json!({ "mode": "alloc", "requested": bytes, "allocated": total }).to_string()
}

/// 무한 루프. epoch 타임아웃이 **여기서** 멈춰야 한다.
///
/// ## 왜 `black_box` 가 필요한가
///
/// 이 루프는 **최적화하면 끝난다**(실측).
///
/// 반복 횟수가 2^64 로 상수인 것을 LLVM 이 귀납 변수 분석으로 계산해버린다.
/// 루프 전체를 "n = u64::MAX" 한 줄로 접어 버린다 — 1.2ms 만에 끝난다(실측).
/// 그러면 타임아웃을 시험할 수 없다. **무한 루프가 아니라면 무한 루프를 못 잡는 것과 같다.**
///
/// `black_box` 는 최적화기에 "이 값은 모른다" 고 말해 귀납 변수 분석을 막는다.
fn spin_forever() -> String {
    let mut n: u64 = 0;
    loop {
        n = core::hint::black_box(n).wrapping_add(1);
        if core::hint::black_box(n) == u64::MAX {
            return json!({ "mode": "spin", "count": n }).to_string();
        }
    }
}

export!(SandboxGuest);
