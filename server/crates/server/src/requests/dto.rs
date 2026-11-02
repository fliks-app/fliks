//! Bodies and queries (`requests.md` routes table, rules 28-30): class-validator-shaped messages, 4.x coercions.
use crate::http::{
    AppError,
    validate::{Check, int_param, int4, object},
};
use fliks_domain::{
    external_id::MAX_NUMERIC_ID,
    media::{kind::MediaKind, query::js_number},
};
use serde_json::{Map, Value, json};

pub(crate) type Res<T> = Result<T, AppError>;

pub const STATUSES: [&str; 7] = [
    "pending",
    "approved",
    "declined",
    "processing",
    "available",
    "failed",
    "removed",
];
pub const KINDS: [&str; 2] = ["add", "delete"];

/// An optional field: absent, explicit `null` or a value (`PATCH` keeps absent, clears `null`).
#[derive(Debug, PartialEq)]
pub enum Field<T> {
    Absent,
    Null,
    Val(T),
}

impl<T: Copy> Field<T> {
    /// A value or `null` as `Some`, absent as `None`.
    pub fn touched(&self) -> Option<Option<T>> {
        match self {
            Self::Absent => None,
            Self::Null => Some(None),
            Self::Val(v) => Some(Some(*v)),
        }
    }
    pub fn value(&self) -> Option<T> {
        self.touched().flatten()
    }
}

/// An optional integer field: absent, `null` or a value.
fn opt_int(c: &mut Check, key: &str, coerced: bool) -> Field<i32> {
    match c.o.get(key) {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(v) => c
            .int(key, v, coerced, None, None)
            .map_or(Field::Absent, Field::Val),
    }
}

#[derive(Debug)]
pub struct CreateRequest {
    pub media_type: MediaKind,
    pub delete: bool,
    pub tmdb_id: i32,
    pub title: String,
    pub seasons: Option<Vec<i64>>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_id: Option<i32>,
    pub folder_id: Option<i32>,
}

impl CreateRequest {
    pub fn key(&self) -> super::TitleKey {
        super::TitleKey::tmdb(self.media_type, self.tmdb_id)
    }
}

pub fn create_request(v: Value) -> Res<CreateRequest> {
    let o = object(v);
    let mut c = Check::new(
        &o,
        &[
            "mediaType",
            "kind",
            "tmdbId",
            "title",
            "seasons",
            "qualityProfileId",
            "languageProfileId",
            "libraryId",
            "folderId",
        ],
        "",
    );
    let media_type = c.kind("mediaType", false);
    if media_type.is_some_and(|m| !m.is_video()) {
        c.err("mediaType", "must be movie or series");
    }
    let kind = c.one_of("kind", &KINDS, true);
    // `media_external_ids` and `requests` hold nine digits at most
    let tmdb_id = match o.get("tmdbId") {
        Some(v)
            if v.as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n > f64::from(MAX_NUMERIC_ID)) =>
        {
            c.err(
                "tmdbId",
                &format!("must not be greater than {MAX_NUMERIC_ID}"),
            );
            None
        }
        v => c.int("tmdbId", v.unwrap_or(&Value::Null), false, Some(1), None),
    };
    if !o.get("title").is_some_and(Value::is_string) {
        c.err("title", "must be a string");
    }
    let seasons = c.int_array("seasons", true);
    let quality = opt_int(&mut c, "qualityProfileId", true);
    let language = opt_int(&mut c, "languageProfileId", true);
    let library = opt_int(&mut c, "libraryId", true);
    let folder = opt_int(&mut c, "folderId", true);
    let title = o
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let (Some(media_type), Some(tmdb_id)) = (media_type, tmdb_id) else {
        return Err(AppError::bad_request(c.errs));
    };
    c.finish(CreateRequest {
        media_type,
        delete: kind.as_deref() == Some("delete"),
        tmdb_id,
        title,
        seasons,
        quality_profile_id: quality.value(),
        language_profile_id: language.value(),
        library_id: library.value(),
        folder_id: folder.value(),
    })
}

