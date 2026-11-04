//! A scene provider answering from a table, for the tests of the scene numbering.
use crate::metadata::{Call, Credits, MetadataProvider, PersonDetails, Search, Upstream};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
    release::scene::Entry,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[derive(Default)]
pub struct SceneStub {
    /// What `scene_mapped_ids` lists.
    pub ids: Mutex<Vec<String>>,
    /// The mapping per TVDB id; an id without one answers none.
    pub maps: Mutex<HashMap<String, Vec<Entry>>>,
    /// Every call fails 503.
    pub down: AtomicBool,
    /// `scene_mapping` calls so far.
    pub mapping_calls: AtomicUsize,
}

fn off<T: Send + 'static>() -> Call<'static, T> {
    Box::pin(async { Err(Upstream::new(Some(404), "scene stub")) })
}

impl MetadataProvider for SceneStub {
    fn id(&self) -> Namespace {
        Namespace::TVDB
    }
    fn supports(&self, _: MediaKind) -> bool {
        false
    }
    fn has_persons(&self) -> bool {
        false
    }
    fn limits(&self) -> Limits {
        Limits::new(1.0, 1)
    }
    fn has_scene(&self) -> bool {
        true
    }
    fn scene_mapped_ids<'a>(&'a self, _: Priority) -> Call<'a, Vec<String>> {
        let r = if self.down.load(Ordering::SeqCst) {
            Err(Upstream::new(Some(503), "scene stub down"))
        } else {
            Ok(self.ids.lock().unwrap().clone())
        };
        Box::pin(async move { r })
    }
    fn scene_mapping<'a>(&'a self, id: &'a str, _: Priority) -> Call<'a, Option<Vec<Entry>>> {
        self.mapping_calls.fetch_add(1, Ordering::SeqCst);
        let r = if self.down.load(Ordering::SeqCst) {
            Err(Upstream::new(Some(503), "scene stub down"))
        } else {
            Ok(self.maps.lock().unwrap().get(id).cloned())
        };
        Box::pin(async move { r })
    }
    fn search<'a>(
        &'a self,
        _: &'a Search<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        off()
    }
    fn fetch_work<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        off()
    }
    fn fetch_children<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: Option<u32>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        off()
    }
    fn child_stubs<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        off()
    }
    fn find_by<'a>(
        &'a self,
        _: Namespace,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        off()
    }
    fn fetch_person<'a>(
        &'a self,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, PersonDetails> {
        off()
    }
    fn person_credits<'a>(&'a self, _: &'a str, _: &'a Resolved, _: Priority) -> Call<'a, Credits> {
        off()
    }
}
