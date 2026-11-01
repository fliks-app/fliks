//! Request bodies. `null` on a non-nullable field is a 400.
use crate::http::AppError;
use fliks_domain::media::kind::MediaKind;
use serde::{Deserialize, Deserializer};

/// `Some(v)` for a present non-null value; `null` is a type error.
fn non_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Distinguishes absent (`None`) from `null` (`Some(None)`).
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateUser {
    pub username: String,
    pub password: String,
    #[serde(default, deserialize_with = "nullable")]
    pub email: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub role_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "non_null")]
    pub is_admin: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub library_ids: Option<Vec<i32>>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateUser {
    #[serde(default, deserialize_with = "non_null")]
    pub username: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub email: Option<Option<String>>,
    #[serde(default, deserialize_with = "non_null")]
    pub password: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub role_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "non_null")]
    pub is_admin: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub require_password_change: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub movie_quota_limit: Option<i32>,
    #[serde(default, deserialize_with = "non_null")]
    pub series_quota_limit: Option<i32>,
    #[serde(default, deserialize_with = "non_null")]
    pub book_quota_limit: Option<i32>,
    #[serde(default, deserialize_with = "non_null")]
    pub quota_period_days: Option<i32>,
    #[serde(default, deserialize_with = "non_null")]
    pub library_ids: Option<Vec<i32>>,
    #[serde(default, deserialize_with = "non_null")]
    pub library_order: Option<Vec<i32>>,
    #[serde(default, deserialize_with = "non_null")]
    pub hidden_library_ids: Option<Vec<i32>>,
    #[serde(default, deserialize_with = "non_null")]
    pub profile_visibility: Option<String>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_tastes: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_recommendations: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_watch_history: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_likes: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_stats: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub share_disabled: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub hide_spoilers: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub edl_enabled: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub edl_auto_skip_commercials: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub spoiler_hide_stills: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub spoiler_hide_overviews: Option<bool>,
    #[serde(default, deserialize_with = "non_null")]
    pub spoiler_hide_titles: Option<bool>,
}

/// Email check: one `@`, a dotted domain, no whitespace.
fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !s.contains(char::is_whitespace)
        && !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

fn check_all(rules: Vec<(bool, &str)>) -> Result<(), AppError> {
    let msgs: Vec<&str> = rules.into_iter().filter(|r| !r.0).map(|r| r.1).collect();
    if msgs.is_empty() {
        Ok(())
    } else {
        Err(AppError::bad_request(msgs))
    }
}

const EMAIL: &str = "email must be an email";
const PASSWORD: &str = "password must be longer than or equal to 8 characters";

impl CreateUser {
    pub fn validate(&self) -> Result<(), AppError> {
        check_all(vec![
            (self.password.chars().count() >= 8, PASSWORD),
            (
                self.email
                    .as_ref()
                    .and_then(|e| e.as_deref())
                    .is_none_or(is_email),
                EMAIL,
            ),
        ])
    }
}

impl UpdateUser {
    pub fn validate(&self) -> Result<(), AppError> {
        let ge = |v: Option<i32>, min| v.is_none_or(|v| v >= min);
        check_all(vec![
            (
                self.email
                    .as_ref()
                    .and_then(|e| e.as_deref())
                    .is_none_or(is_email),
                EMAIL,
            ),
            (
                self.password
                    .as_ref()
                    .is_none_or(|p| p.chars().count() >= 8),
                PASSWORD,
            ),
            (
                ge(self.movie_quota_limit, 0),
                "movieQuotaLimit must not be less than 0",
            ),
            (
                ge(self.series_quota_limit, 0),
                "seriesQuotaLimit must not be less than 0",
            ),
            (
                ge(self.book_quota_limit, 0),
                "bookQuotaLimit must not be less than 0",
            ),
            (
                ge(self.quota_period_days, 1),
                "quotaPeriodDays must not be less than 1",
            ),
            (
                self.library_ids.as_ref().is_none_or(|v| !v.contains(&0)),
                "libraryIds should not contain 0 values",
            ),
            (
                self.profile_visibility
                    .as_deref()
                    .is_none_or(|v| v == "public" || v == "private"),
                "profileVisibility must be one of the following values: public, private",
            ),
        ])
    }

    /// The quota limit sent for `kind`.
    pub fn quota_limit(&self, kind: MediaKind) -> Option<i32> {
        match kind {
            MediaKind::Movie => self.movie_quota_limit,
            MediaKind::Series => self.series_quota_limit,
            MediaKind::Book => self.book_quota_limit,
        }
    }

    /// Fields only `users.manage` may send (rule 14).
    pub fn has_managed_field(&self) -> bool {
        self.role_id.is_some()
            || self.is_admin.is_some()
            || self.enabled.is_some()
            || self.require_password_change.is_some()
    }
}
