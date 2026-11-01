//! Golden merge vectors (`fixtures/metadata-merge`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{
        field::Field,
        merge::{FieldOrder, merge},
    },
};
use serde_json::{Value, json};

fn provider(v: &Value) -> ExternalProvider {
    ExternalProvider::parse(v.as_str().unwrap()).unwrap()
}

#[test]
fn merge_reproduces_expected() {
    replay("metadata-merge", 12, |i| {
        let records: Vec<_> = i["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    provider(&r["provider"]),
                    r["record"].as_object().unwrap().clone(),
                )
            })
            .collect();
        let kind = MediaKind::parse(i["kind"].as_str().unwrap()).unwrap();
        let first: Vec<_> = i["first"]
            .as_array()
            .unwrap()
            .iter()
            .map(provider)
            .collect();
        let locked: Vec<Field> = i["locked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| Field::parse(f.as_str().unwrap()).unwrap())
            .collect();
        let (merged, provenance) = merge(&records, &FieldOrder::new(kind, &first), &locked);
        let provenance: Vec<_> = provenance
            .into_iter()
            .map(|(f, p)| json!([f.as_str(), p.as_str()]))
            .collect();
        json!({"merged": merged, "provenance": provenance})
    });
}
