//! `GET /api/media/:id/tracking` (`media-query.md` rules 39-46).
use fliks_domain::media::kind::MediaKind;
use fliks_domain::release::parsing::quality::{
    AppQuality, app_quality_by_id, parse_release_quality,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashMap;

fn label(d: &AppQuality) -> String {
    if d.resolution > 0 {
        format!("{}p", d.resolution)
    } else {
        d.name.to_owned()
    }
}

fn state_of(
    cutoff: Option<&AppQuality>,
    monitored: bool,
    qualities: &[&str],
) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("monitored".into(), monitored.into());
    let state = |m: &mut Map<String, Value>, s: &str| m.insert("state".into(), s.into());
    if !monitored {
        state(&mut m, "unmonitored");
        return m;
    }
    let Some(cutoff) = cutoff else {
        state(&mut m, "no-profile");
        return m;
    };
    if qualities.is_empty() {
        state(&mut m, "missing");
        return m;
    }
    let mut best: Option<&AppQuality> = None;
    for q in qualities {
        let def = parse_release_quality(q).quality;
        if best.is_none_or(|b| def.rank > b.rank) {
            best = Some(def);
        }
    }
    let best = best.expect("non-empty");
    if best.rank >= cutoff.rank {
        state(&mut m, "met");
        m.insert("currentQuality".into(), label(best).into());
        return m;
    }
    let same = best.resolution == cutoff.resolution;
    state(&mut m, "below");
    m.insert(
        "currentQuality".into(),
        if same {
            best.name.to_owned()
        } else {
            label(best)
        }
        .into(),
    );
    m.insert(
        "targetQuality".into(),
        if same {
            cutoff.name.to_owned()
        } else {
            label(cutoff)
        }
        .into(),
    );
    m
}

pub async fn tracking(db: &PgPool, id: i32) -> Result<Option<Value>, sqlx::Error> {
    let Some(media) = sqlx::query!(
        r#"SELECT m.type AS "kind!", m.monitored, qp.id AS "profile_id?", qp.cutoff AS "cutoff?"
           FROM media m LEFT JOIN quality_profiles qp ON qp.id = m."qualityProfileId" WHERE m.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let cutoff = media.cutoff.and_then(|c| app_quality_by_id(i64::from(c)));
    let has_profile = media.profile_id.is_some();
    let files = sqlx::query!(
        r#"SELECT quality, "episodeId" AS episode_id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        id
    )
    .fetch_all(db)
    .await?;
    match crate::db::kind(&media.kind)? {
        MediaKind::Movie => {
            let q: Vec<&str> = files.iter().map(|f| f.quality.as_str()).collect();
            return Ok(Some(
                json!({"type": MediaKind::Movie, "hasProfile": has_profile,
                "movie": state_of(cutoff, media.monitored, &q)}),
            ));
        }
        MediaKind::Series => {}
    }
    let mut by_episode: HashMap<i32, Vec<&str>> = HashMap::new();
    for f in &files {
        if let Some(e) = f.episode_id {
            by_episode.entry(e).or_default().push(&f.quality);
        }
    }
    let seasons = sqlx::query!(
        r#"SELECT id, "number" AS season_number FROM item_groups WHERE "mediaId" = $1
           ORDER BY ("number" = 0), "number", id"#,
        id
    )
    .fetch_all(db)
    .await?;
    let episodes = sqlx::query!(
        r#"SELECT e.id, e."groupId" AS "season_id!", e."number" AS "episode_number!",
                  e."endNumber" AS end_episode_number, e.title, e.monitored
           FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = $1
           ORDER BY e."number", e.id"#,
        id
    )
    .fetch_all(db)
    .await?;
    let out: Vec<Value> = seasons
        .iter()
        .map(|s| {
            let eps: Vec<_> = episodes.iter().filter(|e| e.season_id == s.id).collect();
            let shadowed = |n: i32| {
                eps.iter().any(|o| {
                    o.end_episode_number.is_some_and(|end| {
                        end > o.episode_number && n > o.episode_number && n <= end
                    })
                })
            };
            let list: Vec<Value> = eps
                .iter()
                .filter(|e| !shadowed(e.episode_number))
                .map(|e| {
                    let q = by_episode.get(&e.id).map_or(&[][..], Vec::as_slice);
                    let mut m = Map::new();
                    m.insert("episodeId".into(), e.id.into());
                    m.insert("seasonNumber".into(), s.season_number.into());
                    m.insert("episodeNumber".into(), e.episode_number.into());
                    m.insert("endEpisodeNumber".into(), e.end_episode_number.into());
                    m.insert("title".into(), e.title.clone().into());
                    m.extend(state_of(cutoff, e.monitored, q));
                    Value::Object(m)
                })
                .collect();
            json!({"seasonNumber": s.season_number, "episodes": list})
        })
        .collect();
    Ok(Some(
        json!({"type": MediaKind::Series, "hasProfile": has_profile, "seasons": out}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_resolution_below_names_the_qualities() {
        let cutoff = app_quality_by_id(18);
        let m = state_of(cutoff, true, &["WEBDL-1080p"]);
        assert_eq!(m["state"], "below");
        assert_eq!(m["currentQuality"], "WEBDL-1080p");
        assert_eq!(m["targetQuality"], "Bluray-1080p");
        assert_eq!(
            state_of(cutoff, true, &["Bluray-1080p"])["currentQuality"],
            "1080p"
        );
        assert_eq!(state_of(None, true, &[])["state"], "no-profile");
    }
}
