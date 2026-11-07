//! SQL selection of the candidate files of a library and their aggregation into a preview.
use super::codec::{self, Capabilities, Device, Target};
use super::diff::{self, Change, Env, File, Outcome, TrackKind};
use super::languages::Languages;
use super::profile::Profile;
use crate::ingest::rescan::PROBE_VERSION;
use fliks_domain::subtitle_flags::LanguageItem;
use fliks_engine_core::api::MediaInfo;
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::{PgPool, Row};
use std::collections::{BTreeMap, HashSet};

/// Everything a library's comparison needs besides the files, loaded once.
pub struct Context {
    pub profile: Profile,
    pub allow_rename: bool,
    pub target: Option<Target>,
    pub audio_playable: HashSet<String>,
    pub force: bool,
}

impl Context {
    pub async fn load(
        db: &PgPool,
        profile: Profile,
        allow_rename: bool,
        caps: &Capabilities,
    ) -> sqlx::Result<Self> {
        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"SELECT "directPlayProfiles" FROM client_codecs WHERE "lastSeenAt" > now() - interval '90 days'"#,
        )
        .fetch_all(db)
        .await?;
        let devices: Vec<Device> = rows.iter().map(Device::from_profiles).collect();
        Ok(Self {
            target: codec::resolve(&profile.video, &devices, caps),
            audio_playable: codec::audio_playable(&devices),
            profile,
            allow_rename,
            force: false,
        })
    }

    fn env(&self) -> Env<'_> {
        Env {
            profile: &self.profile,
            allow_rename: self.allow_rename,
            target: self.target,
            audio_playable: &self.audio_playable,
            force: self.force,
        }
    }
}

/// A candidate with its comparison result.
pub struct Candidate {
    pub media_file_id: i32,
    pub size: i64,
    pub duration_seconds: f64,
    pub outcome: Outcome,
}

