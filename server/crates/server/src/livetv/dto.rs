//! Body and query checks with class-validator's messages (`auth.md` rule 16): every failing rule of
//! every field, unknown keys first, `IsOptional` letting `null` through.
use crate::http::AppError;
use fliks_domain::media::query::js_number;
use serde_json::{Map, Value};

/// A field of a body: missing, `null` (which `IsOptional` lets through) or a checked value.
#[derive(Debug, Clone, PartialEq)]
pub enum Opt<T> {
    Absent,
    Null,
    Val(T),
}

impl<T> Opt<T> {
    pub fn val(self) -> Option<T> {
        match self {
            Self::Val(v) => Some(v),
            _ => None,
        }
    }

    pub fn present(&self) -> bool {
        !matches!(self, Self::Absent)
    }
}

pub struct Body<'a> {
    obj: &'a Map<String, Value>,
    pub errors: Vec<String>,
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

impl<'a> Body<'a> {
    /// `forbidNonWhitelisted`: any key outside `known` is reported first.
    pub fn new(v: &'a Value, known: &[&str]) -> Self {
        let obj = v.as_object().unwrap_or(&EMPTY);
        let errors = obj
            .keys()
            .filter(|k| !known.contains(&k.as_str()))
            .map(|k| format!("property {k} should not exist"))
            .collect();
        Self { obj, errors }
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.obj.get(key)
    }

    fn fail(&mut self, msg: String) {
        self.errors.push(msg);
    }

