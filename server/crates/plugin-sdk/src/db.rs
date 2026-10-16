//! Typed helpers over the `db` import: one statement per call, no transaction across calls.

use crate::bindings::fliks::plugin::db as raw;
pub use crate::bindings::fliks::plugin::db::{DbError, Migration, Param, RowSet, Value};

pub fn query(sql: &str, params: &[Param]) -> Result<Rows, DbError> {
    raw::query(sql, params).map(Rows)
}

pub fn execute(sql: &str, params: &[Param]) -> Result<u64, DbError> {
    raw::execute(sql, params)
}

pub fn migrate(migrations: &[(&str, &str)]) -> Result<Vec<String>, DbError> {
    let list: Vec<Migration> = migrations
        .iter()
        .map(|(name, up)| Migration {
            name: (*name).into(),
            up: (*up).into(),
        })
        .collect();
    raw::migrate(&list)
}

pub struct Rows(pub RowSet);

impl Rows {
    pub fn len(&self) -> usize {
        self.0.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.rows.is_empty()
    }
    pub fn get(&self, row: usize, col: &str) -> Option<&Value> {
        let i = self.0.columns.iter().position(|c| c == col)?;
        self.0.rows.get(row)?.get(i)
    }
    pub fn int(&self, row: usize, col: &str) -> Option<i64> {
        match self.get(row, col)? {
            Value::Int(v) => Some(*v),
            _ => None,
        }
    }
    pub fn text(&self, row: usize, col: &str) -> Option<String> {
        match self.get(row, col)? {
            Value::Text(v) => Some(v.clone()),
            _ => None,
        }
    }
}

impl From<i64> for Param {
    fn from(v: i64) -> Self {
        Param::Int(v)
    }
}
impl From<&str> for Param {
    fn from(v: &str) -> Self {
        Param::Text(v.into())
    }
}
impl From<String> for Param {
    fn from(v: String) -> Self {
        Param::Text(v)
    }
}
impl From<bool> for Param {
    fn from(v: bool) -> Self {
        Param::Boolean(v)
    }
}
impl<T: Into<Param>> From<Option<T>> for Param {
    fn from(v: Option<T>) -> Self {
        v.map_or(Param::Null, Into::into)
    }
}
