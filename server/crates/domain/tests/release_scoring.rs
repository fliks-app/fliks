//! Golden release-scoring vectors (`fixtures/release-scoring`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::release::parsing::season_episode::{ReleaseCoverage, Span};
use fliks_domain::release::scoring::*;
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `[[key, value], ...]` (a JS `Map`) to `{key: value}`, which serde reads into a `BTreeMap`.
fn maps(v: &Value, keys: &[&str]) -> Value {
    let mut v = v.clone();
    for k in keys {
        if let Some(pairs) = v[*k].as_array() {
            let obj: Map<String, Value> = pairs
                .iter()
                .map(|p| (p[0].to_string(), p[1].clone()))
                .collect();
            v[*k] = Value::Object(obj);
        }
    }
    v
}

fn strings(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().map(|s| s.as_str().unwrap().to_owned()).collect(),
        _ => vec![],
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SortRow {
    id: String,
    quality_id: i64,
    rank: i64,
    blocklisted: bool,
    language_allowed: bool,
    rejections: Vec<Value>,
    custom_format_score: i64,
    seeders: i64,
    leechers: i64,
    flags: Vec<String>,
    #[serde(default)]
    size_deviation: Option<f64>,
    #[serde(default)]
    is_full_season: bool,
    #[serde(default)]
    coverage: Option<ReleaseCoverage>,
}

impl Sortable for SortRow {
    fn quality_id(&self) -> i64 {
        self.quality_id
    }
    fn rank(&self) -> i64 {
        self.rank
    }
    fn blocklisted(&self) -> bool {
        self.blocklisted
    }
    fn language_allowed(&self) -> bool {
        self.language_allowed
    }
    fn rejected(&self) -> bool {
        !self.rejections.is_empty()
    }
    fn custom_format_score(&self) -> i64 {
        self.custom_format_score
    }
    fn seeders(&self) -> i64 {
        self.seeders
    }
    fn leechers(&self) -> i64 {
        self.leechers
    }
    fn freeleech(&self) -> bool {
        self.flags.iter().any(|f| f == "freeleech")
    }
    fn size_deviation(&self) -> Option<f64> {
        self.size_deviation
    }
    fn is_full_season(&self) -> bool {
        self.is_full_season
    }
    fn seasons(&self) -> Option<Span> {
        self.coverage.as_ref().and_then(|c| c.seasons)
    }
}

/// The tiers an unordered (non-total) comparator still respects: clean, not blocklisted, language, alive.
fn tiers<T: Sortable>(t: &T) -> (bool, bool, bool, bool) {
    (
        !t.rejected(),
        !t.blocklisted(),
        t.language_allowed(),
        t.seeders() > 0,
    )
}

fn assert_tiers_descend<T: Sortable>(rows: &[T]) {
    assert!(
        rows.windows(2).all(|w| tiers(&w[0]) >= tiers(&w[1])),
        "steps 1-4 violated"
    );
}

struct Deps {
    scores: Map<String, Value>,
    blocked: Vec<(String, i64)>,
}

impl ScorerDeps for Deps {
    fn score_custom_formats(&self, title: &str, _: &[String]) -> i64 {
        self.scores.get(title).and_then(Value::as_i64).unwrap_or(0)
    }
    fn is_blocked(&self, title: &str, source_id: i64) -> bool {
        self.blocked
            .iter()
            .any(|(t, s)| t == title && *s == source_id)
    }
}

fn title_matches(release: &str, expected: &[String], when: WhenUnreadable) -> bool {
    let index = index_title_expectations(expected);
    !index.vacuous && matches_indexed_expectation(&release_title_tokens(release), &index, when)
        || index.vacuous
}

fn run(i: &Value) -> Value {
    let s = |k: &str| i[k].as_str().unwrap();
    let opt = |k: &str| i[k].as_str();
    let index = || index_title_expectations(&strings(&i["expected"]));
    match s("fn") {
        "computeRejections" => {
            let o: RejectionInput =
                serde_json::from_value(maps(&i["opts"], &["sizeByQuality", "sourceMinSeeders"]))
                    .unwrap();
            json!(compute_rejections(&o))
        }
        "sortReleasesByRelevance" => {
            let rows: Vec<SortRow> = serde_json::from_value(i["rows"].clone()).unwrap();
            let sorted =
                sort_releases_by_relevance(rows, i["preferFullSeason"].as_bool() == Some(true));
            let mut ids: Vec<String> = sorted.iter().map(|r| r.id.clone()).collect();
            if opt("order") == Some("unspecified") {
                assert_tiers_descend(&sorted);
                ids.sort();
            }
            json!(ids)
        }
        "scoreAndSortReleases" => {
            let opts: ScoreOptions = serde_json::from_value(maps(
                &i["opts"],
                &["sizeByQuality", "sourceMinSeeders", "sourceUnknownLang"],
            ))
            .unwrap();
            let deps = Deps {
                scores: i["customFormatScores"].as_object().unwrap().clone(),
                blocked: i["blocked"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].as_i64().unwrap()))
                    .collect(),
            };
            let releases: Vec<ReleaseCandidate> =
                serde_json::from_value(i["releases"].clone()).unwrap();
            let mut out = score_and_sort_releases(releases, &opts, &deps);
            if opt("order") == Some("unspecified") {
                assert_tiers_descend(&out);
                out.sort_by(|a, b| a.candidate.download_url.cmp(&b.candidate.download_url));
            }
            json!(out)
        }
        "indexTitleExpectations" => json!(index()),
        "titleMatchesExpectation" => {
            let when = if opt("whenUnreadable") == Some("no-match") {
                WhenUnreadable::NoMatch
            } else {
                WhenUnreadable::Match
            };
            json!(title_matches(
                s("releaseTitle"),
                &strings(&i["expected"]),
                when
            ))
        }
        "releaseTitleTokens" => json!(release_title_tokens(s("title"))),
        "appendedSequelNumber" => json!(appended_sequel_number(s("releaseTitle"), &index())),
        "collectionPackWord" => json!(collection_pack_word(s("releaseTitle"), &index())),
        "releaseYears" => json!(release_years(s("title"))),
        "resolveSearchTitles" => {
            let m: SearchMedia = serde_json::from_value(i["media"].clone()).unwrap();
            json!(resolve_search_titles(&m, opt("customQuery")))
        }
        "releaseMatchesMedia" => {
            let m: SearchMedia = serde_json::from_value(i["media"].clone()).unwrap();
            let expected = resolve_search_titles(&m, None).expected_titles;
            let release = s("releaseTitle");
            let year = i["media"]["year"].as_i64().filter(|y| *y != 0);
            json!(
                title_matches(release, &expected, WhenUnreadable::Match) && {
                    match (i["requireYearInTitle"].as_bool() == Some(true), year) {
                        (true, Some(y)) => release.contains(&y.to_string()),
                        _ => true,
                    }
                }
            )
        }
        "computeSizeDeviation" => {
            let limits: Option<SizeLimits> = serde_json::from_value(i["limits"].clone()).unwrap();
            json!(compute_size_deviation(
                s("title"),
                i["sizeBytes"].as_f64().unwrap(),
                i["runtimeMinutes"].as_f64().unwrap(),
                limits.as_ref()
            ))
        }
        "detectCodecSizeFactor" => json!(detect_codec_size_factor(opt("title"))),
        "detectVideoCodec" => json!(detect_video_codec(opt("title"))),
        "buildAllowedQualityIds" => {
            let items: Vec<QualityProfileItem> =
                serde_json::from_value(i["items"].clone()).unwrap_or_default();
            json!(build_allowed_quality_ids(&items))
        }
        "allowedAudioLanguageIds" => {
            let items: Vec<AudioLanguageItem> =
                serde_json::from_value(i["items"].clone()).unwrap_or_default();
            json!(allowed_audio_language_ids(&items))
        }
        "releaseFlags" => {
            let src = &i["source"];
            json!(release_flags(
                &strings(&src["flags"]),
                src["freeleech"].as_bool(),
                src["downloadVolumeFactor"].as_f64()
            ))
        }
        "maxResolutionFromQualityStrings" => {
            let files: Vec<Option<&str>> = i["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["quality"].as_str())
                .collect();
            json!(max_resolution_from_quality_strings(&files))
        }
        f => Value::String(format!("unknown fn {f}")),
    }
}

#[test]
fn release_scoring_reproduces_expected() {
    replay("release-scoring", 3029, run);
}