/// Candidates of a library (or of `only` inside it): probed with the current version, probe not
/// failed, with a video stream, no active job, no remembered `corrupt`/`damaged` failure of the
/// same bytes. `visit` runs for each one in id order.
pub async fn analyze(
    db: &PgPool,
    library_id: i32,
    only: Option<&[i32]>,
    ctx: &Context,
    mut visit: impl FnMut(Candidate),
) -> sqlx::Result<()> {
    let mut rows = sqlx::query(
        r#"SELECT mf.id, mf."relativePath", mf.size, mf."streamInfo", mf."probeVersion",
                  (EXTRACT(EPOCH FROM now() - mf."createdAt") / 86400)::float8 AS age_days,
                  COALESCE(movie."originalLanguage", series."originalLanguage") AS original,
                  lp."audioLanguages", lp."subtitleLanguages",
                  EXISTS (SELECT 1 FROM playback_qoe_sessions q
                          WHERE q."mediaFileId" = mf.id AND q."startedAt" > now() - interval '30 days'
                            AND q."transcodeReasons" <> '[]'::jsonb) AS transcoded
           FROM media_files mf
           JOIN media m ON m.id = mf."mediaId"
           JOIN libraries l ON l.id = m."libraryId"
           LEFT JOIN movie_details movie ON movie."mediaId" = m.id
           LEFT JOIN series_details series ON series."mediaId" = m.id
           LEFT JOIN language_profiles lp ON lp.id = COALESCE(m."languageProfileId", l."defaultLanguageProfileId")
           WHERE m."libraryId" = $1
             AND ($2::int[] IS NULL OR mf.id = ANY($2))
             AND mf."probeVersion" >= $3
             AND mf."streamInfo"->>'error' IS NULL
             AND jsonb_array_length(COALESCE(mf."streamInfo"->'video', '[]'::jsonb)) > 0
             AND ($2::int[] IS NOT NULL OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = mf.id AND j.state IN ('queued', 'leased', 'staged', 'committing')))
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = mf.id AND j.state = 'failed'
                               AND j.error->>'class' IN ('corrupt', 'damaged')
                               AND j."inSize" = mf.size AND j."inMtimeMs" IS NOT DISTINCT FROM mf."mtimeMs")
           ORDER BY mf.id"#,
    )
    .bind(library_id)
    .bind(only)
    .bind(PROBE_VERSION)
    .fetch(db);
    let env = ctx.env();
    while let Some(r) = rows.try_next().await? {
        let info: MediaInfo = match serde_json::from_value(r.try_get("streamInfo")?) {
            Ok(i) => i,
            Err(_) => continue,
        };
        let items = |col: &str| -> Vec<String> {
            r.try_get::<Option<serde_json::Value>, _>(col)
                .ok()
                .flatten()
                .and_then(|v| serde_json::from_value::<Vec<LanguageItem>>(v).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|i| i.iso_code)
                .collect()
        };
        let languages = Languages {
            original: r.try_get::<Option<String>, _>("original")?,
            profile_audio: items("audioLanguages"),
            profile_subtitles: items("subtitleLanguages"),
        };
        let path: String = r.try_get("relativePath")?;
        let file = File {
            relative_path: &path,
            info: &info,
            probe_version: r.try_get("probeVersion")?,
            age_days: r.try_get::<f64, _>("age_days")? as i64,
            languages: &languages,
            transcoded_recently: r.try_get("transcoded")?,
        };
        visit(Candidate {
            media_file_id: r.try_get("id")?,
            size: r.try_get("size")?,
            duration_seconds: info.duration_seconds.unwrap_or(0.0),
            outcome: diff::compute(&env, &file),
        });
    }
    Ok(())
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct PerLevel {
    pub metadata: i64,
    pub remux: i64,
    pub reencode: i64,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerLevelF {
    pub metadata: f64,
    pub remux: f64,
    pub reencode: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub kind: TrackKind,
    pub language: Option<String>,
    pub count: i64,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub files: i64,
    pub conform: i64,
    pub skipped_container: i64,
    pub with_difference: i64,
    pub per_level: PerLevel,
    /// Source bytes and playing time per level: the base of a duration estimate.
    pub bytes: PerLevelF,
    pub duration_seconds: PerLevelF,
    pub removed: Vec<Removed>,
    pub ocr: i64,
    pub warnings: BTreeMap<String, i64>,
    /// Encoding seconds per level from the recent speed of the workers; none without history.
    pub estimate_seconds: crate::queue::PerLevelOpt,
}

#[derive(Default)]
pub struct Tally {
    p: Preview,
    removed: BTreeMap<(bool, Option<String>), i64>,
}

impl Tally {
    pub fn add(&mut self, r: &Candidate) {
        let p = &mut self.p;
        p.files += 1;
        let warnings = match &r.outcome {
            Outcome::Excluded { .. } => {
                p.files -= 1;
                return;
            }
            Outcome::Skipped { .. } => {
                p.skipped_container += 1;
                return;
            }
            Outcome::Conform { warnings } => {
                p.conform += 1;
                warnings
            }
            Outcome::Diff(d) => {
                p.with_difference += 1;
                let (n, b, s) = match d.level {
                    diff::LevelOut::Metadata => (
                        &mut p.per_level.metadata,
                        &mut p.bytes.metadata,
                        &mut p.duration_seconds.metadata,
                    ),
                    diff::LevelOut::Remux => (
                        &mut p.per_level.remux,
                        &mut p.bytes.remux,
                        &mut p.duration_seconds.remux,
                    ),
                    diff::LevelOut::Reencode => (
                        &mut p.per_level.reencode,
                        &mut p.bytes.reencode,
                        &mut p.duration_seconds.reencode,
                    ),
                };
                *n += 1;
                *b += r.size as f64;
                *s += r.duration_seconds;
                for c in &d.changes {
                    match c {
                        Change::Drop { kind, language, .. } => {
                            *self
                                .removed
                                .entry((*kind == TrackKind::Audio, language.clone()))
                                .or_default() += 1;
                        }
                        Change::Ocr { .. } => p.ocr += 1,
                        _ => {}
                    }
                }
                &d.warnings
            }
        };
        for w in warnings {
            let kind = serde_json::to_value(w)
                .ok()
                .and_then(|v| v["type"].as_str().map(str::to_owned))
                .unwrap_or_default();
            *p.warnings.entry(kind).or_default() += 1;
        }
    }

    pub fn finish(mut self) -> Preview {
        self.p.removed = self
            .removed
            .into_iter()
            .map(|((audio, language), count)| Removed {
                kind: if audio {
                    TrackKind::Audio
                } else {
                    TrackKind::Subtitle
                },
                language,
                count,
            })
            .collect();
        self.p
    }
}

pub async fn preview(db: &PgPool, library_id: i32, ctx: &Context) -> sqlx::Result<Preview> {
    let mut t = Tally::default();
    analyze(db, library_id, None, ctx, |r| t.add(&r)).await?;
    Ok(t.finish())
}
