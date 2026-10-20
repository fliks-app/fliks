//! The `counts.set` push cache (`counts.md` rules 12-15, C95): per plugin, per key.
use crate::sync::MutexExt;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct Counts(Mutex<HashMap<String, HashMap<String, u64>>>);

impl Counts {
    /// C95: `key` 1-64 chars; the value is already a non-negative integer by its WIT type.
    pub fn set(&self, plugin: &str, key: &str, value: u64) -> Result<(), String> {
        let n = key.chars().count();
        if n == 0 || n > 64 {
            return Err("counts.set: key must be 1-64 chars".into());
        }
        if value > 9_007_199_254_740_991 {
            return Err("counts.set: value must be a safe integer".into());
        }
        self.0
            .lock_clean()
            .entry(plugin.to_owned())
            .or_default()
            .insert(key.to_owned(), value);
        Ok(())
    }

    /// Summed over the plugins that pushed it; `None` when none ever did.
    pub fn get(&self, key: &str) -> Option<u64> {
        let all = self.0.lock_clean();
        let mut seen = false;
        let total = all
            .values()
            .filter_map(|m| m.get(key))
            .inspect(|_| seen = true)
            .sum();
        seen.then_some(total)
    }

    pub fn forget(&self, plugin: &str) {
        self.0.lock_clean().remove(plugin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_and_sum() {
        let c = Counts::default();
        assert!(c.set("a", "", 1).is_err());
        assert!(c.set("a", &"k".repeat(65), 1).is_err());
        assert_eq!(c.get("queueActive"), None);
        c.set("a", "queueActive", 2).unwrap();
        c.set("b", "queueActive", 0).unwrap();
        assert_eq!(c.get("queueActive"), Some(2));
        c.forget("a");
        assert_eq!(c.get("queueActive"), Some(0));
    }
}
