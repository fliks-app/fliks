//! A music provider that answers what a test puts in it, for the apply and identify tests.
use crate::metadata::{
    Call, Credits, EditionRef, LyricsHit, LyricsQuery, MetadataProvider, PersonDetails, Search,
    Upstream,
};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};

pub(crate) const GROUP: &str = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
pub(crate) const RELEASE: &str = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";
pub(crate) const ARTIST: &str = "d1f7f2a4-3c0a-4f6e-9d27-0a3f7e2b9c11";

#[derive(Default)]
pub(crate) struct MusicFake {
    pub works: Mutex<HashMap<String, Value>>,
    pub children: Mutex<HashMap<String, Vec<Value>>>,
    pub editions: Mutex<HashMap<String, Value>>,
    pub found: Mutex<Vec<Value>>,
    /// The discography `person_credits` answers.
    pub albums: Mutex<Vec<Value>>,
    /// The `topRecordings` `person_credits` answers.
    pub top: Mutex<Vec<Value>>,
    pub calls: Mutex<Vec<String>>,
    /// What `fetch_lyrics` answers; none means the provider declares no lyrics.
    pub lyrics: Mutex<Option<Option<LyricsHit>>>,
    /// `fetch_lyrics` fails with a 503.
    pub lyrics_down: std::sync::atomic::AtomicBool,
    /// The registry key; the MusicBrainz one when none.
    pub key: Mutex<Option<Namespace>>,
}

impl MusicFake {
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn missing<T: Send + 'static>() -> Call<'static, T> {
    Box::pin(async { Err(Upstream::new(Some(404), "not found")) })
}

impl MetadataProvider for MusicFake {
    fn id(&self) -> Namespace {
        self.key.lock().unwrap().unwrap_or(Namespace::MUSICBRAINZ)
    }
    fn supports(&self, kind: MediaKind) -> bool {
        kind == MediaKind::Album
    }
    fn has_persons(&self) -> bool {
        false
    }
    fn serves_persons_of(&self, _: MediaKind, ns: Namespace) -> bool {
        ns == Namespace::MUSICBRAINZ
    }
    fn has_lyrics(&self) -> bool {
        self.lyrics.lock().unwrap().is_some()
    }
    fn fetch_lyrics<'a>(&'a self, q: &'a LyricsQuery, _: Priority) -> Call<'a, Option<LyricsHit>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("lyrics {}", q.title));
        let r = self.lyrics.lock().unwrap().clone().flatten();
        let down = self.lyrics_down.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if down {
                return Err(Upstream::new(Some(503), "down"));
            }
            Ok(r)
        })
    }
    fn limits(&self) -> Limits {
        Limits::new(100.0, 100)
    }
    fn search<'a>(
        &'a self,
        q: &'a Search<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("search {}", q.query));
        let r = self.found.lock().unwrap().clone();
        Box::pin(async move { Ok(r) })
    }
    fn fetch_work<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        self.calls.lock().unwrap().push(format!("work {id}"));
        match self.works.lock().unwrap().get(id).cloned() {
            Some(v) => Box::pin(async move { Ok(v) }),
            None => missing(),
        }
    }
    fn fetch_children<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: Option<u32>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let r = self
            .children
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default();
        Box::pin(async move { Ok(r) })
    }
    fn child_stubs<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn find_by<'a>(
        &'a self,
        _: Namespace,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        Box::pin(async { Ok(None) })
    }
    fn fetch_person<'a>(
        &'a self,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, PersonDetails> {
        missing()
    }
    fn person_credits<'a>(&'a self, _: &'a str, _: &'a Resolved, _: Priority) -> Call<'a, Credits> {
        let albums = self.albums.lock().unwrap().clone();
        let top_recordings = self.top.lock().unwrap().clone();
        Box::pin(async move {
            Ok(Credits {
                albums,
                top_recordings,
                ..Credits::default()
            })
        })
    }
    fn fetch_edition<'a>(
        &'a self,
        e: &'a EditionRef<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<Value>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("edition {}", e.value));
        let r = self.editions.lock().unwrap().get(e.value).cloned();
        match r {
            Some(v) => Box::pin(async move { Ok(Some(v)) }),
            None => missing(),
        }
    }
}
