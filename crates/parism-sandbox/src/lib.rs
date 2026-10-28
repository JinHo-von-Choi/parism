/**
 * 외부 파서 샌드박스 — Wasmtime 기반 capability 격리.
 *
 * ## 왜 프로세스가 아니라 "샌드박스"인가
 *
 * 외부 ParserPack 은 사람이 가져온 코드다. 워커 격리는 **결함 격리**였다 —
 * 크래시·무한루프가 서버를 멈추지 않게 한다. 그러나 워커는 **같은 프로세스의 권한**을 그대로 가진다.
 * 파일을 읽고 쓰고, 네트워크에 나가고, 프로그램을 실행한다.
 *
 * 이 모듈은 그 경계를 **실제로 좁힌다.** 게스트는 Wasm 컴포넌트이고,
 * 컴포넌트는 **호스트가 허용한 것만** 요구할 수 있다.
 *
 * ## 주장은 좁다
 *
 * 이 샌드박스가 보장하는 것은 세 가지다.
 *
 * 1. **메모리** — 10MiB 를 넘으면 트랩한다.
 * 2. **실행 시간** — epoch 타임아웃(기본 60초) 이 지나면 멈춘다.
 * 3. **접근 권한** — capability 맵이 비어 있으면 파일·환경 변수·네트워크를 **전부 거부한다.**
 *
 * 이 샌드박스가 보장하지 **않는** 것은 메모리 안전 언어의 한계다.
 * 게스트 안의 **로직 취약점**은 그대로 남는다 — 그건 샌드박스의 일이 아니다.
 * 그리고 이것은 **OS 샌드박스가 아니다** — 커널 격리(seccomp·AppArmor)와는 다르다.
 *
 * ## 호출마다 새 상태를 쓴다
 *
 * 호출마다 **새 `Store`·새 `Linker`·새 인스턴스**를 만든다.
 * 게스트가 이전 호출에서 남긴 상태를 다음 호출이 볼 수 없다 — 공유 상태가 없다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

/// 호스트가 게스트에 제공하는 인터페이스의 정규 이름.
pub const HOST_INTERFACE: &str = "parism:parser/host@0.1.0";

/// 게스트가 노출하는 인터페이스의 정규 이름.
pub const PARSER_INTERFACE: &str = "parism:parser/parser@0.1.0";

/// 샌드박스 상한.
#[derive(Clone, Debug)]
pub struct Limits {
    /// 게스트 선형 메모리 상한(바이트). 넘으면 트랩한다.
    pub memory_bytes: usize,
    /// 연료(fuel) 예산. 넘으면 트랩한다.
    pub fuel:         u64,
    /// 실행 시간 상한.
    pub timeout:      Duration,
    /// epoch 틱 간격. 이 간격마다 epoch 를 1 올린다.
    pub tick:         Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 10 * 1024 * 1024,
            fuel:         500_000_000,
            timeout:      Duration::from_secs(60),
            tick:         Duration::from_millis(10),
        }
    }
}

/// 게스트에 열어 주는 capability.
#[derive(Clone, Debug, Default)]
pub struct Capabilities {
    /// 읽기만 허용할 파일 시스템 경로. (호스트 경로, 게스트가 보는 경로)
    pub fs_read: Vec<(String, String)>,
    /// 노출할 환경 변수. **이름과 값이 그대로 들어간다** — 주의해서 쓴다.
    pub env:     Vec<(String, String)>,
}

impl Capabilities {
    /// 아무것도 열지 않는다. **fail-closed** 다.
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// 이 capability 맵이 아무것도 열지 않았는가.
    pub fn is_empty(&self) -> bool {
        self.fs_read.is_empty() && self.env.is_empty()
    }
}

/// 실패 종류. 원인이 다르면 무엇을 해야 하는지도 다르다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// 게스트가 오류를 냈다. (파서가 지원하지 않는 형식 등)
    Guest,
    /// 실행 시간 상한을 넘었다.
    Timeout,
    /// 연료가 소진됐다.
    OutOfFuel,
    /// 메모리 상한을 넘었다.
    OutOfMemory,
    /// 게스트가 죽었다. (트랩·abort)
    Trapped,
    /// 컴포넌트를 읽거나 검증하지 못했다.
    Unavailable,
}

impl Failure {
    /// 사람이 읽을 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Guest        => "guest_error",
            Failure::Timeout      => "timeout",
            Failure::OutOfFuel    => "out_of_fuel",
            Failure::OutOfMemory  => "out_of_memory",
            Failure::Trapped      => "trapped",
            Failure::Unavailable  => "unavailable",
        }
    }
}

/// 실행 결과.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// 게스트가 결과를 돌려주었다.
    Parsed {
        value: String,
        /// 게스트가 `log` 로 남긴 것.
        logs:  Vec<String>,
    },
    /// 실패했다.
    Failed {
        failure: Failure,
        message: String,
    },
}

/// 호스트 상태. 호출마다 새로 만든다.
struct HostState {
    table:   ResourceTable,
    wasi:    WasiCtx,
    logs:    Vec<String>,
    /// 시크릿 **이름** 목록. 값은 이 안에 없다 — 존재 여부만 물어본다.
    secrets: Vec<String>,
    limits:  StoreLimits,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

/// epoch 를 올리는 스레드.
struct EpochTicker {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl EpochTicker {
    fn start(engine: Engine, tick: Duration) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(tick);
                engine.increment_epoch();
            }
        });
        Self { stop, handle: Some(handle) }
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// 외부 파서 샌드박스.
pub struct Sandbox {
    engine:    Engine,
    component: Component,
    limits:    Limits,
    /**
     * epoch 를 올리는 스레드.
     *
     * **읽지 않는다.** 하지만 없으면 스레드가 바로 죽고 — 그러면 타임아웃이 영영 오지 않는다.
     * 이 필드가 샌드박스를 붙잡고 있는 것이 목시다.
     */
    #[allow(dead_code)]
    ticker:    EpochTicker,
}

