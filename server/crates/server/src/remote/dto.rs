//! Request bodies (`remote/dto/*.ts`); an optional field accepts `null` like `@IsOptional()`.
use crate::{
    events::{
        Num,
        event::{MediaKind, RemoteAction},
    },
    http::AppError,
};
use serde::{Deserialize, Deserializer};

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// JS `String.length` counts UTF-16 units.
fn too_long(field: &str, v: &str, max: usize) -> Option<String> {
    (v.encode_utf16().count() > max)
        .then(|| format!("{field} must be shorter than or equal to {max} characters"))
}

fn fail(errors: Vec<String>) -> Result<(), AppError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::bad_request(errors))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Register {
    pub device_id: String,
    pub name: Option<String>,
    pub form_factor: Option<String>,
}

impl Register {
    pub fn validate(&self) -> Result<(), AppError> {
        let opt = |f, v: &Option<String>, max| v.as_deref().and_then(|v| too_long(f, v, max));
        fail(
            [
                too_long("deviceId", &self.device_id, 128),
                opt("name", &self.name, 128),
                opt("formFactor", &self.form_factor, 32),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateCode {
    pub device_id: String,
    pub device_name: String,
}

impl CreateCode {
    pub fn validate(&self) -> Result<(), AppError> {
        fail(
            [
                too_long("deviceId", &self.device_id, 128),
                too_long("deviceName", &self.device_name, 80),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub code: String,
}

impl Claim {
    pub fn validate(&self) -> Result<(), AppError> {
        match self.code.encode_utf16().count() {
            4..=12 => Ok(()),
            _ => fail(vec![
                "code must be longer than or equal to 4 characters".into(),
            ]),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Command {
    pub action: RemoteAction,
    pub media_id: Option<i64>,
    pub media_type: Option<MediaKind>,
    pub media_file_id: Option<i64>,
    pub episode_id: Option<i64>,
    pub position_seconds: Option<Num>,
    pub level: Option<Num>,
    pub muted: Option<bool>,
    pub track_id: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub subtitle_id: Option<Option<String>>,
    pub quality_id: Option<String>,
    pub by_target_id: Option<String>,
}

impl Command {
    pub fn validate(&self) -> Result<(), AppError> {
        let mut e = vec![];
        if self.position_seconds.is_some_and(|n| n.0 < 0.0) {
            e.push("positionSeconds must not be less than 0".to_owned());
        }
        match self.level {
            Some(n) if n.0 < 0.0 => e.push("level must not be less than 0".into()),
            Some(n) if n.0 > 1.0 => e.push("level must not be greater than 1".into()),
            _ => {}
        }
        fail(e)
    }
}
