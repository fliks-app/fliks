//! Guest SDK for Fliks plugins: `fliks:plugin@2.0.0` bindings, the `Plugin` trait and `export!`.

pub mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "plugin",
        generate_all,
        pub_export_macro: true,
        export_macro_name: "__export_world",
        default_bindings_module: "fliks_plugin_sdk::bindings",
    });
}

pub mod db;
pub mod http;
pub mod log;
pub mod scheduled;
pub mod time;

pub use bindings::fliks::plugin::host;
pub use bindings::fliks::plugin::types::{HealthReport, HttpRequest, HttpResponse, ManifestCheck};
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

#[macro_export]
macro_rules! export {
    ($t:ty) => {
        struct __FliksGuest;
        impl $crate::bindings::exports::fliks::plugin::guest::Guest for __FliksGuest {
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