impl Sandbox {
    /// 컴포넌트 파일을 읽어 샌드박스를 만든다.
    pub fn load(path: &std::path::Path, limits: Limits) -> Result<Self, String> {
        let mut config = Config::new();
        // 역추적 공격에 의한 실행 시간 폭주를 막는다.
        config.epoch_interruption(true);
        // 연료로 실행량을 제한한다. 무한루프가 연료를 다 쓰면 멈춘다.
        config.consume_fuel(true);
        // 스레드는 허용하지 않는다. — 게스트가 스레드를 만들면 그건 경계를 넓히는 일이다.
        config.wasm_threads(false);
        // 호스트 함수는 우리 것만 쓴다.
        config.wasm_component_model(true);

        let engine = Engine::new(&config).map_err(|e| format!("엔진 생성 실패: {e}"))?;
        let bytes = std::fs::read(path).map_err(|e| format!("컴포넌트를 읽지 못했다: {e}"))?;
        let component = Component::from_binary(&engine, &bytes)
            .map_err(|e| format!("컴포넌트가 올바르지 않다: {e}"))?;

        let ticker = EpochTicker::start(engine.clone(), limits.tick);
        Ok(Self { engine, component, limits, ticker })
    }

    /// 게스트를 한 번 호출한다.
    ///
    /// 호출마다 **새 Store·새 Linker·새 인스턴스**를 만든다.
    pub fn run(
        &self,
        raw:         &str,
        capabilities: &Capabilities,
        secrets:     &[String],
    ) -> Outcome {
        let mut store = Store::new(&self.engine, HostState {
            table:   ResourceTable::new(),
            wasi:    self.build_wasi(capabilities),
            logs:    Vec::new(),
            secrets: secrets.to_vec(),
            limits:  StoreLimitsBuilder::new()
                .memory_size(self.limits.memory_bytes)
                // 어댑터가 인스턴스를 하나 더 만든다. 1로 잡으면 컴포넌트가 아예 뜨지 않는다.
                .instances(10)
                .tables(10)
                .memories(4)
                .build(),
        });

        // 연료 예산.
        if let Err(e) = store.set_fuel(self.limits.fuel) {
            return Outcome::Failed { failure: Failure::Unavailable, message: format!("연료를 설정하지 못했다: {e}") };
        }
        // 메모리 상한.
        store.limiter(|state| &mut state.limits);
        // epoch 마감. 틱 수로 바꾼다.
        let ticks = self.limits.timeout.as_millis().div_ceil(self.limits.tick.as_millis().max(1)) as u64;
        store.set_epoch_deadline(ticks);

        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        if let Err(e) = wasmtime_wasi::p2::add_to_linker_sync(&mut linker) {
            return Outcome::Failed { failure: Failure::Unavailable, message: format!("WASI 를 붙이지 못했다: {e}") };
        }
        if let Err(e) = self.add_host_functions(&mut linker) {
            return Outcome::Failed { failure: Failure::Unavailable, message: format!("호스트 함수를 붙이지 못했다: {e}") };
        }

        let instance = match linker.instantiate(&mut store, &self.component) {
            Ok(instance) => instance,
            Err(e) => return self.classify(e),
        };

        let parse = match self.get_parse(&mut store, &instance) {
            Ok(func) => func,
            Err(e) => return self.classify(e),
        };

        match parse.call(&mut store, (raw.to_string(),)) {
            Ok((Ok(value),)) => {
                let logs = std::mem::take(&mut store.data_mut().logs);
                Outcome::Parsed { value, logs }
            }
            Ok((Err(message),)) => Outcome::Failed { failure: Failure::Guest, message },
            Err(e) => self.classify(e),
        }
    }

