//! Test fixture: a metadata provider answering canned records.

use fliks_plugin_sdk::Plugin;
use fliks_plugin_sdk_provider::{
    Lang, MetadataProvider, ProviderError, SearchQuery, export_provider,
};
use serde_json::json;

struct Fixture;

impl Plugin for Fixture {}

impl MetadataProvider for Fixture {
    fn search(q: SearchQuery, _lang: Lang) -> Result<String, ProviderError> {
        Ok(json!([{ "title": q.query, "ids": { "org.example.anime:aid": "1" } }]).to_string())
    }
    fn fetch_work(_kind: String, id: String, lang: Lang) -> Result<String, ProviderError> {
        match id.as_str() {
            "1" => Ok(json!({ "title": "Sample", "language": lang.locale }).to_string()),
            _ => Err(ProviderError::NotFound),
        }
    }
}

export_provider!(Fixture);
