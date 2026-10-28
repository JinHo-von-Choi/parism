use std::time::{Duration, Instant};
use parism_sandbox::{Capabilities, Limits, Outcome, Sandbox};
fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sandbox-guest.component.wasm");
    let t0 = Instant::now();
    let sandbox = Sandbox::load(std::path::Path::new(path), Limits::default()).unwrap();
    println!("load(컴파일 포함): {:?}", t0.elapsed());
    let t1 = Instant::now();
    for _ in 0..10 { let _ = sandbox.run("x", &Capabilities::deny_all(), &[]); }
    println!("호출 10회: {:?} (평균 {:?})", t1.elapsed(), t1.elapsed()/10);
    let t2 = Instant::now();
    let _ = Sandbox::load(std::path::Path::new(path), Limits::default()).unwrap();
    println!("load 1회: {:?}", t2.elapsed());
}
