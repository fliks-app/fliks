//! The notification catalogue (`push.md` rules 31 to 37): which event reaches whom, and as what.
use super::{ActionSpec, Notification, notify};
use crate::{
    events::{Bus, DomainEvent, SseEvent},
    http::auth::{Authed, load_users},
    state::AppState,
    sync::MutexExt,
};
use fliks_domain::{
    acl::{Action, Permissions, Subject},
    media::{family::Family, kind::MediaKind},
    push::{episode_code, season_code},
};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Mutex,
    time::Duration,
};

const DAY: u32 = 86_400;
const GROUP_WINDOW: Duration = Duration::from_secs(300);

fn params(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn open(url: &str) -> ActionSpec {
    ActionSpec::Open {
        id: "open",
        url: url.to_owned(),
    }
}

pub fn poster(media: i32) -> String {
    format!("/api/images/media/{media}/poster?size=medium")
}

fn avatar(user: i64, has: &Option<String>) -> Option<String> {
    has.as_ref().map(|_| format!("/api/images/user/{user}"))
}

pub fn media_url(id: i32, kind: MediaKind) -> String {
    let root = match kind {
        MediaKind::Movie => "movies",
        MediaKind::Series => "series",
        MediaKind::Book => "books",
        MediaKind::Comic => "comics",
        MediaKind::Album => "albums",
    };
    format!("/{root}/{id}")
}

/// A hub event sent to users, as the notification it becomes; `None` for every other type.
fn from_event(ev: &SseEvent) -> Option<Notification> {
    Some(match ev {
        SseEvent::PartyInvited {
            party_id,
            name,
            host,
            item,
            ..
        } => {
            let url = format!("/parties/{party_id}");
            let mut n = Notification::core(
                "parties",
                "party_invited",
                &params(json!({"party": name, "host": host["username"]})),
                url.clone(),
                DAY,
            );
            n.image = item["posterUrl"]
                .as_str()
                .filter(|u| u.starts_with('/'))
                .map(str::to_owned);
            n.actions = vec![ActionSpec::Open { id: "join", url }];
            n
        }
        SseEvent::PartyStarting { party_id, name } => {
            let url = format!("/parties/{party_id}");
            let mut n = Notification::core(
                "parties",
                "party_starting",
                &params(json!({"party": name})),
                url.clone(),
                900,
            );
            n.actions = vec![ActionSpec::Open { id: "join", url }];
            n
        }
        SseEvent::SocialFollowRequest {
            user_id,
            username,
            avatar: a,
        } => {
            let mut n = Notification::core(
                "social",
                "follow_request",
                &params(json!({"user": username})),
                format!("/profile/{user_id}"),
                DAY,
            );
            n.image = avatar(*user_id, a);
            let target = i32::try_from(*user_id).ok()?;
            n.actions = vec![
                ActionSpec::Call {
                    id: "accept",
                    action: "follow.accept",
                    target,
                },
                ActionSpec::Call {
                    id: "decline",
                    action: "follow.decline",
                    target,
                },
            ];
            n
        }
        SseEvent::SocialFollowAccepted {
            user_id,
            username,
            avatar: a,
        } => {
            let url = format!("/profile/{user_id}");
            let mut n = Notification::core(
                "social",
                "follow_accepted",
                &params(json!({"user": username})),
                url.clone(),
                DAY,
            );
            n.image = avatar(*user_id, a);
            n.actions = vec![open(&url)];
            n
        }
        SseEvent::SocialContentRecommended {
            user_id,
            username,
            avatar: a,
            media_title,
        } => {
            let url = format!("/profile/{user_id}/recommendations");
            let mut n = Notification::core(
                "social",
                "content_recommended",
                &params(json!({"user": username, "title": media_title})),
                url.clone(),
                DAY,
            );
            n.image = avatar(*user_id, a);
            n.actions = vec![open(&url)];
            n
        }
        SseEvent::PairingRequested { device_name, .. } => {
            let url = "/account/devices";
            let mut n = Notification::core(
                "account",
                "pairing_requested",
                &params(json!({"device": device_name})),
                url.into(),
                600,
            );
            n.urgent = true;
            n.actions = vec![open(url)];
            n
        }
        _ => return None,
    })
}

pub fn init(st: &AppState) {
    let hooked = st.clone();
    st.hub.register_users_hook(move |ev, users| {
        if let Some(n) = from_event(ev) {
            notify(&hooked, users.to_vec(), n);
        }
    });
    tokio::spawn(listen(st.clone()));
}

/// What a request notification needs beyond the admin payload.
pub struct ReqRef {
    pub id: i32,
    pub requester: Option<i32>,
    pub media: Option<(i32, MediaKind)>,
}

/// The user notifications behind the admin events of `requests::services::notify`.
pub fn request_event(st: &AppState, event: &'static str, payload: &Map<String, Value>, r: ReqRef) {
    let title = payload.get("title").cloned().unwrap_or(Value::Null);
    let st = st.clone();
    tokio::spawn(async move {
        let url = |own: bool| match r.media {
            Some((id, kind)) if own => media_url(id, kind),
            _ => "/requests".to_owned(),
        };
        let mut n = match event {
            "request.approved" | "request.declined" | "request.available" => {
                let Some(user) = r.requester else { return };
                let key = event.replace('.', "_");
                let mut n = Notification::core(
                    "requests",
                    &key,
                    &params(json!({"title": title})),
                    url(event != "request.declined"),
                    DAY,
                );
                if event != "request.declined" {
                    n.actions = vec![open(&n.url.clone())];
                }
                (vec![user], n)
            }
            "request.created" => {
                let who = match r.requester {
                    Some(u) => sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
                        .bind(u)
                        .fetch_optional(&st.db)
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                    None => String::new(),
                };
                let mut n = Notification::core(
                    "requests",
                    "request_created",
                    &params(json!({"title": title, "user": who})),
                    "/pending-requests".into(),
                    DAY,
                );
                n.actions = vec![
                    ActionSpec::Call {
                        id: "approve",
                        action: "request.approve",
                        target: r.id,
                    },
                    ActionSpec::Call {
                        id: "decline",
                        action: "request.decline",
                        target: r.id,
                    },
                ];
                let mut to = approvers(&st).await;
                to.retain(|u| Some(*u) != r.requester);
                (to, n)
            }
            _ => return,
        };
        n.1.image = r.media.map(|(m, _)| poster(m));
        notify(&st, n.0, n.1);
    });
}

async fn approvers(st: &AppState) -> Vec<i32> {
    let Ok(users) = load_users(&st.db, None, true).await else {
        return vec![];
    };
    users
        .into_iter()
        .filter(|(u, role)| {
            Permissions::from(
                role.as_ref().map_or(&[][..], |r| &r.permissions),
                u.is_admin,
            )
            .can(Action::Manage, &Subject::FliksRequest)
        })
        .map(|(u, _)| u.id)
        .collect()
}

#[derive(Default)]
pub struct Episodes {
    /// Open groups by media: season to episodes.
    groups: Mutex<HashMap<i32, BTreeMap<i64, BTreeSet<i64>>>>,
}

impl Episodes {
    /// Adds an episode; true when it opened the group.
    fn add(&self, media: i32, season: i64, episode: i64) -> bool {
        let mut g = self.groups.lock_clean();
        let fresh = !g.contains_key(&media);
        g.entry(media)
            .or_default()
            .entry(season)
            .or_default()
            .insert(episode);
        fresh
    }

    fn take(&self, media: i32) -> BTreeMap<i64, BTreeSet<i64>> {
        self.groups.lock_clean().remove(&media).unwrap_or_default()
    }
}

/// The in-process subscriber of `media.files.imported` (`push.md` rule 35).
async fn listen(st: AppState) {
    let mut rx = st.hub.subscribe();
    loop {
        match rx.recv().await {
            Ok(bus) => {
                if let Bus::Domain(DomainEvent::MediaFilesImported {
                    media_id,
                    family: Family::Video,
                    season_number: Some(season),
                    episode_number: Some(episode),
                    ..
                }) = &*bus
                    && let Ok(media) = i32::try_from(*media_id)
                    && st.push.episodes.add(media, *season, *episode)
                {
                    let st = st.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(GROUP_WINDOW).await;
                        if let Err(e) = flush(&st, media).await {
                            tracing::warn!("new-episode notification: {e}");
                        }
                    });
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Users who watch the series (a row not hidden from continue watching), still read its library and
/// have no request for it: a requester gets the `requests` notifications instead.
pub(super) async fn episode_recipients(
    st: &AppState,
    media: i32,
    library: Option<i32>,
) -> sqlx::Result<Vec<i32>> {
    let watchers: Vec<i32> = sqlx::query_scalar(
        r#"SELECT ps."userId" FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE i."mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM requests r WHERE r."mediaId" = $1 AND r."userId" = ps."userId")
           GROUP BY ps."userId" HAVING bool_or(NOT ps."hiddenFromContinueWatching")
           ORDER BY ps."userId""#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await?;
    let mut to = vec![];
    for user in watchers {
        let Some(a) = Authed::load(&st.db, user).await? else {
            continue;
        };
        let reads = match library {
            Some(l) => crate::libraries::acl::accessible_library_ids(&st.db, &a)
                .await?
                .contains(&l),
            None => true,
        };
        if reads {
            to.push(user);
        }
    }
    Ok(to)
}

async fn flush(st: &AppState, media: i32) -> sqlx::Result<()> {
    let seasons = st.push.episodes.take(media);
    let count: usize = seasons.values().map(BTreeSet::len).sum();
    if count == 0 {
        return Ok(());
    }
    let row: Option<(String, Option<i32>)> = sqlx::query_as(
        r#"SELECT title, "libraryId" FROM media WHERE id = $1 AND "mediaType"::text = 'series'"#,
    )
    .bind(media)
    .fetch_optional(&st.db)
    .await?;
    let Some((title, library)) = row else {
        return Ok(());
    };
    let to = episode_recipients(st, media, library).await?;
    let url = media_url(media, MediaKind::Series);
    let mut n = match (count, seasons.len()) {
        (1, _) => {
            let (s, eps) = seasons.iter().next().expect("one episode");
            let e = eps.iter().next().expect("one episode");
            Notification::core(
                "episodes",
                "episode_one",
                &params(json!({"title": title, "episode": episode_code(*s, *e)})),
                url.clone(),
                DAY,
            )
        }
        (_, 1) => {
            let s = seasons.keys().next().expect("one season");
            Notification::core(
                "episodes",
                "episodes_many",
                &params(json!({"title": title, "count": count, "season": season_code(*s)})),
                url.clone(),
                DAY,
            )
        }
        _ => Notification::core(
            "episodes",
            "episodes_series",
            &params(json!({"title": title, "count": count})),
            url.clone(),
            DAY,
        ),
    };
    n.image = Some(poster(media));
    n.tag = Some(format!("episodes:{media}"));
    n.actions = vec![open(&url)];
    notify(st, to, n);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_events_become_notifications() {
        let n = from_event(&SseEvent::PartyStarting {
            party_id: 3,
            name: "Night".into(),
        })
        .unwrap();
        assert_eq!(
            (n.category.as_str(), n.ttl, n.url.as_str()),
            ("parties", 900, "/parties/3")
        );
        assert!(from_event(&SseEvent::PartyUpdated { party_id: 3 }).is_none());
        assert!(
            from_event(&SseEvent::SocialFollowed {
                user_id: 1,
                username: "a".into(),
                avatar: None
            })
            .is_none()
        );
        let req = from_event(&SseEvent::SocialFollowRequest {
            user_id: 7,
            username: "a".into(),
            avatar: Some("x".into()),
        })
        .unwrap();
        assert_eq!(req.actions.len(), 2);
        assert_eq!(req.image.as_deref(), Some("/api/images/user/7"));
    }

    #[test]
    fn a_group_opens_once_and_keeps_every_episode() {
        let e = Episodes::default();
        assert!(e.add(1, 2, 3));
        assert!(!e.add(1, 2, 4));
        assert!(e.add(2, 1, 1));
        let g = e.take(1);
        assert_eq!(g[&2].len(), 2);
        assert!(e.take(1).is_empty());
    }

    async fn state(pool: &sqlx::PgPool) -> AppState {
        crate::db::migrate(pool).await.unwrap();
        AppState::new(
            pool.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        )
    }

    async fn user(pool: &sqlx::PgPool, name: &str) -> i32 {
        sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, true) RETURNING id"#,
        )
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[sqlx::test]
    async fn episode_recipients_watch_without_a_request(pool: sqlx::PgPool) {
        let st = state(&pool).await;
        let (a, hidden, requester, mixed) = (
            user(&pool, "a").await,
            user(&pool, "hidden").await,
            user(&pool, "requester").await,
            user(&pool, "mixed").await,
        );
        let media: i32 = sqlx::query_scalar(
            "INSERT INTO media (title, type) VALUES ('S', 'series') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let edition: i32 = sqlx::query_scalar(
            r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'video') RETURNING id"#,
        )
        .bind(media)
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut items = vec![];
        for _ in 0..2 {
            let id: i32 = sqlx::query_scalar(
                r#"INSERT INTO items ("mediaId", "editionId") VALUES ($1, $2) RETURNING id"#,
            )
            .bind(media)
            .bind(edition)
            .fetch_one(&pool)
            .await
            .unwrap();
            items.push(id);
        }
        for (user, item, hide) in [
            (a, 0, false),
            (hidden, 0, true),
            (requester, 0, false),
            (mixed, 0, true),
            (mixed, 1, false),
        ] {
            sqlx::query(r#"INSERT INTO playback_states ("userId", "itemId", "hiddenFromContinueWatching") VALUES ($1, $2, $3)"#)
                .bind(user)
                .bind(items[item])
                .bind(hide)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(r#"INSERT INTO requests ("mediaType", provider, "externalId", title, status, "userId", "mediaId") VALUES ('series', 'tmdb', '1', 'S', 'pending', $1, $2)"#)
            .bind(requester)
            .bind(media)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            episode_recipients(&st, media, None).await.unwrap(),
            [a, mixed]
        );
    }
}