    /// 게스트가 노출한 `parse` 함수를 찾는다.
    ///
    /// 인터페이스 export 는 **两步**으로 찾아야 한다.
    /// 먼저 인터페이스 인스턴스 인덱스를 얻고, 그 안에서 함수 이름을 찾는다.
    fn get_parse(
        &self,
        store:   &mut Store<HostState>,
        instance: &wasmtime::component::Instance,
    ) -> Result<wasmtime::component::TypedFunc<(String,), (Result<String, String>,)>, wasmtime::Error> {
        let interface = self
            .component
            .get_export_index(None, PARSER_INTERFACE)
            .ok_or_else(|| wasmtime::Error::msg(format!("{PARSER_INTERFACE} 인터페이스가 없다")))?;
        let func_index = instance
            .get_export_index(&mut *store, Some(&interface), "parse")
            .ok_or_else(|| wasmtime::Error::msg("parse 함수가 없다"))?;
        instance.get_typed_func::<(String,), (Result<String, String>,)>(store, func_index)
    }

    /// 호스트가 게스트에 제공하는 함수 두 개.
    fn add_host_functions(&self, linker: &mut Linker<HostState>) -> Result<(), wasmtime::Error> {
        let mut instance = linker.instance(HOST_INTERFACE)?;
        instance.func_wrap(
            "log",
            |mut state: wasmtime::StoreContextMut<HostState>, (message,): (String,)| -> Result<(), wasmtime::Error> {
                state.data_mut().logs.push(message);
                Ok(())
            },
        )?;
        instance.func_wrap(
            "secret-exists",
            |state: wasmtime::StoreContextMut<HostState>, (name,): (String,)| -> Result<(bool,), wasmtime::Error> {
                // 값은 주지 않는다. **존재 여부만** 알려 준다.
                Ok((state.data().secrets.iter().any(|known| known == &name),))
            },
        )?;
        Ok(())
    }

    /// capability 맵대로 WASI 를 만든다.
    ///
    /// **맵이 비어 있으면 아무것도 열지 않는다.** 환경 변수도, preopen 도, 네트워크도 없다.
    fn build_wasi(&self, capabilities: &Capabilities) -> WasiCtx {
        let mut builder = WasiCtxBuilder::new();
        // 표준 출력은 캡처한다 — 게스트의 출력은 호스트 표준 출력에 섞이면 안 된다.
        builder.stdout(wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(1024 * 1024));
        builder.stderr(wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(1024 * 1024));
        // 네트워크는 열지 않는다.
        builder.allow_tcp(false);
        builder.allow_udp(false);
        builder.allow_ip_name_lookup(false);

        for (key, value) in &capabilities.env {
            builder.env(key, value);
        }
        for (host_path, guest_path) in &capabilities.fs_read {
            // 실패하면 그 capability 하나를 건너뛴다 — 나머지는 계속된다.
            let _ = builder.preopened_dir(
                host_path,
                guest_path,
                wasmtime_wasi::FsPerms::ReadOnly,
            );
        }
        builder.build()
    }

    /// 실패를 분류한다. 원인이 다르면 무엇을 해야 하는지도 다르다.
    fn classify(&self, err: wasmtime::Error) -> Outcome {
        // `to_string()` 은 최상위 메시지만 준다 — "Caused by" 가 잘린다.
        // 트랩의 진짜 이유는 거기 있다. **전체** 를 본다.
        let message = format!("{err:?}");
        let text = message.to_lowercase();
        if text.contains("fuel") {
            return Outcome::Failed { failure: Failure::OutOfFuel, message };
        }
        if text.contains("epoch deadline exceeded") || text.contains("interrupt") {
            return Outcome::Failed { failure: Failure::Timeout, message };
        }
        // 메모리 상한을 넘은 흔적은 두 가지다.
        // 1. Wasmtime 이 메모리 확장을 거절한다 — "memory limits" 계열.
        // 2. 게스트의 할당자가 실패한 뒤 abort 한다 — "rust_oom"·"handle_alloc_error".
        //    (실측: 두 번째가 먼저 보인다.)
        if text.contains("memory minimum size")
            || text.contains("memory limits")
            || text.contains("exceeds memory limits")
            || text.contains("out of memory")
            || text.contains("rust_oom")
            || text.contains("handle_alloc_error")
            || text.contains("alloc_error")
        {
            return Outcome::Failed { failure: Failure::OutOfMemory, message };
        }
        Outcome::Failed { failure: Failure::Trapped, message }
    }
}
