//! The host-chosen picture of a party (`docs/spec/watch-party.md`, `watch_parties.cover`).
use super::dto::PartyItem;
use crate::http::AppError;
use fliks_domain::party::{Item, same_row};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::slice;

/// Where an uploaded cover lives under the data dir.
pub const DIR: &str = "parties";

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub media_id: i32,
    pub episode_id: Option<i32>,
}

impl Ref {
    fn item(&self) -> Item {
        Item {
            media_id: self.media_id,
            media_file_id: None,
            episode_id: self.episode_id,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cover {
    Item(Ref),
    Mosaic {
        items: Vec<Ref>,
    },
    /// `v`: the upload time in ms, the cache-busting version of its URL.
    Upload {
        v: i64,
    },
}

impl Cover {
    fn refs(&self) -> &[Ref] {
        match self {
            Self::Item(r) => slice::from_ref(r),
            Self::Mosaic { items } => items,
            Self::Upload { .. } => &[],
        }
    }

    /// The programme items the cover shows, in order.
    pub fn items(&self) -> Vec<Item> {
        self.refs().iter().map(Ref::item).collect()
    }

    /// A cover a client may set: every item in `programme`, a mosaic of 2 to 4 distinct ones.
    pub fn check(&self, programme: &[Item]) -> Result<(), AppError> {
        let refs = self.refs();
        let distinct = refs.iter().enumerate().all(|(n, r)| !refs[..n].contains(r));
        let ok = match self {
            Self::Upload { .. } => false,
            Self::Item(_) => true,
            Self::Mosaic { items } => (2..=4).contains(&items.len()) && distinct,
        } && refs
            .iter()
            .all(|r| programme.iter().any(|i| same_row(i, &r.item())));
        if ok {
            Ok(())
        } else {
            Err(AppError::bad_request("party.error_invalid_cover"))
        }
    }

    /// What is left of the cover once the programme is `programme`.
    pub fn prune(&self, programme: &[Item]) -> Option<Self> {
        let mut kept: Vec<Ref> = self
            .refs()
            .iter()
            .filter(|r| programme.iter().any(|i| same_row(i, &r.item())))
            .cloned()
            .collect();
        match self {
            Self::Upload { .. } => Some(self.clone()),
            _ if kept.len() > 1 => Some(Self::Mosaic { items: kept }),
            _ => kept.pop().map(Self::Item),
        }
    }

    /// The viewer-facing cover, taking its items from `resolved` (the `items()` of every cover, in order).
    pub fn dto(&self, party: i32, resolved: &mut impl Iterator<Item = PartyItem>) -> CoverDto {
        match self {
            Self::Item(_) => CoverDto::Item {
                item: resolved.next().expect("one item resolved per ref"),
            },
            Self::Mosaic { items } => CoverDto::Mosaic {
                items: resolved.take(items.len()).collect(),
            },
            Self::Upload { v } => CoverDto::Upload {
                url: format!("/api/images/party/{party}?v={v}"),
            },
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoverDto {
    Item { item: PartyItem },
    Mosaic { items: Vec<PartyItem> },
    Upload { url: String },
}

impl CoverDto {
    pub fn items_mut(&mut self) -> &mut [PartyItem] {
        match self {
            Self::Item { item } => slice::from_mut(item),
            Self::Mosaic { items } => items,
            Self::Upload { .. } => &mut [],
        }
    }
}

/// The parties `user` owns that have an uploaded cover, whose rows go with the account.
pub async fn owned_uploads(db: &PgPool, user: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT id FROM watch_parties WHERE "ownerId" = $1 AND cover->>'kind' = 'upload'"#,
    )
    .bind(user)
    .fetch_all(db)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(media_id: i32) -> Item {
        Item {
            media_id,
            media_file_id: None,
            episode_id: None,
        }
    }
    fn r(media_id: i32) -> Ref {
        Ref {
            media_id,
            episode_id: None,
        }
    }

    #[test]
    fn prune_shrinks_a_mosaic_down_to_nothing() {
        let m = Cover::Mosaic {
            items: vec![r(1), r(2), r(3)],
        };
        let kept = |ids: &[i32]| m.prune(&ids.iter().map(|i| item(*i)).collect::<Vec<_>>());
        assert_eq!(
            kept(&[1, 3, 9]),
            Some(Cover::Mosaic {
                items: vec![r(1), r(3)]
            })
        );
        assert_eq!(kept(&[2]), Some(Cover::Item(r(2))));
        assert_eq!(kept(&[9]), None);
        assert_eq!(Cover::Item(r(1)).prune(&[]), None);
        assert_eq!(
            Cover::Upload { v: 1 }.prune(&[]),
            Some(Cover::Upload { v: 1 })
        );
    }

    #[test]
    fn check_wants_programme_items_and_a_sound_mosaic() {
        let programme: Vec<Item> = (1..=5).map(item).collect();
        let ok = |c: Cover| c.check(&programme).is_ok();
        assert!(ok(Cover::Item(r(5))));
        assert!(!ok(Cover::Item(r(6))));
        assert!(ok(Cover::Mosaic {
            items: vec![r(1), r(2)]
        }));
        assert!(!ok(Cover::Mosaic { items: vec![r(1)] }));
        assert!(!ok(Cover::Mosaic {
            items: vec![r(1), r(1)]
        }));
        assert!(!ok(Cover::Mosaic {
            items: (1..=5).map(r).collect()
        }));
        assert!(!ok(Cover::Upload { v: 1 }));
    }
}
