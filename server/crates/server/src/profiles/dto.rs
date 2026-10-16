//! Request bodies (`profiles.md` rules 7, 15, 19, 22, 29): serde types with the global pipe's strictness.
use crate::http::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value, json};

type Res<T> = Result<T, AppError>;

/// `None` = key absent, `Some(None)` = explicit `null`; both survive a round trip into jsonb.
type Patch<T> = Option<Option<T>>;

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Patch<T>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Rejects `null` where Nest let it through to Postgres (C1).
fn not_null<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

/// `IsNumber` accepts `1.0`; Postgres integer columns need an `int4` (C1).
fn int4(field: &str, n: &Number) -> Res<i32> {
    n.as_i64()
        .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        .and_then(|i| i32::try_from(i).ok())
        .ok_or_else(|| AppError::bad_request(vec![format!("{field} must be an integer number")]))
}

fn non_empty(field: &str, empty: bool) -> Res<()> {
    if empty {
        return Err(AppError::bad_request(vec![format!(
            "{field} should not be empty"
        )]));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualityItem {
    quality_id: Number,
    quality_name: String,
    resolution: Number,
    source: String,
    allowed: bool,
    sort_order: Number,
    group_id: Option<Number>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityProfile {
    name: String,
    cutoff: Number,
    upgrade_allowed: Option<bool>,
    resolution_upgrade_only: Option<bool>,
    min_custom_format_score: Option<Number>,
    items: Vec<QualityItem>,
}

/// Validated columns; a `None` option is the create default or the update keep.
pub struct QualityValues {
    pub name: String,
    pub cutoff: i32,
    pub items: Value,
    pub upgrade_allowed: Option<bool>,
    pub resolution_upgrade_only: Option<bool>,
    pub min_custom_format_score: Option<i32>,
}

impl QualityProfile {
    pub fn validate(self) -> Res<QualityValues> {
        let items = self
            .items
            .into_iter()
            .map(|i| {
                let mut v = json!({
                    "quality": {
                        "id": i.quality_id, "name": i.quality_name,
                        "resolution": i.resolution, "source": i.source,
                    },
                    "allowed": i.allowed,
                    "sortOrder": i.sort_order,
                });
                if let Some(g) = i.group_id {
                    v["groupId"] = Value::Number(g);
                }
                v
            })
            .collect();
        Ok(QualityValues {
            name: self.name,
            cutoff: int4("cutoff", &self.cutoff)?,
            items: Value::Array(items),
            upgrade_allowed: self.upgrade_allowed,
            resolution_upgrade_only: self.resolution_upgrade_only,
            min_custom_format_score: self
                .min_custom_format_score
                .map(|n| int4("minCustomFormatScore", &n))
                .transpose()?,
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Prefer,
    Avoid,
    Require,
    Forbid,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Audio {
    iso_code: String,
    name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Subtitle {
    iso_code: String,
    name: String,
    forced: bool,
    hi: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    hearing_impaired: Patch<Mode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageProfile {
    name: String,
    audio_languages: Option<Vec<Audio>>,
    subtitle_languages: Option<Vec<Subtitle>>,
}

/// An absent or `null` array stores `[]`, on create and update alike (rule 15).
pub struct LanguageValues {
    pub name: String,
    pub audio: Value,
    pub subtitles: Value,
}

impl LanguageProfile {
    pub fn validate(self) -> LanguageValues {
        LanguageValues {
            name: self.name,
            audio: json!(self.audio_languages.unwrap_or_default()),
            subtitles: json!(self.subtitle_languages.unwrap_or_default()),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SpecType {
    TitleRegex,
    Source,
    Resolution,
    Language,
    ReleaseFlag,
    ReleaseGroup,
    Edition,
    VideoCodec,
    AudioCodec,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Spec {
    #[serde(rename = "type")]
    kind: SpecType,
    value: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    negate: Patch<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    required: Patch<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomFormat {
    name: String,
    score: Option<Number>,
    specs: Vec<Spec>,
}

pub struct FormatValues {
    pub name: String,
    pub score: Option<i32>,
    pub specs: Value,
}

impl CustomFormat {
    pub fn validate(self) -> Res<FormatValues> {
        non_empty("name", self.name.is_empty())?;
        non_empty("specs", self.specs.is_empty())?;
        for (i, s) in self.specs.iter().enumerate() {
            non_empty(&format!("specs.{i}.value"), s.value.is_empty())?;
        }
        Ok(FormatValues {
            name: self.name,
            score: self.score.map(|n| int4("score", &n)).transpose()?,
            specs: json!(self.specs),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestFormat {
    pub title: String,
    pub freeleech: Option<bool>,
    pub download_volume_factor: Option<f64>,
}

impl TestFormat {
    pub fn validate(self) -> Res<Self> {
        non_empty("title", self.title.is_empty())?;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefinitionItem {
    quality_id: Number,
    #[serde(default, deserialize_with = "not_null")]
    title: Option<String>,
    min_size: f64,
    preferred_size: f64,
    max_size: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definitions {
    items: Vec<DefinitionItem>,
}

pub struct DefinitionValues {
    pub quality_id: i32,
    pub title: Option<String>,
    pub sizes: [f64; 3],
}

impl Definitions {
    pub fn validate(self) -> Res<Vec<DefinitionValues>> {
        self.items
            .into_iter()
            .enumerate()
            .map(|(i, it)| {
                for (f, v) in [
                    ("minSize", it.min_size),
                    ("preferredSize", it.preferred_size),
                    ("maxSize", it.max_size),
                ] {
                    if v < 0.0 {
                        return Err(AppError::bad_request(vec![format!(
                            "items.{i}.{f} must not be less than 0"
                        )]));
                    }
                }
                Ok(DefinitionValues {
                    quality_id: int4(&format!("items.{i}.qualityId"), &it.quality_id)?,
                    title: it.title,
                    sizes: [it.min_size, it.preferred_size, it.max_size],
                })
            })
            .collect()
    }
}
