//! Test fixture: a metadata provider answering canned records.

use fliks_plugin_sdk::{ExternalId, HttpRequest, HttpResponse, Plugin, host, json_response};
use fliks_plugin_sdk_provider::{
    Lang, MetadataProvider, ProviderError, SearchQuery, UpstreamError, export_provider,
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
            "not-json" => Ok("{".into()),
            "array" => Ok("[]".into()),
            "huge" => {
                let mut s = String::with_capacity((16 << 20) + 16);
                s.push_str(r#"{"title":""#);
                s.extend(std::iter::repeat_n('x', 16 << 20));
                s.push_str(r#""}"#);
                Ok(s)
            }
            "unauthorized" => Err(ProviderError::Unauthorized),
            "unsupported" => Err(ProviderError::Unsupported),
            "limited" => Err(ProviderError::RateLimited(Some(7))),
            "upstream" => Err(ProviderError::Upstream(UpstreamError {
                status: Some(503),
                message: "maintenance".into(),
            })),
            "trap" => panic!("fixture trap"),
            _ => Err(ProviderError::NotFound),
        }
    }
    fn fetch_children(_kind: String, _id: ExternalId, _lang: Lang) -> Result<String, ProviderError> {
        Ok(json!([{ "seasonNumber": 1, "episodes": [] }]).to_string())
    }
    fn find_by(
        source: ExternalId,
        _lang: Lang,
    ) -> Result<Option<(ExternalId, String)>, ProviderError> {
        Ok((source.value == "tt1").then(|| {
            let provider = "tmdb".to_owned();
            (ExternalId { provider, value: "1".into() }, "series".into())
        }))
    }
}

export_provider!(Fixture);
