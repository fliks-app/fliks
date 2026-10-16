//! Job bodies that live in other domains (`scheduler.md` rules 23, 25, 27-29): the scheduler owns the
//! loops, progress and audit, a domain implements one `JobWork` and integration puts it in `AppState`.
use crate::events::Subject;
use std::{future::Future, pin::Pin};

/// A failed item is logged and skipped; `Unavailable` (nothing implements the work yet) aborts the job.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkError {
    Failed(String),
    Unavailable(&'static str),
}

impl std::fmt::Display for WorkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(m) => f.write_str(m),
            Self::Unavailable(w) => write!(f, "{w} is not wired in this build"),
        }
    }
}

pub type Work<'a, T> = Pin<Box<dyn Future<Output = Result<T, WorkError>> + Send + 'a>>;

/// What one rescan changed.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Rescan {
    pub added: u32,
    pub removed: u32,
    pub updated: u32,
}

/// A season to scan for intro and outro markers, ordered as the markers spec lists them.
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonScan {
    pub season_id: i32,
    pub season_number: i32,
    pub media_id: i32,
    pub media_title: String,
}

/// Implemented by the media (refresh, rescan) and markers ports.
pub trait JobWork: Send + Sync + 'static {
    /// `refreshMetadata(id)`: the media reloads itself; an error is that title's failure.
    fn refresh_metadata(&self, media_id: i32) -> Work<'_, ()>;
    /// `rescanFiles(id)`.
    fn rescan(&self, media_id: i32) -> Work<'_, Rescan>;
    /// `markers.listSeasonsForScan(onlyMissing)`.
    fn seasons_for_scan(&self, only_missing: bool) -> Work<'_, Vec<SeasonScan>>;
    /// `markers.runDetectionInline`: markers saved (intros plus outros); 0 when the season is busy elsewhere.
    fn detect_markers(&self, season_id: i32, subject: Subject) -> Work<'_, u32>;
}

/// The default until integration: every call is `Unavailable`, so a triggered job ends `failed`.
pub struct Unwired;

fn unavailable<T: Send + 'static>(what: &'static str) -> Work<'static, T> {
    Box::pin(async move { Err(WorkError::Unavailable(what)) })
}

impl JobWork for Unwired {
    fn refresh_metadata(&self, _: i32) -> Work<'_, ()> {
        unavailable("metadata refresh")
    }
    fn rescan(&self, _: i32) -> Work<'_, Rescan> {
        unavailable("media rescan")
    }
    fn seasons_for_scan(&self, _: bool) -> Work<'_, Vec<SeasonScan>> {
        unavailable("marker detection")
    }
    fn detect_markers(&self, _: i32, _: Subject) -> Work<'_, u32> {
        unavailable("marker detection")
    }
}