    /// `@IsString()` without `IsOptional`.
    pub fn string(&mut self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => {
                self.fail(format!("{key} must be a string"));
                None
            }
        }
    }

    /// `@IsOptional() @IsString()`.
    pub fn opt_string(&mut self, key: &str) -> Opt<String> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(Value::String(s)) => Opt::Val(s.clone()),
            Some(_) => {
                self.fail(format!("{key} must be a string"));
                Opt::Absent
            }
        }
    }

    /// `@IsOptional() @IsBoolean()`.
    pub fn opt_bool(&mut self, key: &str) -> Opt<bool> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(Value::Bool(b)) => Opt::Val(*b),
            Some(_) => {
                self.fail(format!("{key} must be a boolean value"));
                Opt::Absent
            }
        }
    }

    /// `@IsOptional() @IsInt() [@Min(min)]`: both messages for a value that is no number, `Min` first.
    pub fn opt_int(&mut self, key: &str, min: Option<i64>) -> Opt<i64> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(v) => self.int_of(key, v, min).map_or(Opt::Absent, Opt::Val),
        }
    }

    /// `@IsInt() [@Min]` without `IsOptional`.
    pub fn int(&mut self, key: &str, min: Option<i64>) -> Option<i64> {
        match self.get(key) {
            Some(v) => self.int_of(key, v, min),
            None => {
                if let Some(m) = min {
                    self.fail(format!("{key} must not be less than {m}"));
                }
                self.fail(format!("{key} must be an integer number"));
                None
            }
        }
    }

    fn int_of(&mut self, key: &str, v: &Value, min: Option<i64>) -> Option<i64> {
        let n = v.as_f64().filter(|_| v.is_number());
        let whole = n.filter(|n| n.fract() == 0.0);
        if let Some(m) = min
            && n.is_none_or(|n| n < m as f64)
        {
            self.fail(format!("{key} must not be less than {m}"));
        }
        if whole.is_none() {
            self.fail(format!("{key} must be an integer number"));
        }
        // Beyond i64 nothing is stored: it saturates, the range checks of the caller refuse it.
        whole.map(|n| n.clamp(i64::MIN as f64, i64::MAX as f64) as i64)
    }

    /// `@IsIn(values)`.
    pub fn one_of(&mut self, key: &str, values: &[&str]) -> Option<String> {
        match self
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| values.contains(s))
        {
            Some(s) => Some(s.to_owned()),
            None => {
                self.fail(format!(
                    "{key} must be one of the following values: {}",
                    values.join(", ")
                ));
                None
            }
        }
    }

    /// `@IsOptional() @IsIn(values)`.
    pub fn opt_one_of(&mut self, key: &str, values: &[&str]) -> Opt<String> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(_) => self.one_of(key, values).map_or(Opt::Absent, Opt::Val),
        }
    }

    /// A URL the DTO accepts: `@IsUrl({require_tld: false, require_protocol: true})`.
    pub fn url(&mut self, key: &str, ok: impl Fn(&str) -> bool) -> Option<String> {
        match self.get(key).and_then(Value::as_str).filter(|s| ok(s)) {
            Some(s) => Some(s.to_owned()),
            None => {
                self.fail(format!("{key} must be a URL address"));
                None
            }
        }
    }

    /// `@IsOptional() @IsUrl(..)`.
    pub fn opt_url(&mut self, key: &str, ok: impl Fn(&str) -> bool) -> Opt<String> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(_) => self.url(key, ok).map_or(Opt::Absent, Opt::Val),
        }
    }

    /// `@IsArray() @ArrayMaxSize(max) @IsString({each}) @MaxLength(len, {each})`.
    pub fn strings(&mut self, key: &str, max: usize, len: usize) -> Option<Vec<String>> {
        let Some(Value::Array(a)) = self.get(key) else {
            self.fail(format!("{key} must be an array"));
            return None;
        };
        let mut out = vec![];
        if a.len() > max {
            self.fail(format!("{key} must contain no more than {max} elements"));
        }
        let mut not_string = false;
        let mut too_long = false;
        for v in a {
            match v.as_str() {
                Some(s) => {
                    too_long |= s.encode_utf16().count() > len;
                    out.push(s.to_owned());
                }
                None => {
                    not_string = true;
                    too_long = true;
                }
            }
        }
        if too_long {
            self.fail(format!(
                "each value in {key} must be shorter than or equal to {len} characters"
            ));
        }
        if not_string {
            self.fail(format!("each value in {key} must be a string"));
        }
        Some(out)
    }

    /// `@IsOptional() @IsArray() @ArrayNotEmpty() @IsInt({each})`.
    pub fn opt_int_list(&mut self, key: &str) -> Opt<Vec<i64>> {
        match self.get(key) {
            None => Opt::Absent,
            Some(Value::Null) => Opt::Null,
            Some(_) => self.int_list(key).map_or(Opt::Absent, Opt::Val),
        }
    }

    /// `@IsArray() @ArrayNotEmpty() @IsInt({each})`.
    pub fn int_list(&mut self, key: &str) -> Option<Vec<i64>> {
        let Some(Value::Array(a)) = self.get(key) else {
            self.fail(format!("{key} should not be empty"));
            self.fail(format!("{key} must be an array"));
            return None;
        };
        if a.is_empty() {
            self.fail(format!("{key} should not be empty"));
        }
        let ints: Vec<Option<i64>> = a
            .iter()
            .map(|v| {
                v.as_f64()
                    .filter(|n| v.is_number() && n.fract() == 0.0)
                    .map(|n| n as i64)
            })
            .collect();
        if ints.iter().any(Option::is_none) {
            self.fail(format!("each value in {key} must be an integer number"));
        }
        Some(ints.into_iter().flatten().collect())
    }

    /// The caller's own message, for a rule no decorator covers.
    pub fn reject(&mut self, msg: impl Into<String>) {
        self.errors.push(msg.into());
    }

    pub fn finish(self) -> Result<(), AppError> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::bad_request(self.errors))
        }
    }
}

/// A query string as the global pipe reads it: repeated keys are arrays (invalid for a scalar), values are text.
pub struct Query<'a>(pub &'a [(String, String)]);

impl Query<'_> {
    pub fn get(&self, key: &str) -> Option<&str> {
        let mut it = self.0.iter().filter(|(k, _)| k == key);
        match (it.next(), it.next()) {
            (Some((_, v)), None) => Some(v),
            _ => None,
        }
    }

    pub fn known(&self, allowed: &[&str]) -> Vec<String> {
        self.0
            .iter()
            .filter(|(k, _)| !allowed.contains(&k.as_str()))
            .map(|(k, _)| format!("property {k} should not exist"))
            .collect()
    }
}

