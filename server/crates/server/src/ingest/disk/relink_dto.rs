//! The relink request body: its fields and their validation.
use super::*;

pub struct RelinkFile {
    pub(super) path: String,
    pub(super) season: Option<i32>,
    pub(super) episode: Option<i32>,
    pub(super) end: Option<i32>,
}

pub struct RelinkDto {
    pub(super) library_id: i32,
    pub(super) media_type: String,
    pub(super) external_id: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) title: Option<String>,
    pub(super) year: Option<i32>,
    pub(super) quality_profile_id: Option<i32>,
    pub(super) language_profile_id: Option<i32>,
    pub(super) folder_name: String,
    pub(super) scan_root: Option<String>,
    pub(super) reorganize: bool,
    pub(super) transfer: Option<Method>,
    pub(super) files: Vec<RelinkFile>,
}

pub(super) const RELINK_FIELDS: [&str; 13] = [
    "libraryId",
    "type",
    "externalId",
    "provider",
    "title",
    "year",
    "qualityProfileId",
    "languageProfileId",
    "folderName",
    "scanRoot",
    "reorganize",
    "transfer",
    "files",
];

/// `@Type(() => Number) @IsInt @Min(0)` on the file numbering.
pub(super) fn non_negative(b: &Body, k: &str) -> Result<Option<i32>, AppError> {
    match b.0.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = match v {
                Value::String(s) => fliks_domain::media::query::js_number(s),
                v => v.as_f64(),
            };
            n.filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(i32::MAX))
                .map(|n| Some(n as i32))
                .ok_or_else(|| {
                    AppError::bad_request(vec![format!("{}{k} must not be less than 0", b.1)])
                })
        }
    }
}

/// `RelinkOrphansDto` (rule 72); `prefix` names a batch item.
pub(super) fn parse_relink(v: Value, prefix: &str) -> Result<RelinkDto, AppError> {
    let b = Body::nested(v, &RELINK_FIELDS, prefix)?;
    let library_id = b.required(b.id("libraryId")?, "libraryId", "must be an integer number")?;
    let media_type = b.required(
        b.one_of("type", &["movie", "series"])?,
        "type",
        "must be one of the following values: movie, series",
    )?;
    let title = b.str("title")?.flatten();
    if title.as_ref().is_some_and(|t| t.chars().count() > 255) {
        return Err(AppError::bad_request(vec![format!(
            "{prefix}title must be shorter than or equal to 255 characters"
        )]));
    }
    let year = match b.0.get("year") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = match v {
                Value::String(s) => fliks_domain::media::query::js_number(s),
                v => v.as_f64(),
            };
            Some(
                n.filter(|n| n.fract() == 0.0 && (1888.0..=2100.0).contains(n))
                    .map(|n| n as i32)
                    .ok_or_else(|| {
                        AppError::bad_request(vec![format!(
                            "{prefix}year must not be less than 1888"
                        )])
                    })?,
            )
        }
    };
    let transfer = b.one_of("transfer", &["copy", "move"])?.flatten().map(|t| {
        if t == "copy" {
            Method::Copy
        } else {
            Method::Move
        }
    });
    let files = match b.0.get("files") {
        Some(Value::Array(a)) if !a.is_empty() => a
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let fb = Body::nested(
                    f.clone(),
                    &["filePath", "seasonNumber", "episodeNumber", "episodeEnd"],
                    &format!("{prefix}files.{i}."),
                )?;
                let path = crate::libraries::sanitize_path(&fb.required(
                    fb.str("filePath")?,
                    "filePath",
                    "must be a string",
                )?);
                if !path.starts_with('/') {
                    return Err(AppError::bad_request(vec![format!(
                        "{prefix}files.{i}.filePath must be an absolute path"
                    )]));
                }
                Ok(RelinkFile {
                    path,
                    season: non_negative(&fb, "seasonNumber")?,
                    episode: non_negative(&fb, "episodeNumber")?,
                    end: non_negative(&fb, "episodeEnd")?,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?,
        Some(Value::Array(_)) => {
            return Err(AppError::bad_request(vec![format!(
                "{prefix}files should not be empty"
            )]));
        }
        _ => {
            return Err(AppError::bad_request(vec![format!(
                "{prefix}files must be an array"
            )]));
        }
    };
    Ok(RelinkDto {
        library_id,
        media_type,
        external_id: b.str("externalId")?.flatten(),
        provider: b.str("provider")?.flatten(),
        title,
        year,
        quality_profile_id: b.id("qualityProfileId")?.flatten(),
        language_profile_id: b.id("languageProfileId")?.flatten(),
        folder_name: b.required(b.str("folderName")?, "folderName", "must be a string")?,
        scan_root: b.str("scanRoot")?.flatten(),
        reorganize: b.bool("reorganize")?.flatten().unwrap_or(false),
        transfer,
        files,
    })
}

/// F48: moving files from outside the library is a library manager's action.
pub(super) fn check_transfer(a: &Authed, d: &RelinkDto) -> Result<(), AppError> {
    if d.transfer.is_some() {
        a.require(Action::Manage, Subject::Settings)?;
    }
    Ok(())
}
