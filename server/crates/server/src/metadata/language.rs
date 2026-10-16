//! Global `metadata_language` / `metadata_region`, read once and dropped when either changes (rule 23).
use fliks_domain::metadata::language::{Resolved, resolve};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};

/// A per-library override; each set field wins over the global value (`??`: an empty string wins too).
#[derive(Debug, Clone, Default)]
pub struct Override {
    pub language: Option<String>,
    pub region: Option<String>,
}

type Global = Arc<(Option<String>, Option<String>)>;

#[derive(Default)]
struct Slot {
    value: Option<Global>,
    epoch: u64,
}

pub struct LanguageCache {
    db: PgPool,
    slot: Mutex<Slot>,
    /// Concurrent first reads queue here and find the committed value.
    load: tokio::sync::Mutex<()>,
}

impl LanguageCache {
    pub fn new(db: PgPool) -> Self {
        Self {
            db,
            slot: Mutex::default(),
            load: tokio::sync::Mutex::new(()),
        }
    }

    pub fn invalidate(&self) {
        let mut s = self.slot.lock().expect("slot");
        s.value = None;
        s.epoch += 1;
    }

    pub fn settings_changed(&self, keys: &[String]) {
        if keys
            .iter()
            .any(|k| k == "metadata_language" || k == "metadata_region")
        {
            self.invalidate();
        }
    }

    pub async fn resolve(&self, ov: Option<&Override>) -> Result<Resolved, sqlx::Error> {
        let g = self.global().await?;
        let pick = |o: Option<&String>, g: &Option<String>| o.cloned().or_else(|| g.clone());
        Ok(resolve(
            pick(ov.and_then(|o| o.language.as_ref()), &g.0).as_deref(),
            pick(ov.and_then(|o| o.region.as_ref()), &g.1).as_deref(),
        ))
    }

    async fn global(&self) -> Result<Global, sqlx::Error> {
        if let Some(v) = self.slot.lock().expect("slot").value.clone() {
            return Ok(v);
        }
        let _gate = self.load.lock().await;
        let epoch = {
            let s = self.slot.lock().expect("slot");
            if let Some(v) = s.value.clone() {
                return Ok(v);
            }
            s.epoch
        };
        let rows = sqlx::query!(
            r#"SELECT "key", "value" FROM app_settings WHERE "key" IN ('metadata_language', 'metadata_region')"#
        )
        .fetch_all(&self.db)
        .await?;
        let get = |k: &str| {
            rows.iter()
                .find(|r| r.key == k)
                .and_then(|r| r.value.clone())
        };
        let v: Global = Arc::new((get("metadata_language"), get("metadata_region")));
        let mut s = self.slot.lock().expect("slot");
        if s.epoch == epoch {
            s.value = Some(v.clone());
        }
        Ok(v)
    }
}
