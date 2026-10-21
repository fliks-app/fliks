//! The job name lists of `scheduler.md` rules 10 and 15; they equal `core-scheduler-jobs.ts`.

/// `(name, cron, labelKey)`, in listing order; every one is triggerable.
pub const CORE: [(&str, &str, &str); 6] = [
    ("Backup", "0 02 * * *", "system.cmd_backup"),
    (
        "RefreshMetadata",
        "0 04 * * *",
        "system.cmd_refresh_metadata",
    ),
    (
        "RefreshPluginSources",
        "0 3 * * *",
        "system.cmd_refresh_plugin_sources",
    ),
    (
        "SubtitleSearch",
        "0 0-23/6 * * *",
        "system.cmd_subtitle_search",
    ),
    (
        "SubtitleUpgrade",
        "0 0-23/6 * * *",
        "system.cmd_subtitle_upgrade",
    ),
    ("MediaCleanup", "0 05 * * *", "system.cmd_media_cleanup"),
];

/// The live TV registry jobs, after the core jobs in the listing (`livetv-sources.md` rule 46).
pub const LIVETV: [(&str, &str, &str); 3] = [
    (
        "LiveTvSourceRefresh",
        "0 0-23/1 * * *",
        "liveTv.jobs.sourceRefresh",
    ),
    (
        "LiveTvGuideRefresh",
        "0 0-23/1 * * *",
        "liveTv.jobs.guideRefresh",
    ),
    ("LiveTvGuidePrune", "0 01 * * *", "liveTv.jobs.guidePrune"),
];

pub const TRIGGER_ONLY: [&str; 7] = [
    "RescanAll",
    "RefreshMissingMetadata",
    "RescanMissingFiles",
    "GenerateSprites",
    "GenerateMissingSprites",
    "DetectMarkers",
    "DetectMissingMarkers",
];

/// Their tick is the subtitle tick (`subtitles::scheduler::spawn_tick`), not the runner's (rule 31).
pub const SUBTITLE: [&str; 2] = ["SubtitleSearch", "SubtitleUpgrade"];

/// Housekeeping tick of rule 26: not listed, not triggerable.
pub const PRUNE_CRON: &str = "0 03 * * *";

pub fn is_core(name: &str) -> bool {
    CORE.iter().chain(LIVETV.iter()).any(|(n, ..)| *n == name) || TRIGGER_ONLY.contains(&name)
}
