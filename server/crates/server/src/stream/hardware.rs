//! `HostHardwareService` (spec rule 47): the engine's detected capabilities and the admin GPU pin.
use crate::{engine, state::AppState};
use fliks_engine_core::api::{Capabilities, Gpu, StreamingConfig};
use std::sync::Mutex;

const DEFAULT_NODE: &str = "/dev/dri/renderD128";

#[derive(Default)]
struct Inner {
    caps: Option<Capabilities>,
    node: Option<String>,
}

/// The last capabilities the engine reported and the render node the host pinned.
#[derive(Default)]
pub struct Hardware(Mutex<Inner>);

impl Hardware {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `none` before any detection.
    pub fn hw_accel(&self) -> String {
        self.lock()
            .caps
            .as_ref()
            .map_or_else(|| "none".into(), |c| c.hw_accel.clone())
    }

    pub fn tonemap_algos(&self) -> Vec<String> {
        self.lock()
            .caps
            .as_ref()
            .map_or_else(|| vec!["auto".into()], |c| c.tonemap_algos.clone())
    }

    pub fn pause_capability(&self) -> String {
        self.lock()
            .caps
            .as_ref()
            .map_or_else(|| "none".into(), |c| c.pause_capability.clone())
    }

    /// Detected GPUs and what `auto` resolves to (the admin pin, else the first render node).
    pub fn gpus(&self) -> (Vec<Gpu>, String) {
        let g = self.lock();
        let pinned = g
            .node
            .clone()
            .filter(|n| !n.is_empty() && n != "auto")
            .unwrap_or_else(|| DEFAULT_NODE.into());
        (
            g.caps.as_ref().map_or_else(Vec::new, |c| c.gpus.clone()),
            pinned,
        )
    }

    fn store(&self, caps: Capabilities) {
        self.lock().caps = Some(caps);
    }

    /// Remembers the pin; true when it replaced a different one.
    fn pin(&self, node: &str) -> bool {
        let mut g = self.lock();
        let re_pinned = g.node.as_deref().is_some_and(|n| n != node);
        g.node = Some(node.to_owned());
        re_pinned
    }
}

/// Playback-info calls this with the settings it just read; boot and each engine adoption `redetect`.
/// The config push itself is the engine glue's (it dedupes), so only detection is left here.
pub fn apply(st: &AppState, ss: &StreamingConfig, redetect: bool) {
    let re_pinned = st.stream.hardware.pin(&ss.gpu_render_node);
    if st.engine.enabled() && (redetect || re_pinned) {
        let (st, node) = (st.clone(), ss.gpu_render_node.clone());
        tokio::spawn(async move { refresh(&st, &node).await });
    }
}

async fn refresh(st: &AppState, node: &str) {
    match st.engine.capabilities_for(node).await {
        Ok(c) => {
            tracing::info!(
                "Hardware acceleration: {} (from the engine)",
                c.capabilities.hw_accel
            );
            st.stream.hardware.store(c.capabilities);
        }
        Err(e) => tracing::warn!("engine capabilities unavailable: {e}"),
    }
}

pub(super) fn spawn(st: AppState) {
    let mut adoptions = st.engine.adoptions();
    tokio::spawn(async move {
        while adoptions.changed().await.is_ok() {
            match engine::load_streaming(&st.db).await {
                Ok(ss) => apply(&st, &ss, true),
                Err(e) => tracing::warn!("streaming settings not applied: {e}"),
            }
        }
    });
}
