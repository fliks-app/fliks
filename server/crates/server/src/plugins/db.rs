//! Per-plugin Postgres (`plugins.md` rule 35, SQL section): own role, own schema,
//! text-format params, the deadline cancel and the `unavailable` code.
use super::runtime::{DbError, Param, RowSet, Value};
use crate::sync::MutexExt;
use bytes::BytesMut;
use chrono::DateTime;
use futures_util::TryStreamExt;
use sqlx::{PgPool, Postgres, Transaction};

type Tx = Transaction<'static, Postgres>;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::types::{Format, FromSql, IsNull, ToSql, Type, to_sql_checked};
use tokio_postgres::{Client, NoTls};

pub const QUERY_DEADLINE: Duration = Duration::from_secs(60);
pub const MIGRATE_DEADLINE: Duration = Duration::from_secs(600);
/// Cap on the rows a query may buffer in the server process.
pub const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_CLOSE: Duration = Duration::from_secs(600);
pub const UNAVAILABLE: &str = "unavailable";

mod provision;
pub use provision::*;

pub struct PluginDb {
    cfg: tokio_postgres::Config,
    core: PgPool,
    idle: Mutex<Vec<(Client, Instant)>>,
    sem: Arc<Semaphore>,
    migrating: tokio::sync::Mutex<()>,
    lock_key: i64,
    deadline: Duration,
}

fn err(code: &str, message: impl Into<String>) -> DbError {
    DbError {
        code: code.into(),
        message: message.into(),
    }
}

fn pg_err(e: tokio_postgres::Error) -> DbError {
    match e.as_db_error() {
        Some(d) => err(d.code().code(), d.message()),
        None => err(UNAVAILABLE, e.to_string()),
    }
}