#[derive(Debug)]
pub struct UpdateRequest {
    pub quality_profile_id: Field<i32>,
    pub language_profile_id: Field<i32>,
    pub library_id: Field<i32>,
}

pub fn update_request(v: Value) -> Res<UpdateRequest> {
    let o = object(v);
    let mut c = Check::new(
        &o,
        &["qualityProfileId", "languageProfileId", "libraryId"],
        "",
    );
    let u = UpdateRequest {
        quality_profile_id: opt_int(&mut c, "qualityProfileId", true),
        language_profile_id: opt_int(&mut c, "languageProfileId", true),
        library_id: opt_int(&mut c, "libraryId", true),
    };
    c.finish(u)
}

/// `reason` of a decline: `@IsOptional @IsString @MaxLength(2000)`.
pub fn decline(v: Value) -> Res<Option<String>> {
    let o = object(v);
    let mut c = Check::new(&o, &["reason"], "");
    let reason = c.get("reason").and_then(|r| match r.as_str() {
        Some(s) if s.chars().count() <= 2000 => Some(s.to_owned()),
        Some(_) => {
            c.err("reason", "must be shorter than or equal to 2000 characters");
            None
        }
        None => {
            c.err("reason", "must be shorter than or equal to 2000 characters");
            c.err("reason", "must be a string");
            None
        }
    });
    c.finish(reason)
}

/// `message` of a comment: `@IsString @MinLength(1)`.
pub fn comment(v: Value) -> Res<String> {
    let o = object(v);
    let mut c = Check::new(&o, &["message"], "");
    let m = match o.get("message") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::String(_)) => {
            c.err("message", "must be longer than or equal to 1 characters");
            String::new()
        }
        _ => {
            c.err("message", "must be longer than or equal to 1 characters");
            c.err("message", "must be a string");
            String::new()
        }
    };
    c.finish(m)
}

#[derive(Debug, Default)]
pub struct List {
    pub status: Option<String>,
    pub kind: Option<String>,
    pub user_id: Option<i32>,
    pub tmdb_id: Option<i32>,
    pub media_type: Option<MediaKind>,
    pub page: i64,
    pub limit: i64,
}

