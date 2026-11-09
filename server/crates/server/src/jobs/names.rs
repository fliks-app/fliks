//! The job name lists of `scheduler.md` rules 10 and 15; they equal `core-scheduler-jobs.ts`.

/// `(name, cron, labelKey)`, in listing order; every one is triggerable.
pub const CORE: [(&str, &str, &str); 8] = [
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
    (
        "AcquisitionSweep",
        "0 * * * *",
        "system.cmd_acquisition_sweep",
    ),
    ("MediaCleanup", "0 05 * * *", "system.cmd_media_cleanup"),
    ("FollowRefresh", "0 06 * * *", "system.cmd_follow_refresh"),
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

/// Jobs run by their own interval tick, not the runner's: the subtitle ticks (rule 31) and the acquisition sweep.
pub const TICKED: [&str; 3] = ["SubtitleSearch", "SubtitleUpgrade", "AcquisitionSweep"];

/// Housekeeping tick of rule 26: not listed, not triggerable.
pub const PRUNE_CRON: &str = "0 03 * * *";

pub fn is_core(name: &str) -> bool {
    CORE.iter().chain(LIVETV.iter()).any(|(n, ..)| *n == name) || TRIGGER_ONLY.contains(&name)
}
