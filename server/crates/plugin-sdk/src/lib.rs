//! Guest SDK for Fliks plugins: `fliks:plugin@3.0.0` bindings, the `Plugin` trait and `export!`.

pub mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "plugin",
        generate_all,
        pub_export_macro: true,
        export_macro_name: "__export_world",
        default_bindings_module: "fliks_plugin_sdk::bindings",
        // The `wasip2` types, so SDK pollables and requests run on the `wstd` reactor.
        with: {
            "wasi:cli/environment@0.2.12": wasip2::cli::environment,
            "wasi:cli/exit@0.2.12": wasip2::cli::exit,
            "wasi:cli/stdin@0.2.12": wasip2::cli::stdin,
            "wasi:cli/stdout@0.2.12": wasip2::cli::stdout,
            "wasi:cli/stderr@0.2.12": wasip2::cli::stderr,
            "wasi:cli/terminal-input@0.2.12": wasip2::cli::terminal_input,
            "wasi:cli/terminal-output@0.2.12": wasip2::cli::terminal_output,
            "wasi:cli/terminal-stdin@0.2.12": wasip2::cli::terminal_stdin,
            "wasi:cli/terminal-stdout@0.2.12": wasip2::cli::terminal_stdout,
            "wasi:cli/terminal-stderr@0.2.12": wasip2::cli::terminal_stderr,
            "wasi:clocks/monotonic-clock@0.2.12": wasip2::clocks::monotonic_clock,
            "wasi:clocks/wall-clock@0.2.12": wasip2::clocks::wall_clock,
            "wasi:filesystem/types@0.2.12": wasip2::filesystem::types,
            "wasi:filesystem/preopens@0.2.12": wasip2::filesystem::preopens,
            "wasi:http/types@0.2.12": wasip2::http::types,
            "wasi:http/outgoing-handler@0.2.12": wasip2::http::outgoing_handler,
            "wasi:io/error@0.2.12": wasip2::io::error,
            "wasi:io/poll@0.2.12": wasip2::io::poll,
            "wasi:io/streams@0.2.12": wasip2::io::streams,
            "wasi:random/insecure-seed@0.2.12": wasip2::random::insecure_seed,
            "wasi:random/insecure@0.2.12": wasip2::random::insecure,
            "wasi:random/random@0.2.12": wasip2::random::random,
            "wasi:sockets/network@0.2.12": wasip2::sockets::network,
            "wasi:sockets/instance-network@0.2.12": wasip2::sockets::instance_network,
            "wasi:sockets/ip-name-lookup@0.2.12": wasip2::sockets::ip_name_lookup,
            "wasi:sockets/tcp@0.2.12": wasip2::sockets::tcp,
            "wasi:sockets/tcp-create-socket@0.2.12": wasip2::sockets::tcp_create_socket,
            "wasi:sockets/udp@0.2.12": wasip2::sockets::udp,
            "wasi:sockets/udp-create-socket@0.2.12": wasip2::sockets::udp_create_socket,
        },
    });
    pub use wasip2 as wasi;
}

#[cfg(all(feature = "build", not(target_arch = "wasm32")))]
pub mod build;
pub mod db;
#[cfg(all(feature = "harness", not(target_arch = "wasm32")))]
pub mod harness;
pub mod http;
pub mod log;
pub mod router;
pub mod rt;
pub mod scheduled;
pub mod time;

pub use bindings::fliks::plugin::host;
pub use bindings::fliks::plugin::types::{
    ExternalId, HealthReport, HttpRequest, HttpResponse, ManifestCheck,
};
pub use serde_json;

/// One method per guest export; `hello` belongs to the SDK (`export!`).
pub trait Plugin {
    fn health() -> HealthReport {
        HealthReport {
            ok: true,
            detail: None,
        }
    }
    fn start() -> Result<(), String> {
        Ok(())
    }
    fn job(name: String, _job_id: String, _args: Option<String>) -> Result<(), String> {
        Err(format!("unknown job {name}"))
    }
    fn scheduled(_key: String, _payload: String, _attempt: u32) -> Result<(), String> {
        Ok(())
    }
    fn http(_req: HttpRequest) -> Result<HttpResponse, String> {
        Ok(json_response(404, r#"{"error":"not found"}"#))
    }
    fn event(_name: String, _payload: String) {}
    fn config_changed(_keys: Vec<String>) {}
    fn shutdown() {}
}

pub fn json_response(status: u16, body: impl Into<Vec<u8>>) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: body.into(),
    }
}

/// `manifest-check` from the crate's `plugin.template.json` (id, pluginApi) and its version.
pub fn manifest_check(template: &str, version: &str) -> Result<ManifestCheck, String> {
    let v: serde_json::Value = serde_json::from_str(template).map_err(|e| e.to_string())?;
    Ok(ManifestCheck {
        id: v["id"].as_str().ok_or("template has no id")?.to_owned(),
        version: version.to_owned(),
        plugin_api: v["pluginApi"].as_u64().ok_or("template has no pluginApi")? as u32,
    })
}

/// The guest methods both export macros implement; `hello` answers from the template.
#[doc(hidden)]
#[macro_export]
macro_rules! __guest_fns {
    ($t:ty) => {
        fn hello(
            _core: String,
            _config: Vec<(String, String)>,
        ) -> Result<$crate::ManifestCheck, String> {
            $crate::manifest_check(
                include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/plugin.template.json")),
                env!("CARGO_PKG_VERSION"),
            )
        }
        fn health() -> $crate::HealthReport {
            <$t as $crate::Plugin>::health()
        }
        fn start() -> Result<(), String> {
            <$t as $crate::Plugin>::start()
        }
        fn job(name: String, id: String, args: Option<String>) -> Result<(), String> {
            <$t as $crate::Plugin>::job(name, id, args)
        }
        fn scheduled(key: String, payload: String, attempt: u32) -> Result<(), String> {
            <$t as $crate::Plugin>::scheduled(key, payload, attempt)
        }
        fn http(req: $crate::HttpRequest) -> Result<$crate::HttpResponse, String> {
            <$t as $crate::Plugin>::http(req)
        }
        fn event(name: String, payload: String) {
            <$t as $crate::Plugin>::event(name, payload)
        }
        fn config_changed(keys: Vec<String>) {
            <$t as $crate::Plugin>::config_changed(keys)
        }
        fn shutdown() {
            <$t as $crate::Plugin>::shutdown()
        }
    };
}

#[macro_export]
macro_rules! export {
    ($t:ty) => {
        struct __FliksGuest;
        impl $crate::bindings::exports::fliks::plugin::guest::Guest for __FliksGuest {
            $crate::__guest_fns!($t);
        }
        // Native builds (unit tests, clippy) cannot link the component export names.
        #[cfg(target_arch = "wasm32")]
        $crate::bindings::__export_world!(__FliksGuest with_types_in $crate::bindings);
        // Natively the exports stay reachable, so the plugin's code is not dead.
        #[cfg(not(target_arch = "wasm32"))]
        const _: () = {
            use $crate::bindings::exports::fliks::plugin::guest::Guest as G;
            let _ = (
                <__FliksGuest as G>::hello,
                <__FliksGuest as G>::health,
                <__FliksGuest as G>::start,
                <__FliksGuest as G>::job,
                <__FliksGuest as G>::scheduled,
                <__FliksGuest as G>::http,
                <__FliksGuest as G>::event,
                <__FliksGuest as G>::config_changed,
                <__FliksGuest as G>::shutdown,
            );
        };
    };
}