/// `ListRequestsDto`: a repeated key is an array, which every validator rejects.
pub fn list(q: &[(String, String)]) -> Res<List> {
    const KNOWN: [&str; 7] = [
        "status",
        "kind",
        "userId",
        "tmdbId",
        "mediaType",
        "page",
        "limit",
    ];
    let mut errs: Vec<String> = vec![];
    for (k, _) in q {
        let msg = format!("property {k} should not exist");
        if !KNOWN.contains(&k.as_str()) && !errs.contains(&msg) {
            errs.push(msg);
        }
    }
    let all = |k: &str| {
        q.iter()
            .filter(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
            .collect::<Vec<_>>()
    };
    let mut text = |k: &str, allowed: &[&str]| -> Option<String> {
        match all(k).as_slice() {
            [] => None,
            [v] if allowed.contains(v) => Some((*v).to_owned()),
            _ => {
                errs.push(format!(
                    "{k} must be one of the following values: {}",
                    allowed.join(", ")
                ));
                None
            }
        }
    };
    let status = text("status", &STATUSES);
    let kind = text("kind", &KINDS);
    let media_type = text("mediaType", &MediaKind::NAMES).and_then(|m| MediaKind::parse(&m));
    let mut int = |k: &str, min: Option<i32>, max: Option<i32>| -> Option<i32> {
        let one = match all(k).as_slice() {
            [] => return None,
            [v] => js_number(v),
            _ => None,
        };
        if let Some(m) = max
            && one.is_none_or(|n| n > f64::from(m))
        {
            errs.push(format!("{k} must not be greater than {m}"));
        }
        if let Some(m) = min
            && one.is_none_or(|n| n < f64::from(m))
        {
            errs.push(format!("{k} must not be less than {m}"));
        }
        match one.and_then(int4) {
            Some(i) => Some(i),
            None => {
                errs.push(format!("{k} must be an integer number"));
                None
            }
        }
    };
    let user_id = int("userId", None, None);
    let tmdb_id = int("tmdbId", None, None);
    let page = int("page", Some(1), None);
    let limit = int("limit", Some(1), Some(500));
    if !errs.is_empty() {
        return Err(AppError::bad_request(errs));
    }
    Ok(List {
        status,
        kind,
        user_id,
        tmdb_id,
        media_type,
        page: i64::from(page.unwrap_or(1)),
        limit: i64::from(limit.unwrap_or(25)),
    })
}

/// The `tmdbId` and `mediaType` of `title-state` (canonical integers; the enum is validated here).
pub fn title_state(q: &[(String, String)]) -> Res<(i32, MediaKind)> {
    let one = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let tmdb =
        int_param(one("tmdbId").ok_or_else(|| {
            AppError::bad_request("Validation failed (numeric string is expected)")
        })?)?;
    match one("mediaType").and_then(MediaKind::parse) {
        Some(m) if m.is_video() => Ok((tmdb, m)),
        _ => Err(AppError::bad_request(vec![format!(
            "mediaType {}",
            MediaKind::one_of_message()
        )])),
    }
}

#[derive(Debug)]
pub struct Rule {
    pub name: String,
    pub enabled: bool,
    pub criteria: Value,
}

/// `CreateAutoApprovalRuleDto` (rule 30); criteria keys of rule 28, nulls kept as 4.x stored them.
pub fn rule(v: Value) -> Res<Rule> {
    let o = object(v);
    let mut c = Check::new(&o, &["name", "enabled", "criteria"], "");
    let name = o.get("name").map(|n| match n {
        Value::String(s) => Value::String(s.trim().to_owned()),
        other => other.clone(),
    });
    let name = match name {
        Some(Value::String(s)) if !s.is_empty() => s,
        Some(Value::String(_)) | None | Some(Value::Null) => {
            c.err("name", "should not be empty");
            if !o.get("name").is_some_and(Value::is_string) {
                c.err("name", "must be a string");
            }
            String::new()
        }
        Some(_) => {
            c.err("name", "must be a string");
            String::new()
        }
    };
    let enabled = match o.get("enabled") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            c.err("enabled", "must be a boolean value");
            true
        }
    };
    let criteria = match o.get("criteria") {
        Some(Value::Object(k)) => criteria(k, &mut c.errs),
        None | Some(Value::Null) => {
            c.err("criteria", "should not be null or undefined");
            if o.contains_key("criteria") {
                c.err(
                    "criteria",
                    "nested property criteria must be either object or array",
                );
            }
            json!({})
        }
        Some(_) => {
            c.err(
                "criteria",
                "nested property criteria must be either object or array",
            );
            json!({})
        }
    };
    c.finish(Rule {
        name,
        enabled,
        criteria,
    })
}

const CRITERIA_KEYS: [&str; 8] = [
    "userIds",
    "roleIds",
    "mediaType",
    "libraryIds",
    "genreIds",
    "maxSeasons",
    "yearFrom",
    "yearTo",
];