impl PluginDb {
    pub fn new(
        target: &PgTarget,
        core: PgPool,
        role: &str,
        schema: &str,
        password: &str,
        cap: usize,
        deadline: Duration,
    ) -> Arc<Self> {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&target.host)
            .port(target.port)
            .dbname(&target.dbname)
            .user(role)
            .password(password)
            .options(format!(
                "-c search_path={schema} -c statement_timeout={}",
                (deadline + Duration::from_secs(1)).as_millis()
            ))
            .connect_timeout(CONNECT_TIMEOUT);
        let lock_key = schema
            .bytes()
            .fold(0x5138_i64, |h, b| h.wrapping_mul(31).wrapping_add(b as i64));
        Arc::new(PluginDb {
            cfg,
            core,
            idle: Mutex::new(Vec::new()),
            sem: Arc::new(Semaphore::new(cap)),
            migrating: tokio::sync::Mutex::new(()),
            lock_key,
            deadline,
        })
    }

    async fn lease(self: &Arc<Self>) -> Result<Lease, DbError> {
        let permit = tokio::time::timeout(CONNECT_TIMEOUT, self.sem.clone().acquire_owned())
            .await
            .map_err(|_| err(UNAVAILABLE, "connection pool wait exceeded"))?
            .expect("never closed");
        let pooled = {
            let mut idle = self.idle.lock_clean();
            idle.retain(|(c, at)| !c.is_closed() && at.elapsed() < IDLE_CLOSE);
            idle.pop()
        };
        let client = match pooled {
            Some((c, _)) => c,
            None => {
                let (client, conn) = tokio::time::timeout(CONNECT_TIMEOUT, self.cfg.connect(NoTls))
                    .await
                    .map_err(|_| err(UNAVAILABLE, "connect timed out"))?
                    .map_err(|e| match e.as_db_error() {
                        Some(d) => err(d.code().code(), d.message()),
                        None => err(UNAVAILABLE, e.to_string()),
                    })?;
                tokio::spawn(conn);
                client
            }
        };
        Ok(Lease {
            client: Some(client),
            db: self.clone(),
            _permit: permit,
            busy: false,
            cancelled: false,
        })
    }

    pub async fn query(self: &Arc<Self>, sql: &str, params: &[Param]) -> Result<RowSet, DbError> {
        match self.call(sql, params, true).await? {
            Out::Rows(cols, rows) => decode(cols, rows),
            Out::Count(_) => unreachable!("asked for rows"),
        }
    }

    pub async fn execute(self: &Arc<Self>, sql: &str, params: &[Param]) -> Result<u64, DbError> {
        match self.call(sql, params, false).await? {
            Out::Count(n) => Ok(n),
            Out::Rows(..) => unreachable!("asked for a count"),
        }
    }

    /// At the deadline: cancel server-side, then 57014, or `unavailable` when the database is gone.
    async fn call(
        self: &Arc<Self>,
        sql: &str,
        params: &[Param],
        rows: bool,
    ) -> Result<Out, DbError> {
        let mut lease = self.lease().await?;
        let params = text_params(params);
        lease.busy = true;
        let out = match tokio::time::timeout(self.deadline, run(lease.client(), sql, &params, rows))
            .await
        {
            Ok(r) => r,
            Err(_) => {
                let _ = lease.client().cancel_token().cancel_query(NoTls).await;
                lease.busy = false;
                lease.cancelled = true;
                Err(self.cut().await)
            }
        };
        lease.cancelled |= matches!(&out, Err(e) if e.code == "ERR_RESULT_TOO_LARGE");
        lease.settle(out).await
    }

    /// The code of a call cut by a deadline: a core probe tells a dead database from a slow query.
    pub async fn cut(&self) -> DbError {
        let probe =
            tokio::time::timeout(CONNECT_TIMEOUT, sqlx::query("SELECT 1").execute(&self.core))
                .await;
        if matches!(probe, Ok(Ok(_))) {
            err("57014", "canceling statement due to statement timeout")
        } else {
            err(UNAVAILABLE, "database unreachable")
        }
    }

    /// Applies the unrecorded entries in order, each script in its own transaction with its row.
    pub async fn migrate(
        self: &Arc<Self>,
        migrations: &[(String, String)],
    ) -> Result<Vec<String>, DbError> {
        let _one = self.migrating.lock().await;
        let mut lease = self.lease().await?;
        lease.busy = true;
        let key = self.lock_key;
        let work = async {
            let c = lease.client.as_mut().expect("leased");
            let lock = format!(
                "SET LOCAL statement_timeout = {}; SELECT pg_advisory_xact_lock({key})",
                MIGRATE_DEADLINE.as_millis()
            );
            let exists: bool = c
                .query_one("SELECT to_regclass('\"_migrations\"') IS NOT NULL", &[])
                .await
                .map_err(pg_err)?
                .get(0);
            // Checked first: IF NOT EXISTS on an existing table logs a NOTICE on every boot.
            if !exists && !migrations.is_empty() {
                let tx = c.transaction().await.map_err(pg_err)?;
                tx.batch_execute(&format!(
                    "{lock};
                     CREATE TABLE IF NOT EXISTS \"_migrations\" (
                       \"name\" text PRIMARY KEY,
                       \"appliedAt\" timestamptz NOT NULL DEFAULT now())"
                ))
                .await
                .map_err(pg_err)?;
                tx.commit().await.map_err(pg_err)?;
            }
            let mut applied = Vec::new();
            for (name, up) in migrations {
                let tx = c.transaction().await.map_err(pg_err)?;
                tx.batch_execute(&lock).await.map_err(pg_err)?;
                let done = tx
                    .query_opt("SELECT 1 FROM \"_migrations\" WHERE \"name\" = $1", &[name])
                    .await
                    .map_err(pg_err)?;
                if done.is_some() {
                    continue;
                }
                tx.batch_execute(up).await.map_err(|e| {
                    let e = pg_err(e);
                    err(&e.code, format!("migration {name}: {}", e.message))
                })?;
                tx.execute(
                    "INSERT INTO \"_migrations\" (\"name\") VALUES ($1)",
                    &[name],
                )
                .await
                .map_err(pg_err)?;
                tx.commit().await.map_err(pg_err)?;
                applied.push(name.clone());
            }
            Ok(applied)
        };
        let out = match tokio::time::timeout(MIGRATE_DEADLINE, work).await {
            Ok(r) => r,
            Err(_) => Err(self.cut().await),
        };
        lease.settle(out).await
    }
}

enum Out {
    Rows(Vec<String>, Vec<tokio_postgres::Row>),
    Count(u64),
}

