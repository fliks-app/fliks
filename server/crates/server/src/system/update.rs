//! The GitHub release check (`docs/spec/system.md` rules 9-11).
use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
}

/// The cached success; memory only.
#[derive(Default)]
pub struct Cache(Mutex<Option<(Instant, UpdateStatus)>>);

#[derive(Deserialize)]
struct Release {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
}

fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn fallback() -> UpdateStatus {
    UpdateStatus {
        current_version: current().into(),
        latest_version: None,
        update_available: false,
        release_url: None,
        release_notes: None,
        published_at: None,
    }
}

/// `v?` stripped, cut at `-` or `+`, each dot part by `parseInt` (a digit prefix); `None` when any part is NaN.
fn parts(v: &str) -> Option<Vec<u64>> {
    let v = v.trim();
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    let core = v.split(['-', '+']).next().unwrap_or_default();
    if core.is_empty() {
        return None;
    }
    core.split('.')
        .map(|p| {
            let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .collect()
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parts(latest), parts(current)) else {
        return false;
    };
    (0..a.len().max(b.len()))
        .map(|i| {
            (
                a.get(i).copied().unwrap_or(0),
                b.get(i).copied().unwrap_or(0),
            )
        })
        .find(|(x, y)| x != y)
        .is_some_and(|(x, y)| x > y)
}

fn disabled() -> bool {
    let v = std::env::var("FLIKS_DISABLE_UPDATE_CHECK").unwrap_or_default();
    matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes")
}

fn repo() -> &'static str {
    static REPO: OnceLock<String> = OnceLock::new();
    REPO.get_or_init(|| {
        std::env::var("FLIKS_GITHUB_REPO").unwrap_or_else(|_| "fliks-app/fliks".into())
    })
}

impl Cache {
    pub async fn check(&self) -> UpdateStatus {
        if disabled() {
            return fallback();
        }
        if let Some((at, s)) = &*self.0.lock_clean()
            && at.elapsed() < TTL
        {
            return s.clone();
        }
        let status = fetch().await.unwrap_or_else(fallback);
        if status.latest_version.is_some() {
            *self.0.lock_clean() = Some((Instant::now(), status.clone()));
        }
        status
    }
}

async fn fetch() -> Option<UpdateStatus> {
    let client = reqwest::Client::builder()
        .user_agent("fliks-server")
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo());
    let res = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .inspect_err(|e| {
            tracing::warn!(
                "GitHub release lookup error: {}",
                e.to_string().split(" for url").next().unwrap_or_default()
            )
        })
        .ok()?;
    if !res.status().is_success() {
        tracing::warn!(
            "GitHub release lookup failed: HTTP {}",
            res.status().as_u16()
        );
        return None;
    }
    let r: Release = res
        .json()
        .await
        .inspect_err(|e| {
            tracing::warn!(
                "GitHub release lookup error: {}",
                e.to_string().split(" for url").next().unwrap_or_default()
            )
        })
        .ok()?;
    if r.draft {
        return None;
    }
    let latest = r.tag_name.or(r.name);
    Some(UpdateStatus {
        current_version: current().into(),
        update_available: latest.as_deref().is_some_and(|l| is_newer(l, current())),
        latest_version: latest,
        release_url: r.html_url,
        release_notes: r.body,
        published_at: r.published_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_vectors() {
        let newer = |a, b| is_newer(a, b);
        assert!(newer("v1.2.4", "1.2.3"));
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("V1.2.4", "1.2.3"));
        assert!(newer("4.5.0.1", "4.5.0"));
        assert!(newer(" 4.6 ", "4.5.9"));
        assert!(!newer("4.5.0-rc.1", "4.5.0"));
        assert!(!newer("4.5", "4.5.0"));
        assert!(!newer("1.2.x", "1.2.0"));
        assert!(!newer("", "1.0.0"));
        assert!(!newer("1.0.0", ""));
        assert!(newer("3rc1.0", "2.9"));
        assert!(!newer("1.2.3", "1.2.3"));
    }
}
