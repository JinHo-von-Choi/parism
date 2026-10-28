/**
 * 외부 파서 샌드박스 프로세스.
 *
 * ## 프로토콜이 파일인 이유
 *
 * parism 의 레지스트리 `parse` API 는 **동기**다. 외부 팩을 부를 때마다 비동기로 돌릴 수 없다.
 * 그런데 샌드박스 호출은 프로세스 경계를 넘어야 한다 — 그러면 비동기가 된다.
 *
 * 동기 함수가 비동기 프로세스를 기다리는 방법은 두 가지다.
 *
 * 1. 표준 출력을 `fs.readSync` 로 읽는다 — Windows 의 파이프에서는 동작하지 않는다.
 * 2. **응답을 파일로 받는다** — 모든 플랫폼에서 동작하고, 디버깅하기 쉽다.
 *
 * 그래서 2번이다. 요청은 JSON 파일, 응답도 JSON 파일이다.
 *
 * ```
 * 표준 입력 ← 요청 파일 경로(한 줄)
 * 요청 파일 → {"component": "...", "raw": "...", ...}
 * 응답 파일 ← {"ok": true, "value": "..."}
 * ```
 *
 * 응답 파일은 `<요청 파일>.response` 다. 요청을 보낸 쪽은 **그 파일이 생길 때까지** 기다린다.
 *
 * ## 왜 프로세스가 지속되는가
 *
 * 컴포넌트 컴파일이 57ms(실측), 호출 하나가 457µs(실측)다.
 * 호출마다 프로세스를 띄우면 **호출이 지배한다.** 그래서 프로세스는 오래 산다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

use std::fs;
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::time::Duration;

use parism_sandbox::{Capabilities, Limits, Outcome, Sandbox};

fn main() {
    let stdin = io::stdin();
    let mut handle = stdin.lock();
    let mut line   = String::new();

    loop {
        line.clear();
        match handle.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err) => {
                eprintln!("[parism-sandbox] 표준 입력을 읽지 못했다: {err}");
                break;
            }
        }
        let request_path = line.trim();
        if request_path.is_empty() { continue; }

        let response_path = format!("{request_path}.response");
        let response      = handle_request(&request_path);
        if let Err(err) = fs::write(&response_path, response) {
            eprintln!("[parism-sandbox] 응답을 쓰지 못했다: {err}");
        }
    }
}

/// 요청 파일 하나를 처리해 응답 JSON 문자열을 돌려준다.
fn handle_request(request_path: &str) -> String {
    let raw = match fs::read_to_string(request_path) {
        Ok(text) => text,
        Err(err) => return failure_json("unavailable", &format!("요청을 읽지 못했다: {err}")),
    };
    let request: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => return failure_json("unavailable", &format!("요청 JSON 이 올바르지 않다: {err}")),
    };

    let component = request.get("component").and_then(|v| v.as_str()).unwrap_or_default();
    if component.is_empty() {
        return failure_json("unavailable", "요청에 component 가 없다");
    }
    let text = request.get("raw").and_then(|v| v.as_str()).unwrap_or_default();

    let mut capabilities = Capabilities::deny_all();
    if let Some(entries) = request.get("fs_read").and_then(|v| v.as_array()) {
        for entry in entries {
            let empty: Vec<serde_json::Value> = Vec::new();
            let pair = entry.as_array().unwrap_or(&empty);
            let host  = pair.first().and_then(|v| v.as_str()).unwrap_or_default();
            let guest = pair.get(1).and_then(|v| v.as_str()).unwrap_or_default();
            if !host.is_empty() && !guest.is_empty() {
                capabilities.fs_read.push((host.to_string(), guest.to_string()));
            }
        }
    }
    if let Some(entries) = request.get("env").and_then(|v| v.as_array()) {
        for entry in entries {
            let empty: Vec<serde_json::Value> = Vec::new();
            let pair = entry.as_array().unwrap_or(&empty);
            let key   = pair.first().and_then(|v| v.as_str()).unwrap_or_default();
            let value = pair.get(1).and_then(|v| v.as_str()).unwrap_or_default();
            if !key.is_empty() {
                capabilities.env.push((key.to_string(), value.to_string()));
            }
        }
    }
    let secrets: Vec<String> = request
        .get("secrets")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default();

    let mut limits = Limits::default();
    if let Some(ms) = request.get("timeout_ms").and_then(|v| v.as_u64()) {
        limits.timeout = Duration::from_millis(ms);
    }
    if let Some(bytes) = request.get("memory_bytes").and_then(|v| v.as_u64()) {
        limits.memory_bytes = bytes as usize;
    }
    if let Some(fuel) = request.get("fuel").and_then(|v| v.as_u64()) {
        limits.fuel = fuel;
    }

    let sandbox = match Sandbox::load(&PathBuf::from(component), limits) {
        Ok(sandbox) => sandbox,
        Err(message) => return failure_json("unavailable", &message),
    };

    match sandbox.run(text, &capabilities, &secrets) {
        Outcome::Parsed { value, logs } => {
            serde_json::json!({ "ok": true, "value": value, "logs": logs }).to_string()
        }
        Outcome::Failed { failure, message } => {
            serde_json::json!({
                "ok": false,
                "failure": failure.as_str(),
                "message": message,
            }).to_string()
        }
    }
}

/// 실패 응답 JSON.
fn failure_json(failure: &str, message: &str) -> String {
    serde_json::json!({ "ok": false, "failure": failure, "message": message }).to_string()
}
