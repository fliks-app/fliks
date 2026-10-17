//! The job name lists of `scheduler.md` rules 10 and 15; they equal `core-scheduler-jobs.ts`.

/// `(name, cron, labelKey)`, in listing order; every one is triggerable.
pub const CORE: [(&str, &str, &str); 5] = [
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
];

/// The live TV registry jobs, after the core five in the listing (`livetv-sources.md` rule 46).
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

/// Core names whose body Nest still holds (rule 30).
pub const BRIDGED: [&str; 1] = ["RefreshPluginSources"];

/// Their tick is the subtitle tick (`subtitles::scheduler::spawn_tick`), not the runner's (rule 31).
pub const SUBTITLE: [&str; 2] = ["SubtitleSearch", "SubtitleUpgrade"];

/// Housekeeping tick of rule 26: not listed, not triggerable.
pub const PRUNE_CRON: &str = "0 03 * * *";

pub fn is_core(name: &str) -> bool {
    CORE.iter().chain(LIVETV.iter()).any(|(n, ..)| *n == name) || TRIGGER_ONLY.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(src: &str, array: &str) -> Vec<String> {
        let body = src.split(array).nth(1).unwrap().split(']').next().unwrap();
        body.split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    /// Pins both lists to the TS source while it exists (deleted with Nest at S8).
    #[test]
    fn lists_equal_core_scheduler_jobs_ts() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../backend/src/common/constants/core-scheduler-jobs.ts"
        );
        let Ok(src) = std::fs::read_to_string(path) else {
            return;
        };
        let core: Vec<_> = CORE.iter().map(|(n, ..)| n.to_string()).collect();
        assert_eq!(core, quoted(&src, "CORE_SCHEDULER_JOB_NAMES = ["));
        assert_eq!(
            TRIGGER_ONLY.map(String::from).to_vec(),
            quoted(&src, "CORE_TRIGGER_ONLY_JOB_NAMES = [")
        );
        assert!(src.contains("PLUGIN_SOURCE_REFRESH_CRON = '0 3 * * *'"));
        let livetv: Vec<_> = LIVETV.iter().map(|(n, ..)| n.to_string()).collect();
        assert_eq!(livetv, quoted(&src, "CORE_LIVETV_JOB_NAMES = ["));
    }

    #[test]
    fn bridged_names_are_core() {
        assert!(BRIDGED.iter().all(|n| is_core(n)));
    }
}
