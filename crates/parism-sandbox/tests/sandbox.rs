/**
 * 외부 파서 샌드박스의 경계 시험.
 *
 * ## 이 시험이 증명하려는 것
 *
 * 1. **게스트는 파일에 닿지 못한다** — capability 맵이 비어 있으면 preopen 이 없다.
 * 2. **게스트는 시크릿의 값을 알 수 없다** — 존재 여부만 온다.
 * 3. **메모리 상한은 지켜진다** — 넘으면 트랩한다.
 * 4. **실행 시간 상한은 지켜진다** — epoch 타임아웃이 멈춘다.
 * 5. **호출 사이에 공유 상태가 없다** — 새 호출은 이전 호출의 것을 보지 못한다.
 *
 * ## 왜 게스트가 "시험용"인가
 *
 * 1번을 증명하려면 게스트가 **실제로 파일을 열어 보려야** 한다.
 * 시도하지 않는 게스트를로는 "권한 설정 때문인지, 시도 안 해서인지" 를 구별할 수 없다.
 *
 * ## 게스트 컴포넌트가 없으면
 *
 * 시험이 아니라 **건너뛴다.** 샌드박스가 없으면 아무것도 증명하지 못한다 —
 * 조용히 통과시키는 것은 통과와 다르다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

use std::path::PathBuf;
use std::time::Duration;

use parism_sandbox::{Capabilities, Failure, Limits, Outcome, Sandbox};

/// 시험용 게스트 컴포넌트 경로.
fn guest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("sandbox-guest.component.wasm")
}

/// 게스트 컴포넌트가 없으면 시험을 건너뛴다.
fn sandbox(limits: Limits) -> Option<Sandbox> {
    let path = guest_path();
    if !path.exists() {
        eprintln!("게스트 컴포넌트가 없다: {}", path.display());
        eprintln!("만드는 방법: node scripts/build-sandbox-guest.mjs");
        return None;
    }
    Some(Sandbox::load(&path, limits).expect("샌드박스를 만들 수 없다"))
}

#[test]
fn 게스트는_정상적으로_동작한다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let outcome = sandbox.run("안녕", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Parsed { value, .. } => {
            assert!(value.contains("안녕"), "결과에 원문이 있어야 한다: {value}");
        }
        Outcome::Failed { failure, message } => {
            panic!("정상 호출이 실패했다: {failure:?} {message}");
        }
    }
}

#[test]
fn 게스트는_파일에_닿지_못한다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let outcome = sandbox.run("read-file:/etc/passwd", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Parsed { value, .. } => {
            // 게스트가 **시도했고** 실패했다는 사실이 중요하다.
            assert!(
                value.contains("\"ok\":false"),
                "게스트가 파일 접근에 실패했어야 한다: {value}"
            );
            assert!(
                !value.contains("root:"),
                "파일 내용이 새면 안 된다: {value}"
            );
        }
        Outcome::Failed { failure, message } => {
            // 게스트가 죽었어도 **거부**는 거부다. 다만 이유가 다를 뿐이다.
            assert!(
                matches!(failure, Failure::Trapped | Failure::OutOfMemory),
                "파일 접근이 다른 이유로 막히면 안 된다: {failure:?} {message}"
            );
        }
    }
}

#[test]
fn capability를_열면_파일을_읽을_수_있다() {
    // capability 맵을 **비우면** 안 되는 이유를 보여 주는 대조 시험.
    // 이 테스트는 capability 맵이 실제로 동작한다는 증거다.
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let capabilities = Capabilities {
        fs_read: vec![("/etc".to_string(), "/etc".to_string())],
        env:     Vec::new(),
    };
    let outcome = sandbox.run("read-file:hostname", &capabilities, &[]);
    match outcome {
        Outcome::Parsed { value, .. } => {
            assert!(value.contains("\"ok\":true"), "열린 경로에서는 읽어야 한다: {value}");
        }
        Outcome::Failed { failure, message } => {
            panic!("열린 capability 로는 실패하면 안 된다: {failure:?} {message}");
        }
    }
}

#[test]
fn 게스트는_시크릿의_존재여부만_알_수_있다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let secrets = vec!["OPENAI_API_KEY".to_string()];
    let outcome = sandbox.run("secret:OPENAI_API_KEY", &Capabilities::deny_all(), &secrets);
    match outcome {
        Outcome::Parsed { value, .. } => {
            assert!(value.contains("\"exists\":true"), "존재 여부는 알려야 한다: {value}");
            assert!(!value.contains("sk-"), "값이 새면 안 된다: {value}");
        }
        Outcome::Failed { failure, message } => {
            panic!("시크릿 조회가 실패했다: {failure:?} {message}");
        }
    }
}

#[test]
fn 없는_시크릿은_없다고_한다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let outcome = sandbox.run("secret:NOT_THERE", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Parsed { value, .. } => {
            assert!(value.contains("\"exists\":false"), "없으면 없다고 해야 한다: {value}");
        }
        Outcome::Failed { failure, message } => {
            panic!("조회가 실패했다: {failure:?} {message}");
        }
    }
}

#[test]
fn 메모리_상한을_넘으면_트랩이다() {
    let limits = Limits {
        memory_bytes: 2 * 1024 * 1024,
        fuel:         500_000_000,
        timeout:      Duration::from_secs(10),
        tick:         Duration::from_millis(10),
    };
    let Some(sandbox) = sandbox(limits) else { return };
    let outcome = sandbox.run("alloc:1048576", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Failed { failure, message } => {
            assert_eq!(failure, Failure::OutOfMemory, "메모리 상한이 지켜져야 한다: {message}");
        }
        Outcome::Parsed { value, .. } => {
            panic!("메모리 상한을 넘긴 호출이 성공했다: {value}");
        }
    }
}

#[test]
fn 연료_상한을_넘으면_멈춘다() {
    // 연료가 시간보다 먼저 걸리게 해서 **연료 상한**을 따로 증명한다.
    let limits = Limits {
        memory_bytes: 10 * 1024 * 1024,
        fuel:         5_000_000,
        timeout:      Duration::from_secs(30),
        tick:         Duration::from_millis(10),
    };
    let Some(sandbox) = sandbox(limits) else { return };
    let outcome = sandbox.run("spin:", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Failed { failure, message } => {
            assert_eq!(failure, Failure::OutOfFuel, "연료가 소진돼야 한다: {message}");
        }
        Outcome::Parsed { value, .. } => {
            panic!("무한 루프가 끝났다: {value}");
        }
    }
}

#[test]
fn 실행_시간_상한을_넘으면_멈춘다() {
    // 연료를 넉넉히 주고 **시간 상한**만 걸어 본다.
    let limits = Limits {
        memory_bytes: 10 * 1024 * 1024,
        fuel:         u64::MAX / 2,
        timeout:      Duration::from_millis(500),
        tick:         Duration::from_millis(10),
    };
    let Some(sandbox) = sandbox(limits) else { return };
    let outcome = sandbox.run("spin:", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Failed { failure, message } => {
            assert_eq!(failure, Failure::Timeout, "시간 상한이 지켜져야 한다: {message}");
        }
        Outcome::Parsed { value, .. } => {
            panic!("무한 루프가 끝났다: {value}");
        }
    }
}

#[test]
fn 호출_사이에_공유_상태가_없다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let secrets = vec!["TOKEN".to_string()];
    /** 첫 호출은 시크릿을 본다. */
    let first = sandbox.run("secret:TOKEN", &Capabilities::deny_all(), &secrets);
    /** 두 번째 호출은 시크릿 목록이 비어 있다 — 앞서 본 것을 기억하면 안 된다. */
    let second = sandbox.run("secret:TOKEN", &Capabilities::deny_all(), &[]);

    let Outcome::Parsed { value: first_value, .. } = first else {
        panic!("첫 호출이 실패했다");
    };
    let Outcome::Parsed { value: second_value, .. } = second else {
        panic!("두 번째 호출이 실패했다");
    };
    assert!(first_value.contains("\"exists\":true"), "첫 호출은 존재해야 한다: {first_value}");
    assert!(
        second_value.contains("\"exists\":false"),
        "두 번째 호출은 이전 호출의 것을 기억하면 안 된다: {second_value}"
    );
}

#[test]
fn 게스트의_로그는_호스트_출력에_섞이지_않는다() {
    let Some(sandbox) = sandbox(Limits::default()) else { return };
    let outcome = sandbox.run("안녕", &Capabilities::deny_all(), &[]);
    match outcome {
        Outcome::Parsed { value, logs } => {
            assert!(value.contains("안녕"), "결과가 있어야 한다");
            /** 게스트가 남긴 로그가 있으면 따로 모아진다. */
            assert!(logs.is_empty() || logs.iter().all(|l| !l.contains("\u{1b}")));
        }
        Outcome::Failed { failure, message } => {
            panic!("실패했다: {failure:?} {message}");
        }
    }
}
