//! What made a karaoke result and when it is outdated (`docs/spec/karaoke.md` rule 12a).
use fliks_engine_core::api::{JobRevisions, MelodyAnalysis, ModelInfo, ModelKind, ModelsResponse};
use serde::{Deserialize, Serialize};

/// The model, its version and the engine's revision of the job kind that made a result.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub model: String,
    pub version: String,
    pub revision: u32,
}

impl Stamp {
    /// What a job naming `m` makes today.
    pub fn current(m: &ModelInfo, revision: u32) -> Self {
        Self {
            model: m.id.clone(),
            version: version_of(m).to_owned(),
            revision,
        }
    }

    /// Made by another model, another version of it or an older revision than `want`
    /// (`store::unprepared` holds the same test in SQL).
    pub fn stale(&self, want: &Self) -> bool {
        self.model != want.model || self.version != want.version || self.revision < want.revision
    }
}

/// The version a job runs: the one on disk, which an outdated model keeps until its update.
pub fn version_of(m: &ModelInfo) -> &str {
    m.installed_version.as_deref().unwrap_or(&m.version)
}

/// `lyrics."alignedBy"` of a generated row, and the rejection of rule 18 in the same form.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Aligned {
    #[serde(flatten)]
    pub by: Stamp,
    /// Digest of the lines the aligner timed.
    pub text: String,
    pub matched: f64,
    /// Why the recogniser placed the words instead of the named CTC model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

impl Aligned {
    pub fn stale(&self, want: &Stamp, text: &str) -> bool {
        self.by.stale(want) || self.text != text
    }
}

/// `lyrics."pitchedBy"`: the `Melody` that wrote the row's pitch, with its analysis of the song.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pitched {
    #[serde(flatten)]
    pub by: Stamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<MelodyAnalysis>,
}

/// The stamps a new run would write, per step; `None` where no model of the kind is installed.
pub struct Wants {
    pub separate: Option<Stamp>,
    pub melody: Option<Stamp>,
    pub align_revision: u32,
}

impl Wants {
    pub fn of(models: &ModelsResponse) -> Self {
        let JobRevisions {
            separate,
            align,
            melody,
        } = models.revisions;
        let pick =
            |k, rev| super::run::installed_model(&models.models, k).map(|m| Stamp::current(m, rev));
        Self {
            separate: pick(ModelKind::Separation, separate),
            melody: pick(ModelKind::Melody, melody),
            align_revision: align,
        }
    }
}

/// The steps of a track whose result is outdated.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Stages {
    pub separate: bool,
    pub align: bool,
    pub melody: bool,
}

impl Stages {
    pub fn any(self) -> bool {
        self.separate || self.align || self.melody
    }

    pub fn names(self) -> Vec<&'static str> {
        [
            (self.separate, "separate"),
            (self.align, "align"),
            (self.melody, "melody"),
        ]
        .into_iter()
        .filter_map(|(on, n)| on.then_some(n))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(model: &str, version: &str, revision: u32) -> Stamp {
        Stamp {
            model: model.into(),
            version: version.into(),
            revision,
        }
    }

    #[test]
    fn a_result_is_stale_for_another_model_version_or_an_older_revision() {
        let want = s("m", "2", 2);
        assert!(!s("m", "2", 2).stale(&want));
        assert!(
            !s("m", "2", 3).stale(&want),
            "a newer revision is not redone"
        );
        assert!(s("m", "2", 1).stale(&want));
        assert!(s("m", "1", 2).stale(&want));
        assert!(s("n", "2", 2).stale(&want));
        let a = Aligned {
            by: s("m", "2", 2),
            text: "ab".into(),
            matched: 0.9,
            fallback: None,
        };
        assert!(!a.stale(&want, "ab"));
        assert!(a.stale(&want, "cd"), "the source text changed");
    }

    #[test]
    fn an_outdated_model_runs_its_installed_version() {
        let mut m: ModelInfo = serde_json::from_value(serde_json::json!({
            "id": "m", "kind": "separation", "name": "m", "version": "3", "default": true,
            "state": "installed", "languages": [], "files": [], "downloadedBytes": 0,
            "homepage": "", "sizeBytes": 0, "diskBytes": 0, "outdated": true, "verifying": false,
            "installedVersion": "2", "licence": {"name": "l", "text": "t", "clear": true}
        }))
        .unwrap();
        assert_eq!(Stamp::current(&m, 2), s("m", "2", 2));
        m.installed_version = None;
        assert_eq!(version_of(&m), "3");
    }
}
