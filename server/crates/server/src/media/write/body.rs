//! class-validator style checks on a JSON body read as a map: absent = `None`, `null` = `Some(None)`
//! (`@IsOptional` lets `null` through), messages as the global pipe words them.
use crate::http::AppError;
use serde_json::{Map, Value};

pub type Field<T> = Option<Option<T>>;

pub struct Body(pub Map<String, Value>, pub String);

fn bad(msg: String) -> AppError {
    AppError::bad_request(vec![msg])
}

impl Body {
    pub fn new(v: Value, allowed: &[&str]) -> Result<Self, AppError> {
        Self::nested(v, allowed, "")
    }

    /// A nested DTO: messages name `<prefix><key>` (`items.0.libraryId`).
    pub fn nested(v: Value, allowed: &[&str], prefix: &str) -> Result<Self, AppError> {
        let Value::Object(m) = v else {
            return Ok(Self(Map::new(), prefix.to_owned()));
        };
        let unknown: Vec<String> = m
            .keys()
            .filter(|k| !allowed.contains(&k.as_str()))
            .map(|k| format!("property {prefix}{k} should not exist"))
            .collect();
        if !unknown.is_empty() {
            return Err(AppError::bad_request(unknown));
        }
        Ok(Self(m, prefix.to_owned()))
    }

    pub fn has(&self, k: &str) -> bool {
        self.0.contains_key(k)
    }

    fn get<T>(
        &self,
        k: &str,
        f: impl Fn(&Value) -> Option<T>,
        msg: &str,
    ) -> Result<Field<T>, AppError> {
        match self.0.get(k) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(v) => f(v)
                .map(|t| Some(Some(t)))
                .ok_or_else(|| bad(format!("{}{k} {msg}", self.1))),
        }
    }

    pub fn str(&self, k: &str) -> Result<Field<String>, AppError> {
        self.get(k, |v| v.as_str().map(str::to_owned), "must be a string")
    }

    pub fn num(&self, k: &str) -> Result<Field<f64>, AppError> {
        self.get(
            k,
            Value::as_f64,
            "must be a number conforming to the specified constraints",
        )
    }

    /// `@IsNumber` on an int4 column: a non-integer or out-of-range value is a 400, never a 500.
    pub fn int(&self, k: &str) -> Result<Field<i32>, AppError> {
        let n = self.num(k)?;
        n.map(|o| {
            o.map(|n| {
                (n.fract() == 0.0 && n >= f64::from(i32::MIN) && n <= f64::from(i32::MAX))
                    .then_some(n as i32)
                    .ok_or_else(|| bad(format!("{}{k} must be an integer number", self.1)))
            })
            .transpose()
        })
        .transpose()
    }

    /// `@Type(() => Number) @IsInt @Min(1)`: numeric strings are coerced first.
    pub fn id(&self, k: &str) -> Result<Field<i32>, AppError> {
        let coerced = match self.0.get(k) {
            Some(Value::String(s)) => fliks_domain::media::query::js_number(s).map(Value::from),
            v => v.cloned(),
        };
        let v = match coerced {
            None if self.has(k) => {
                return Err(bad(format!("{}{k} must be an integer number", self.1)));
            }
            None => return Ok(None),
            Some(Value::Null) => return Ok(Some(None)),
            Some(v) => v,
        };
        let n = v.as_f64().filter(|n| n.fract() == 0.0 && n.is_finite());
        let Some(n) = n else {
            return Err(bad(format!("{}{k} must be an integer number", self.1)));
        };
        if n < 1.0 {
            return Err(bad(format!("{}{k} must not be less than 1", self.1)));
        }
        if n > f64::from(i32::MAX) {
            return Err(bad(format!("{}{k} must be an integer number", self.1)));
        }
        Ok(Some(Some(n as i32)))
    }

    pub fn bool(&self, k: &str) -> Result<Field<bool>, AppError> {
        self.get(k, Value::as_bool, "must be a boolean value")
    }

    pub fn one_of(&self, k: &str, values: &[&str]) -> Result<Field<String>, AppError> {
        let msg = format!("must be one of the following values: {}", values.join(", "));
        self.get(
            k,
            |v| v.as_str().filter(|s| values.contains(s)).map(str::to_owned),
            &msg,
        )
    }

    pub fn strings(&self, k: &str) -> Result<Field<Vec<String>>, AppError> {
        match self.0.get(k) {
            Some(Value::Array(a)) => a
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .map(|v| Some(Some(v)))
                .ok_or_else(|| bad(format!("each value in {}{k} must be a string", self.1))),
            Some(Value::Null) => Ok(Some(None)),
            None => Ok(None),
            Some(_) => Err(bad(format!("{}{k} must be an array", self.1))),
        }
    }

    pub fn date(&self, k: &str) -> Result<Field<String>, AppError> {
        self.get(
            k,
            |v| {
                v.as_str()
                    .filter(|s| fliks_domain::media::query::is_iso8601(s))
                    .map(str::to_owned)
            },
            "must be a valid ISO 8601 date string",
        )
    }

    /// A key the DTO requires: absent or `null` is `<k> should not be empty`-style per the check.
    pub fn required<T>(&self, f: Field<T>, k: &str, msg: &str) -> Result<T, AppError> {
        f.flatten()
            .ok_or_else(|| bad(format!("{}{k} {msg}", self.1)))
    }
}