fn criteria(k: &Map<String, Value>, errs: &mut Vec<String>) -> Value {
    let mut c = Check::new(k, &CRITERIA_KEYS, "criteria.");
    let mut out = Map::new();
    for key in CRITERIA_KEYS {
        match (key, k.get(key)) {
            (_, None) => {}
            (_, Some(Value::Null)) => {
                out.insert(key.into(), Value::Null);
            }
            ("mediaType", Some(_)) => {
                if let Some(m) = c.one_of(key, &MediaKind::NAMES, true) {
                    out.insert(key.into(), m.into());
                }
            }
            ("maxSeasons", Some(v)) => {
                if let Some(i) = c.int(key, v, false, Some(1), None) {
                    out.insert(key.into(), i.into());
                }
            }
            ("yearFrom" | "yearTo", Some(v)) => {
                if let Some(i) = c.int(key, v, false, Some(1900), Some(2200)) {
                    out.insert(key.into(), i.into());
                }
            }
            (_, Some(_)) => {
                if let Some(a) = c.int_array(key, false) {
                    out.insert(key.into(), json!(a));
                }
            }
        }
    }
    errs.extend(c.errs);
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(r: Res<impl std::fmt::Debug>) -> Value {
        use axum::response::IntoResponse;
        let e = r.expect_err("accepted");
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let body: Value = rt.block_on(async {
            let b = axum::body::to_bytes(e.into_response().into_body(), usize::MAX)
                .await
                .unwrap();
            serde_json::from_slice(&b).unwrap()
        });
        body["message"].clone()
    }

    #[test]
    fn create_messages_follow_nest() {
        assert_eq!(
            msgs(create_request(json!({}))),
            json!([
                "mediaType must be one of the following values: movie, series, book",
                "tmdbId must not be less than 1",
                "tmdbId must be an integer number",
                "title must be a string"
            ])
        );
        assert_eq!(
            msgs(create_request(
                json!({"mediaType":"movie","tmdbId":"5","title":"t","extra":1})
            )),
            json!([
                "property extra should not exist",
                "tmdbId must not be less than 1",
                "tmdbId must be an integer number"
            ])
        );
    }

    #[test]
    fn create_coerces_numeric_strings_and_keeps_null_as_absent() {
        let c = create_request(json!({
            "mediaType":"series","tmdbId":7,"title":"","seasons":["2",3],
            "libraryId":"4","qualityProfileId":null
        }))
        .unwrap();
        assert_eq!(c.seasons, Some(vec![2, 3]));
        assert_eq!((c.library_id, c.quality_profile_id), (Some(4), None));
    }

    #[test]
    fn update_tells_null_from_absent() {
        let u = update_request(json!({"libraryId":null,"qualityProfileId":"7"})).unwrap();
        assert_eq!(u.library_id, Field::Null);
        assert_eq!(u.quality_profile_id, Field::Val(7));
        assert_eq!(u.language_profile_id, Field::Absent);
    }

    #[test]
    fn list_defaults_and_bounds() {
        let q = |s: &[(&str, &str)]| -> Vec<(String, String)> {
            s.iter().map(|(a, b)| ((*a).into(), (*b).into())).collect()
        };
        let l = list(&q(&[("status", "pending")])).unwrap();
        assert_eq!((l.page, l.limit), (1, 25));
        assert_eq!(
            msgs(list(&q(&[
                ("page", "0"),
                ("limit", "501"),
                ("foo", "1"),
                ("userId", "x")
            ]))),
            json!([
                "property foo should not exist",
                "userId must be an integer number",
                "page must not be less than 1",
                "limit must not be greater than 500"
            ])
        );
    }

    #[test]
    fn rule_whitelists_criteria() {
        assert_eq!(
            msgs(rule(
                json!({"name":"  ","criteria":{"yearFrom":5,"foo":1,"userIds":["a"]}})
            )),
            json!([
                "name should not be empty",
                "criteria.property foo should not exist",
                "criteria.each value in userIds must be an integer number",
                "criteria.yearFrom must not be less than 1900"
            ])
        );
        let r = rule(json!({"name":" t ","criteria":{"userIds":[1.0],"mediaType":null}})).unwrap();
        assert_eq!(
            (r.name.as_str(), r.enabled, r.criteria),
            ("t", true, json!({"userIds":[1],"mediaType":null}))
        );
        assert_eq!(
            msgs(rule(json!({"name":"x"}))),
            json!(["criteria should not be null or undefined"])
        );
    }

    #[test]
    fn title_state_validates_both() {
        let q = |s: &[(&str, &str)]| -> Vec<(String, String)> {
            s.iter().map(|(a, b)| ((*a).into(), (*b).into())).collect()
        };
        assert_eq!(
            title_state(&q(&[("tmdbId", "9"), ("mediaType", "movie")])).unwrap(),
            (9, MediaKind::Movie)
        );
        assert!(title_state(&q(&[("tmdbId", "09"), ("mediaType", "movie")])).is_err());
        assert!(title_state(&q(&[("tmdbId", "9"), ("mediaType", "x")])).is_err());
    }
}
