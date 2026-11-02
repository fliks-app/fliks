//! Test fixture: a metadata provider answering canned records.

use fliks_plugin_sdk::{ExternalId, HttpRequest, HttpResponse, Plugin, host, json_response};
use fliks_plugin_sdk_provider::{
    Lang, MetadataProvider, ProviderError, SearchQuery, export_provider,
};
use serde_json::json;

struct Fixture;

impl Plugin for Fixture {
    /// Answers the plugin's own config keys, to test what `config-get` lets a provider read.
    fn http(_req: HttpRequest) -> Result<HttpResponse, String> {
        let body = match host::config_get(None) {
            Ok(v) => json!(v.into_iter().collect::<std::collections::BTreeMap<_, _>>()),
            Err(e) => json!({ "error": e.code }),
        };
        Ok(json_response(200, body.to_string()))
    }
}

impl MetadataProvider for Fixture {
    fn search(q: SearchQuery, _lang: Lang) -> Result<String, ProviderError> {
        Ok(json!([{ "title": q.query, "ids": { "org.example.anime:aid": "1" } }]).to_string())
    }
    fn fetch_work(_kind: String, id: ExternalId, lang: Lang) -> Result<String, ProviderError> {
        match id.value.as_str() {
            "1" => Ok(json!({ "title": "Sample", "language": lang.locale }).to_string()),
            _ => Err(ProviderError::NotFound),
        }
    }
}

export_provider!(Fixture);