async fn run(c: &Client, sql: &str, params: &[TextParam], rows: bool) -> Result<Out, DbError> {
    let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as _).collect();
    let stmt = c.prepare(sql).await.map_err(pg_err)?;
    if stmt.params().len() != refs.len() {
        return Err(err(
            "ERR_VALIDATION",
            format!("expected {} params", stmt.params().len()),
        ));
    }
    if rows {
        let cols = stmt.columns().iter().map(|c| c.name().to_owned()).collect();
        let stream = c.query_raw(&stmt, refs).await.map_err(pg_err)?;
        let mut stream = std::pin::pin!(stream);
        let (mut out, mut bytes) = (Vec::new(), 0);
        while let Some(row) = stream.try_next().await.map_err(pg_err)? {
            bytes += (0..row.len())
                .map(|i| row.get::<_, Raw>(i).0.map_or(0, <[u8]>::len))
                .sum::<usize>();
            if bytes > MAX_RESULT_BYTES {
                // The backend would keep producing rows for a dropped stream.
                let _ = c.cancel_token().cancel_query(NoTls).await;
                return Err(err(
                    "ERR_RESULT_TOO_LARGE",
                    format!("result exceeds {MAX_RESULT_BYTES} bytes"),
                ));
            }
            out.push(row);
        }
        Ok(Out::Rows(cols, out))
    } else {
        c.execute(&stmt, &refs)
            .await
            .map(Out::Count)
            .map_err(pg_err)
    }
}

/// A leased connection; dropping it (also mid-call) cancels and resets it before reuse.
struct Lease {
    client: Option<Client>,
    db: Arc<PluginDb>,
    _permit: OwnedSemaphorePermit,
    busy: bool,
    /// A cancel is async on the server: it can land on the next query of a reused connection.
    cancelled: bool,
}

impl Lease {
    fn client(&self) -> &Client {
        self.client.as_ref().expect("leased")
    }
    async fn settle<T>(mut self, r: Result<T, DbError>) -> Result<T, DbError> {
        self.busy = false;
        let c = self.client.take().expect("leased");
        if !self.cancelled && c.batch_execute("DISCARD ALL").await.is_ok() {
            self.db.idle.lock_clean().push((c, Instant::now()));
        }
        r
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(c) = self.client.take() else { return };
        let db = self.db.clone();
        let busy = self.busy;
        tokio::spawn(async move {
            if busy {
                let _ = c.cancel_token().cancel_query(NoTls).await;
                return;
            }
            if c.batch_execute("DISCARD ALL").await.is_ok() {
                db.idle.lock_clean().push((c, Instant::now()));
            }
        });
    }
}

/// Every parameter goes as text with an inferred type, as 4.x sent them.
#[derive(Debug)]
struct TextParam(Option<String>);

impl ToSql for TextParam {
    fn to_sql(
        &self,
        _: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match &self.0 {
            None => Ok(IsNull::Yes),
            Some(s) => {
                out.extend_from_slice(s.as_bytes());
                Ok(IsNull::No)
            }
        }
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }
    to_sql_checked!();
}

fn float_text(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        f.to_string()
    }
}

fn array_text<T: AsRef<str>>(items: impl Iterator<Item = T>) -> String {
    let body: Vec<String> = items
        .map(|s| {
            format!(
                "\"{}\"",
                s.as_ref().replace('\\', "\\\\").replace('"', "\\\"")
            )
        })
        .collect();
    format!("{{{}}}", body.join(","))
}

fn text_params(params: &[Param]) -> Vec<TextParam> {
    params
        .iter()
        .map(|p| {
            TextParam(match p {
                Param::Null => None,
                Param::Boolean(b) => Some(b.to_string()),
                Param::Int(i) => Some(i.to_string()),
                Param::Float(f) => Some(float_text(*f)),
                Param::Text(t) | Param::Json(t) => Some(t.clone()),
                Param::Bytes(b) => Some(format!(
                    "\\x{}",
                    b.iter().map(|x| format!("{x:02x}")).collect::<String>()
                )),
                Param::TextList(l) => Some(array_text(l.iter())),
                Param::IntList(l) => Some(array_text(l.iter().map(|i| i.to_string()))),
            })
        })
        .collect()
}

struct Raw<'a>(Option<&'a [u8]>);

impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Raw(Some(raw)))
    }
    fn from_sql_null(_: &Type) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Raw(None))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn decode(columns: Vec<String>, rows: Vec<tokio_postgres::Row>) -> Result<RowSet, DbError> {
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut vals = Vec::with_capacity(columns.len());
        for (i, col) in row.columns().iter().enumerate() {
            let Raw(raw) = row.get::<_, Raw>(i);
            vals.push(match raw {
                None => Value::Null,
                Some(_) if col.type_().name() == "void" => Value::Null,
                Some(b) => value(col.type_(), b).ok_or_else(|| {
                    err(
                        "ERR",
                        format!(
                            "column \"{}\" has unsupported type {}",
                            col.name(),
                            col.type_().name()
                        ),
                    )
                })?,
            });
        }
        out.push(vals);
    }
    Ok(RowSet { columns, rows: out })
}

const PG_EPOCH_SECS: i64 = 946_684_800;

fn be<const N: usize>(b: &[u8]) -> Option<[u8; N]> {
    b.get(..N)?.try_into().ok()
}

pub(crate) fn value(ty: &Type, b: &[u8]) -> Option<Value> {
    let text = || {
        std::str::from_utf8(b)
            .ok()
            .map(|s| Value::Text(s.to_owned()))
    };
    Some(match ty.name() {
        "int2" => Value::Int(i16::from_be_bytes(be(b)?) as i64),
        "int4" => Value::Int(i32::from_be_bytes(be(b)?) as i64),
        "int8" => Value::Int(i64::from_be_bytes(be(b)?)),
        "float4" => Value::Float(f32::from_be_bytes(be(b)?) as f64),
        "float8" => Value::Float(f64::from_be_bytes(be(b)?)),
        "bool" => Value::Boolean(*b.first()? != 0),
        "text" | "varchar" | "bpchar" | "name" | "citext" => text()?,
        "void" => Value::Null,
        "uuid" => {
            let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
            Value::Text(format!(
                "{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..32]
            ))
        }
        "numeric" => Value::Text(numeric(b)?),
        "date" => {
            let days = i32::from_be_bytes(be(b)?);
            Value::Text(match days {
                i32::MAX => "infinity".into(),
                i32::MIN => "-infinity".into(),
                d => DateTime::from_timestamp(PG_EPOCH_SECS + d as i64 * 86_400, 0)?
                    .format("%Y-%m-%d")
                    .to_string(),
            })
        }
        "timestamptz" | "timestamp" => {
            let us = i64::from_be_bytes(be(b)?);
            Value::Text(match us {
                i64::MAX => "infinity".into(),
                i64::MIN => "-infinity".into(),
                us => fliks_domain::js::iso(DateTime::from_timestamp_micros(
                    us + PG_EPOCH_SECS * 1_000_000,
                )?),
            })
        }
        "json" => Value::Json(std::str::from_utf8(b).ok()?.to_owned()),
        "jsonb" => Value::Json(std::str::from_utf8(b.get(1..)?).ok()?.to_owned()),
        "bytea" => Value::Bytes(b.to_vec()),
        _ => return None,
    })
}

/// Binary `numeric` (base-10000 digits) to its canonical text.
fn numeric(b: &[u8]) -> Option<String> {
    let n = u16::from_be_bytes(be(b)?) as usize;
    let weight = i16::from_be_bytes(be(b.get(2..)?)?) as i64;
    let sign = u16::from_be_bytes(be(b.get(4..)?)?);
    let dscale = u16::from_be_bytes(be(b.get(6..)?)?) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    let digits: Vec<i64> = (0..n)
        .map(|i| be(b.get(8 + 2 * i..)?).map(|d| i16::from_be_bytes(d) as i64))
        .collect::<Option<_>>()?;
    let at = |i: i64| {
        if i < 0 {
            0
        } else {
            digits.get(i as usize).copied().unwrap_or(0)
        }
    };
    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-');
    }
    if weight < 0 {
        s.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                s += &at(i).to_string()
            } else {
                s += &format!("{:04}", at(i))
            }
        }
    }
    if dscale > 0 {
        let mut frac = String::new();
        let mut k = 1;
        while frac.len() < dscale {
            frac += &format!("{:04}", at(weight + k));
            k += 1;
        }
        frac.truncate(dscale);
        s.push('.');
        s += &frac;
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(schema("fliks.download"), "plugin_fliks_download");
        assert_eq!(
            role("0000a1b2", "fliks.download"),
            "fp_0000a1b2_fliks_download"
        );
        assert_eq!(role("ffffffff", &"a".repeat(51)).len(), 63);
    }
}
