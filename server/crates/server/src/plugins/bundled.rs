//! Provider archives embedded at build time (`providers.lock`), installed at boot (`provider-plugins.md` 3.1).
use super::{Plugins, packages};
use nodejs_semver::Version;

include!(concat!(env!("OUT_DIR"), "/bundled.rs"));

pub type Archive = (&'static str, &'static str, &'static [u8]);

impl Plugins {
    pub async fn install_bundled(&self) {
        self.install_archives(ARCHIVES).await;
    }

    /// Installs each archive whose id is absent or older than it, never over a newer version.
    pub async fn install_archives(&self, archives: &[Archive]) {
        for (id, version, bytes) in archives {
            let Ok(new) = Version::parse(version) else {
                continue;
            };
            match packages::find(&self.db, id).await {
                Ok(Some(e)) if Version::parse(&e.version).is_ok_and(|old| old >= new) => {
                    if let Err(e) = packages::mark_bundled(&self.db, id).await {
                        tracing::warn!("bundled plugin \"{id}\" not marked: {e}");
                    }
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("bundled plugin \"{id}\" skipped: {e}");
                    continue;
                }
            }
            let i = match self.inspect_bytes(bytes).await {
                Ok(i) if i.id == *id && i.version == *version => i,
                Ok(_) => {
                    tracing::warn!(
                        "bundled plugin \"{id}\" {version}: manifest differs from the lock"
                    );
                    continue;
                }
                Err(r) => {
                    tracing::warn!(
                        "bundled plugin \"{id}\" {version} refused ({}): {}",
                        r.code,
                        r.detail
                    );
                    continue;
                }
            };
            if let Err(e) = self.promote_with(bytes, &i, "bundled", false).await {
                tracing::warn!(
                    "bundled plugin \"{id}\" {version} not installed ({}): {}",
                    e.code,
                    e.message
                );
            }
        }
    }
}
