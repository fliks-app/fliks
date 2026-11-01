//! Provider plugins: the `provider` world, which adds `metadata-provider` to the `plugin` world.
//! Its imports are those of `fliks_plugin_sdk::bindings`; only the new exports are generated here.

pub mod bindings {
    wit_bindgen::generate!({
        path: "../wit",
        world: "provider",
        generate_all,
        pub_export_macro: true,
        export_macro_name: "__export_provider_world",
        default_bindings_module: "fliks_plugin_sdk_provider::bindings",
        with: {
            "fliks:plugin/types@3.0.0": fliks_plugin_sdk::bindings::fliks::plugin::types,
            "fliks:plugin/host@3.0.0": fliks_plugin_sdk::bindings::fliks::plugin::host,
            "fliks:plugin/db@3.0.0": fliks_plugin_sdk::bindings::fliks::plugin::db,
            "fliks:plugin/log@3.0.0": fliks_plugin_sdk::bindings::fliks::plugin::log,
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
}

pub use bindings::exports::fliks::plugin::metadata_provider::{Lang, ProviderError, SearchQuery};
#[doc(hidden)]
pub use fliks_plugin_sdk as sdk;

/// The `metadata-provider` export, one method per function. A record is a JSON document in the
/// shape of the metadata specs; the host only calls what the manifest's `provider.kinds` declares.
pub trait MetadataProvider {
    fn search(_q: SearchQuery, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn fetch_work(_kind: String, _id: String, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn fetch_children(_kind: String, _id: String, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn child_stubs(_kind: String, _id: String, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    /// The id and kind this provider knows the work of `source` by.
    fn find_by(
        _source: fliks_plugin_sdk::ExternalId,
        _lang: Lang,
    ) -> Result<Option<(String, String)>, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn fetch_edition(
        _edition: fliks_plugin_sdk::ExternalId,
        _lang: Lang,
    ) -> Result<Option<String>, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn fetch_chapters(_asin: String, _lang: Lang) -> Result<Option<String>, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn fetch_person(_id: String, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn person_credits(_id: String, _lang: Lang) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
    fn list(
        _kind: String,
        _name: String,
        _params: Vec<(String, String)>,
        _lang: Lang,
    ) -> Result<String, ProviderError> {
        Err(ProviderError::Unsupported)
    }
}

/// Exports a type that is both a [`Plugin`](fliks_plugin_sdk::Plugin) and a [`MetadataProvider`].
#[macro_export]
macro_rules! export_provider {
    ($t:ty) => {
        struct __FliksProvider;
        impl $crate::bindings::exports::fliks::plugin::guest::Guest for __FliksProvider {
            $crate::sdk::__guest_fns!($t);
        }
        impl $crate::bindings::exports::fliks::plugin::metadata_provider::Guest
            for __FliksProvider
        {
            fn search(
                q: $crate::SearchQuery,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::search(q, lang)
            }
            fn fetch_work(
                kind: String,
                id: String,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::fetch_work(kind, id, lang)
            }
            fn fetch_children(
                kind: String,
                id: String,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::fetch_children(kind, id, lang)
            }
            fn child_stubs(
                kind: String,
                id: String,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::child_stubs(kind, id, lang)
            }
            fn find_by(
                source: $crate::sdk::ExternalId,
                lang: $crate::Lang,
            ) -> Result<Option<(String, String)>, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::find_by(source, lang)
            }
            fn fetch_edition(
                edition: $crate::sdk::ExternalId,
                lang: $crate::Lang,
            ) -> Result<Option<String>, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::fetch_edition(edition, lang)
            }
            fn fetch_chapters(
                asin: String,
                lang: $crate::Lang,
            ) -> Result<Option<String>, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::fetch_chapters(asin, lang)
            }
            fn fetch_person(
                id: String,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::fetch_person(id, lang)
            }
            fn person_credits(
                id: String,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::person_credits(id, lang)
            }
            fn list(
                kind: String,
                name: String,
                params: Vec<(String, String)>,
                lang: $crate::Lang,
            ) -> Result<String, $crate::ProviderError> {
                <$t as $crate::MetadataProvider>::list(kind, name, params, lang)
            }
        }
        // Native builds (unit tests, clippy) cannot link the component export names.
        #[cfg(target_arch = "wasm32")]
        $crate::bindings::__export_provider_world!(
            __FliksProvider with_types_in $crate::bindings
        );
        // Natively the exports stay reachable, so the plugin's code is not dead.
        #[cfg(not(target_arch = "wasm32"))]
        const _: () = {
            use $crate::bindings::exports::fliks::plugin::guest::Guest as G;
            use $crate::bindings::exports::fliks::plugin::metadata_provider::Guest as P;
            let _ = (
                <__FliksProvider as G>::hello,
                <__FliksProvider as G>::health,
                <__FliksProvider as G>::start,
                <__FliksProvider as G>::job,
                <__FliksProvider as G>::scheduled,
                <__FliksProvider as G>::http,
                <__FliksProvider as G>::event,
                <__FliksProvider as G>::config_changed,
                <__FliksProvider as G>::shutdown,
                <__FliksProvider as P>::search,
                <__FliksProvider as P>::fetch_work,
                <__FliksProvider as P>::fetch_children,
                <__FliksProvider as P>::child_stubs,
                <__FliksProvider as P>::find_by,
                <__FliksProvider as P>::fetch_edition,
                <__FliksProvider as P>::fetch_chapters,
                <__FliksProvider as P>::fetch_person,
                <__FliksProvider as P>::person_credits,
                <__FliksProvider as P>::list,
            );
        };
    };
}
