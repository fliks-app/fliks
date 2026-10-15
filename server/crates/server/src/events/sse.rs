//! Wire format of `/api/system/events` (rules 5-7, 11), byte-compatible with Nest's `SseStream`.
use super::hub::{Connection, Msg};
use axum::body::Bytes;
use futures_util::{Stream, StreamExt, stream};
use std::{convert::Infallible, time::Duration};
use tokio::time::{Instant, MissedTickBehavior, interval_at};

const PING: Duration = Duration::from_secs(30);

/// `event:` only when named, `id:` counts every message written (pings included), no `retry:`.
fn frame(id: u64, event: Option<&str>, data: &str) -> Bytes {
    let named = event.map(|e| format!("event: {e}\n")).unwrap_or_default();
    Bytes::from(format!("{named}id: {id}\ndata: {data}\n\n"))
}

/// A blank line first, then every queued message until the hub closes the connection; dropping the
/// stream (client gone) drops the connection and with it the registration.
pub(super) fn stream(conn: Connection) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let mut ping = interval_at(Instant::now() + PING, PING);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let messages = stream::unfold(
        (conn, ping, 0u64),
        |(mut conn, mut ping, mut n)| async move {
            let bytes = tokio::select! {
                m = conn.rx.recv() => match m {
                    Some(Msg::Event(json)) => frame(n + 1, None, &json),
                    _ => return None,
                },
                _ = ping.tick() => frame(n + 1, Some("ping"), &PING.as_millis().to_string()),
            };
            n += 1;
            Some((Ok(bytes), (conn, ping, n)))
        },
    );
    stream::once(std::future::ready(Ok(Bytes::from_static(b"\n")))).chain(messages)
}

#[cfg(test)]
mod tests {
    use super::super::{Hub, Identity, SseEvent};
    use super::*;
    use std::pin::pin;

    async fn next(s: &mut (impl Stream<Item = Result<Bytes, Infallible>> + Unpin)) -> String {
        String::from_utf8(s.next().await.unwrap().unwrap().to_vec()).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn bytes_match_nests_stream_with_ids_counting_pings() {
        let hub = Hub::new();
        let conn = hub.connect(1, Identity::default());
        let id = conn.id.clone();
        let mut s = pin!(stream(conn));
        assert_eq!(next(&mut s).await, "\n");
        assert_eq!(
            next(&mut s).await,
            format!("id: 1\ndata: {{\"type\":\"sse.connected\",\"connectionId\":\"{id}\"}}\n\n")
        );
        tokio::time::sleep(Duration::from_secs(29)).await;
        hub.emit(SseEvent::QueueUpdated {});
        assert_eq!(
            next(&mut s).await,
            "id: 2\ndata: {\"type\":\"queue.updated\"}\n\n"
        );
        assert_eq!(next(&mut s).await, "event: ping\nid: 3\ndata: 30000\n\n");
        assert_eq!(next(&mut s).await, "event: ping\nid: 4\ndata: 30000\n\n");
    }

    #[tokio::test]
    async fn a_closed_connection_ends_the_stream_after_its_queued_messages() {
        let hub = Hub::new();
        let conn = hub.connect(1, Identity::default());
        hub.drop_connections_for_user(1);
        let mut s = pin!(stream(conn));
        assert_eq!(next(&mut s).await, "\n");
        assert!(next(&mut s).await.contains("sse.connected"));
        assert!(s.next().await.is_none());
    }
}