/// `@Type(() => Number) @IsInt() [@Min] [@Max]` on a query value: the text is `Number()`ed first.
pub fn query_int(
    errors: &mut Vec<String>,
    key: &str,
    raw: Option<&str>,
    min: Option<i64>,
    max: Option<i64>,
) -> Option<i64> {
    let raw = raw?;
    let n = js_number(raw);
    let whole = n.filter(|n| n.is_finite() && n.fract() == 0.0);
    if let Some(m) = max
        && n.is_none_or(|n| n > m as f64 || n.is_nan())
    {
        errors.push(format!("{key} must not be greater than {m}"));
    }
    if let Some(m) = min
        && n.is_none_or(|n| n < m as f64 || n.is_nan())
    {
        errors.push(format!("{key} must not be less than {m}"));
    }
    if whole.is_none() {
        errors.push(format!("{key} must be an integer number"));
    }
    whole.map(|n| n.clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

/// `@Transform(({value}) => value === 'true' || value === true)` on a query flag: only `true` is true.
pub fn query_flag(raw: Option<&str>) -> bool {
    raw == Some("true")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_follow_class_validator() {
        let v = json!({"name": 1, "kind": "x", "maxStreams": "5", "enabled": "y", "extra": 1, "refreshIntervalHours": 0});
        let mut b = Body::new(
            &v,
            &[
                "name",
                "kind",
                "maxStreams",
                "enabled",
                "refreshIntervalHours",
            ],
        );
        b.string("name");
        b.one_of("kind", &["m3u", "xtream"]);
        b.opt_int("maxStreams", Some(0));
        b.opt_bool("enabled");
        b.opt_int("refreshIntervalHours", Some(1));
        b.string("url");
        assert_eq!(
            b.errors,
            [
                "property extra should not exist",
                "name must be a string",
                "kind must be one of the following values: m3u, xtream",
                "maxStreams must not be less than 0",
                "maxStreams must be an integer number",
                "enabled must be a boolean value",
                "refreshIntervalHours must not be less than 1",
                "url must be a string",
            ]
        );
    }

    #[test]
    fn null_passes_an_optional_field_and_integers_may_print_as_floats() {
        let v = json!({"a": null, "b": 5.0, "c": 1.5});
        let mut b = Body::new(&v, &["a", "b", "c"]);
        assert_eq!(b.opt_string("a"), Opt::Null);
        assert_eq!(b.opt_int("b", None), Opt::Val(5));
        assert_eq!(b.opt_int("c", None), Opt::Absent);
        assert_eq!(b.errors, ["c must be an integer number"]);
    }

    #[test]
    fn string_lists_report_each_rule_once() {
        let v = json!({"groups": ["ok", 1, "x"]});
        let mut b = Body::new(&v, &["groups"]);
        assert_eq!(b.strings("groups", 500, 255).unwrap().len(), 2);
        assert_eq!(
            b.errors,
            [
                "each value in groups must be shorter than or equal to 255 characters",
                "each value in groups must be a string"
            ]
        );
        let v = json!({"groups": "x"});
        let mut b = Body::new(&v, &["groups"]);
        assert!(b.strings("groups", 500, 255).is_none());
        assert_eq!(b.errors, ["groups must be an array"]);
    }

    #[test]
    fn query_numbers_are_converted_like_number() {
        let mut e = vec![];
        assert_eq!(query_int(&mut e, "page", Some("3"), Some(1), None), Some(3));
        assert_eq!(
            query_int(&mut e, "page", Some("0x10"), Some(1), None),
            Some(16)
        );
        assert_eq!(query_int(&mut e, "page", Some(""), Some(1), None), Some(0));
        assert!(e.len() == 1 && e[0].contains("must not be less than 1"));
        let mut e = vec![];
        assert_eq!(
            query_int(&mut e, "pageSize", Some("51"), Some(1), Some(50)),
            Some(51)
        );
        assert_eq!(e, ["pageSize must not be greater than 50"]);
        let mut e = vec![];
        assert_eq!(query_int(&mut e, "page", Some("x"), Some(1), None), None);
        assert_eq!(
            e,
            [
                "page must not be less than 1",
                "page must be an integer number"
            ]
        );
        assert!(query_flag(Some("true")) && !query_flag(Some("1")) && !query_flag(None));
    }
}
