//! Cron expressions and the server time zone (`scheduler.md` rules 8, 9, 12).
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::Cron;
use std::{path::Path, str::FromStr, sync::OnceLock, time::Duration};

/// `TZ` as an IANA name, else the zone `/etc/localtime` points into, else UTC (libc would silently pick UTC).
pub fn resolve_tz(env: Option<&str>, localtime: Option<&Path>) -> Tz {
    let named = env
        .map(|v| v.trim().trim_start_matches(':'))
        .filter(|v| !v.is_empty());
    if let Some(name) = named {
        match Tz::from_str(name) {
            Ok(tz) => return tz,
            Err(_) => tracing::warn!("TZ \"{name}\" is not an IANA zone: falling back"),
        }
    }
    let linked = localtime.and_then(|p| std::fs::read_link(p).ok());
    linked
        .as_deref()
        .and_then(|p| p.to_str()?.rsplit_once("zoneinfo/"))
        .and_then(|(_, zone)| Tz::from_str(zone).ok())
        .unwrap_or(Tz::UTC)
}

/// The zone of `nextRun` and the cron runner; resolved once.
pub fn server_tz() -> Tz {
    static TZ: OnceLock<Tz> = OnceLock::new();
    *TZ.get_or_init(|| {
        resolve_tz(
            std::env::var("TZ").ok().as_deref(),
            Some(Path::new("/etc/localtime")),
        )
    })
}

/// Five fields, or six with leading seconds.
pub fn parse(expr: &str) -> Result<Cron, croner::errors::CronError> {
    Cron::from_str(expr)
}

/// The first fire time strictly after `after`, evaluated in `tz`.
pub fn next_after(cron: &Cron, tz: Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    cron.find_next_occurrence(&after.with_timezone(&tz), false)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Longest sleep before the wall clock is read again, so a suspended host does not oversleep a tick.
const RECHECK: Duration = Duration::from_secs(30);

/// `FLIKS_DISABLE_CRON=1` (exactly `1`) starts no timer; manual triggers still work.
fn disabled() -> bool {
    std::env::var("FLIKS_DISABLE_CRON").as_deref() == Ok("1")
}

/// One timer: `fire` runs at every match of `expr` and must return at once. No catch-up of missed ticks.
pub fn spawn<C, F>(
    expr: impl Into<String>,
    tz: Tz,
    clock: C,
    mut fire: F,
) -> tokio::task::JoinHandle<()>
where
    C: Fn() -> DateTime<Utc> + Send + 'static,
    F: FnMut() + Send + 'static,
{
    let expr: String = expr.into();
    tokio::spawn(async move {
        if disabled() {
            return;
        }
        let Ok(cron) = parse(&expr) else {
            tracing::error!("invalid cron expression \"{expr}\"");
            return;
        };
        let mut after = clock();
        while let Some(next) = next_after(&cron, tz, after) {
            loop {
                let now = clock();
                if now >= next {
                    break;
                }
                let wait = (next - now).to_std().unwrap_or_default();
                tokio::time::sleep(wait.min(RECHECK)).await;
            }
            fire();
            after = clock().max(next);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Input {
        expr: String,
        tz: String,
        from: DateTime<Utc>,
    }
    #[derive(Deserialize)]
    struct Expected {
        next: Option<[DateTime<Utc>; 3]>,
    }
    #[derive(Deserialize)]
    struct Case {
        input: Input,
        expected: Expected,
    }
    #[derive(Deserialize)]
    struct File {
        cases: Vec<Case>,
    }

    /// `cron-parser` 5.5 skips some fires on a DST change day where `croner` fires each valid local
    /// time (`scheduler.md`), so only windows crossing a transition may differ.
    fn dst_window(
        tz: Tz,
        from: DateTime<Utc>,
        got: &[DateTime<Utc>],
        want: Option<&[DateTime<Utc>]>,
    ) -> bool {
        use chrono::{Duration, Offset};
        let off = |t: DateTime<Utc>| t.with_timezone(&tz).offset().fix();
        let end = got
            .iter()
            .chain(want.unwrap_or_default())
            .max()
            .copied()
            .unwrap_or(from);
        off(from - Duration::days(1)) != off(end + Duration::days(1))
    }

    #[test]
    fn next_fire_times_equal_cron_parser() {
        let file: File =
            serde_json::from_str(include_str!("../../../../fixtures/cron-next/cases.json"))
                .unwrap();
        let mut bad = vec![];
        for c in &file.cases {
            let tz: Tz = c.input.tz.parse().unwrap();
            let cron = parse(&c.input.expr).unwrap();
            let mut got = vec![];
            let mut at = c.input.from;
            for _ in 0..3 {
                let Some(n) = next_after(&cron, tz, at) else {
                    break;
                };
                got.push(n);
                at = n;
            }
            let want = c.expected.next.map(Vec::from);
            if Some(got.clone()) != want && !dst_window(tz, c.input.from, &got, want.as_deref()) {
                bad.push(format!(
                    "{} {} {}: got {got:?}, want {:?}",
                    c.input.expr, c.input.tz, c.input.from, c.expected.next
                ));
            }
        }
        assert!(
            bad.is_empty(),
            "{} of {} differ:\n{}",
            bad.len(),
            file.cases.len(),
            bad[..bad.len().min(12)].join("\n")
        );
    }

    #[test]
    fn tz_resolution_order() {
        assert_eq!(resolve_tz(Some("Europe/Paris"), None), Tz::Europe__Paris);
        assert_eq!(resolve_tz(Some(":Asia/Tokyo"), None), Tz::Asia__Tokyo);
        assert_eq!(resolve_tz(Some("Nope/Zone"), None), Tz::UTC);
        assert_eq!(
            resolve_tz(Some(" "), Some(Path::new("/nonexistent"))),
            Tz::UTC
        );
        let dir = std::env::temp_dir().join(format!("fliks-tz-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("localtime");
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/usr/share/zoneinfo/America/New_York", &link).unwrap();
            assert_eq!(resolve_tz(None, Some(&link)), Tz::America__New_York);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn timer_fires_each_match_once_and_skips_none_missed() {
        let (base, t0) = (
            "2026-10-16T01:59:50Z".parse::<DateTime<Utc>>().unwrap(),
            tokio::time::Instant::now(),
        );
        let clock = move || base + chrono::Duration::from_std(t0.elapsed()).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let h = spawn("0 02 * * *", Tz::UTC, clock, move || {
            let _ = tx.send(clock());
        });
        let first = rx.recv().await.unwrap();
        assert_eq!(
            first.format("%Y-%m-%dT%H:%M").to_string(),
            "2026-10-16T02:00"
        );
        let second = rx.recv().await.unwrap();
        assert_eq!(
            second.format("%Y-%m-%dT%H:%M").to_string(),
            "2026-10-17T02:00"
        );
        h.abort();
    }
}
