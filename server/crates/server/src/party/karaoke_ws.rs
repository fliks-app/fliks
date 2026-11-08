//! Pitch-frame relay of a party's karaoke (`docs/spec/karaoke.md` rule 26): members send frame batches over a
//! WebSocket, the party host's display sockets receive them stamped with the sender. Never audio.
use super::routes::{R, fail, host_of, member_row, require_open};
use crate::{
    events::credential,
    http::{AppError, auth::SessionAuthed, validate::PathParams},
    state::AppState,
};
use axum::{
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::Response,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const MAX_FRAMES: usize = 50;
const MAX_BYTES: usize = 4096;
/// Batches a socket may send per second; the phones send about four.
const MAX_PER_SECOND: u32 = 20;
const RECHECK: Duration = Duration::from_secs(5);

type Sink = mpsc::Sender<String>;

/// The display sockets of each party.
#[derive(Clone, Default)]
pub struct Relay(Arc<Mutex<HashMap<i32, Vec<(u64, Sink)>>>>);

impl Relay {
    fn add(&self, party: i32, id: u64, tx: Sink) {
        self.0
            .lock()
            .unwrap()
            .entry(party)
            .or_default()
            .push((id, tx));
    }

    fn remove(&self, party: i32, id: u64) {
        let mut all = self.0.lock().unwrap();
        if let Some(v) = all.get_mut(&party) {
            v.retain(|(i, _)| *i != id);
            if v.is_empty() {
                all.remove(&party);
            }
        }
    }

    /// A slow display drops batches rather than slowing the singers.
    fn send(&self, party: i32, text: &str) {
        for (_, tx) in self.0.lock().unwrap().get(&party).into_iter().flatten() {
            let _ = tx.try_send(text.to_owned());
        }
    }
}

/// `{k:"pf", t:[ms], m:[tenths of a semitone, -1 unvoiced]}`: at most 50 equal-length finite entries.
fn valid(v: &Value) -> bool {
    let nums = |k: &str| {
        v.get(k)
            .and_then(Value::as_array)
            .filter(|a| {
                a.len() <= MAX_FRAMES && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
            })
            .map(Vec::len)
    };
    v.get("k").and_then(Value::as_str) == Some("pf")
        && nums("t").is_some()
        && nums("t") == nums("m")
}

/// The batch as the display gets it: the validated fields and the sender, never anything else of the input.
fn stamped(v: &Value, user: i32) -> String {
    json!({ "k": "pf", "u": user, "t": v["t"], "m": v["m"] }).to_string()
}

/// A token bucket of `MAX_PER_SECOND` per second.
struct Bucket(Instant, u32);

impl Bucket {
    fn allow(&mut self) -> bool {
        if self.0.elapsed() >= Duration::from_secs(1) {
            *self = Bucket(Instant::now(), 0);
        }
        self.1 += 1;
        self.1 <= MAX_PER_SECOND
    }
}

/// `GET /api/parties/{id}/karaoke/ws?role=singer|display`: any member sends as `singer`, only the party host
/// opens a `display`. The credential is the session (cookie, Bearer or `?token=`) or an events `?ticket=`.
#[utoipa::path(get, path = "/api/parties/{id}/karaoke/ws", responses((status = 101)))]
pub async fn karaoke_ws(
    State(st): State<AppState>,
    session: Result<SessionAuthed, AppError>,
    PathParams(id): PathParams<i32>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> R<Response> {
    let (user, _) = credential(&st, q.get("ticket").cloned(), session).await?;
    let row = member_row(&st, id, user).await?;
    require_open(&row)?;
    let display = match q.get("role").map(String::as_str) {
        Some("display") => true,
        Some("singer") | None => false,
        _ => return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid")),
    };
    if display && host_of(&st, &row) != user {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_not_host"));
    }
    Ok(ws
        .max_message_size(MAX_BYTES)
        .on_upgrade(move |s| serve(st, id, user, display, s)))
}

async fn serve(st: AppState, party: i32, user: i32, display: bool, mut ws: WebSocket) {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<String>(64);
    if display {
        st.relay.add(party, id, tx);
    }
    let mut bucket = Bucket(Instant::now(), 0);
    let mut recheck = tokio::time::interval(RECHECK);
    loop {
        tokio::select! {
            out = rx.recv(), if display => {
                let Some(text) = out else { break };
                if ws.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(t))) if !display => {
                    if !bucket.allow() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(&t)
                        && valid(&v)
                    {
                        st.relay.send(party, &stamped(&v, user));
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                _ => {}
            },
            _ = recheck.tick() => {
                if !st.parties.has_user(party, user) {
                    break;
                }
            }
        }
    }
    if display {
        st.relay.remove(party, id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_is_valid_only_when_well_formed_and_small() {
        assert!(valid(&json!({"k":"pf","t":[1,2],"m":[600,-1]})));
        assert!(!valid(&json!({"k":"pf","t":[1,2],"m":[600]})));
        assert!(!valid(&json!({"k":"x","t":[],"m":[]})));
        assert!(!valid(&json!({"k":"pf","t":["a"],"m":[1]})));
        let big: Vec<u32> = (0..51).collect();
        assert!(!valid(&json!({"k":"pf","t":big,"m":big})));
    }

    #[test]
    fn the_display_gets_the_sender_and_nothing_else() {
        let v = json!({"k":"pf","t":[1],"m":[600],"u":99,"extra":true});
        let out: Value = serde_json::from_str(&stamped(&v, 7)).unwrap();
        assert_eq!(out, json!({"k":"pf","u":7,"t":[1],"m":[600]}));
    }

    #[test]
    fn the_bucket_refuses_past_its_rate() {
        let mut b = Bucket(Instant::now(), 0);
        let ok = (0..30).filter(|_| b.allow()).count();
        assert_eq!(ok, MAX_PER_SECOND as usize);
    }

    #[tokio::test]
    async fn only_displays_of_that_party_receive() {
        let r = Relay::default();
        let (a, mut ra) = mpsc::channel(4);
        let (b, mut rb) = mpsc::channel(4);
        r.add(1, 1, a);
        r.add(2, 2, b);
        r.send(1, "x");
        assert_eq!(ra.try_recv().unwrap(), "x");
        assert!(rb.try_recv().is_err());
        r.remove(1, 1);
        r.send(1, "y");
        assert!(ra.try_recv().is_err());
    }
}
