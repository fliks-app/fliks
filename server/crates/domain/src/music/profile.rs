//! The metadata profile of a library: which release groups and which releases of a provider it wants.
use super::provider::{PRIMARY_TYPES, SECONDARY_TYPES, STATUSES};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A release with no status counts as this one.
pub const UNKNOWN_STATUS: &str = "unknown";

/// A release group is wanted when its primary type is listed and every secondary type it carries is
/// listed too (none: a studio release); a release is wanted when its status is listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataProfile {
    pub primary_types: Vec<String>,
    pub secondary_types: Vec<String>,
    pub statuses: Vec<String>,
}

impl Default for MetadataProfile {
    fn default() -> Self {
        Self {
            primary_types: vec!["album".into(), "ep".into()],
            secondary_types: vec![],
            statuses: vec!["official".into()],
        }
    }
}

fn list(v: &Value, key: &str, allowed: &[&str], extra: &[&str]) -> Result<Vec<String>, String> {
    let items = v
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("metadataProfile.{key} must be an array"))?;
    let mut out: Vec<String> = vec![];
    for i in items {
        let s = i
            .as_str()
            .map(str::to_lowercase)
            .filter(|s| allowed.iter().chain(extra).any(|a| a == s));
        let Some(s) = s else {
            return Err(format!(
                "metadataProfile.{key} must hold only: {}",
                allowed
                    .iter()
                    .chain(extra)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        };
        if !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

impl MetadataProfile {
    /// The profile of a request body or a stored column; a primary type is required.
    pub fn parse(v: &Value) -> Result<Self, String> {
        if !v.is_object() {
            return Err("metadataProfile must be an object".into());
        }
        let primary_types = list(v, "primaryTypes", &PRIMARY_TYPES, &[])?;
        if primary_types.is_empty() {
            return Err("metadataProfile.primaryTypes must not be empty".into());
        }
        Ok(Self {
            primary_types,
            secondary_types: list(v, "secondaryTypes", &SECONDARY_TYPES, &[])?,
            statuses: list(v, "statuses", &STATUSES, &[UNKNOWN_STATUS])?,
        })
    }

    pub fn allows_group(&self, primary: Option<&str>, secondary: &[String]) -> bool {
        self.primary_types
            .iter()
            .any(|p| p == primary.unwrap_or("other"))
            && secondary.iter().all(|s| self.secondary_types.contains(s))
    }

    pub fn allows_status(&self, status: Option<&str>) -> bool {
        let s = status.unwrap_or(UNKNOWN_STATUS);
        self.statuses.iter().any(|x| x == s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_default_wants_studio_albums_and_eps_of_official_releases() {
        let p = MetadataProfile::default();
        assert!(p.allows_group(Some("album"), &[]));
        assert!(p.allows_group(Some("ep"), &[]));
        assert!(!p.allows_group(Some("single"), &[]));
        assert!(!p.allows_group(Some("album"), &["live".into()]));
        assert!(p.allows_status(Some("official")));
        assert!(!p.allows_status(None));
    }

    #[test]
    fn an_unknown_status_is_selectable() {
        let p = MetadataProfile::parse(&json!({
            "primaryTypes": ["album"], "secondaryTypes": ["live", "live"], "statuses": ["official", "unknown"]
        }))
        .unwrap();
        assert_eq!(p.secondary_types, ["live"]);
        assert!(p.allows_status(None) && p.allows_group(Some("album"), &["live".into()]));
    }

    #[test]
    fn a_bad_profile_is_refused() {
        for v in [
            json!([]),
            json!({"primaryTypes": [], "secondaryTypes": [], "statuses": []}),
            json!({"primaryTypes": ["opera"], "secondaryTypes": [], "statuses": []}),
            json!({"primaryTypes": ["album"], "secondaryTypes": [], "statuses": ["fake"]}),
            json!({"primaryTypes": ["album"], "statuses": []}),
        ] {
            assert!(MetadataProfile::parse(&v).is_err(), "{v}");
        }
    }
}
