//! Which process supervisor will restart us (`docs/spec/system.md` rule 6).
use std::path::Path;

/// First match wins; `env` and `dockerenv` are injected so every combination is testable.
pub fn detect(env: impl Fn(&str) -> Option<String>, dockerenv: bool) -> Option<&'static str> {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    if set("FLIKS_SUPERVISED") {
        Some("supervisor")
    } else if set("pm_id") {
        Some("pm2")
    } else if set("INVOCATION_ID") {
        Some("systemd")
    } else if dockerenv {
        Some("docker")
    } else if set("FLIKS_ENGINE_TOKEN") {
        Some("supervisor")
    } else {
        None
    }
}

pub fn current() -> Option<&'static str> {
    detect(|k| std::env::var(k).ok(), Path::new("/.dockerenv").exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(vars: &[&str], docker: bool) -> Option<&'static str> {
        detect(|k| vars.contains(&k).then(|| "1".into()), docker)
    }

    #[test]
    fn rungs_in_order() {
        assert_eq!(with(&[], false), None);
        assert_eq!(with(&["FLIKS_ENGINE_TOKEN"], false), Some("supervisor"));
        assert_eq!(with(&["FLIKS_ENGINE_TOKEN"], true), Some("docker"));
        assert_eq!(with(&["INVOCATION_ID"], true), Some("systemd"));
        assert_eq!(with(&["pm_id", "INVOCATION_ID"], true), Some("pm2"));
        assert_eq!(
            with(&["FLIKS_SUPERVISED", "pm_id"], true),
            Some("supervisor")
        );
        assert_eq!(detect(|_| Some(String::new()), false), None);
        assert_eq!(
            detect(|k| (k == "FLIKS_SUPERVISED").then(|| "0".into()), false),
            Some("supervisor")
        );
    }
}
