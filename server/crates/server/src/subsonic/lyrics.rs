//! `songLyrics` v2 (`opensubsonic.md` rule 32): `getLyricsBySongId` and the legacy `getLyrics`.
use super::{
    Caller, Params, catalog,
    ids::Id,
    render::{Answer, Obj, SubError},
};
use crate::{lyrics, state::AppState};
use serde_json::{Value, json};

fn one(key: &str, v: Value) -> Answer {
    let mut o = Obj::new();
    o.insert(key.into(), v);
    Ok(o)
}

pub async fn by_song_id(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Some(Id::Track(item)) = Id::parse(p.required("id")?) else {
        return Err(SubError::not_found());
    };
    if catalog::visible_tracks(&st.db, &c.libraries, &[item])
        .await?
        .is_empty()
    {
        return Err(SubError::not_found());
    }
    let mut body = lyrics::body(st, item, true, true, None, None).await?;
    let list = body["structuredLyrics"].take();
    one("lyricsList", json!({"structuredLyrics": list}))
}

/// The plain text of the preferred main lyrics of the first visible track named so.
pub async fn legacy(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let (artist, title) = (p.get("artist").unwrap_or(""), p.required("title")?);
    let items: Vec<i32> = sqlx::query_scalar(
        r#"SELECT i.id FROM items i WHERE lower(i.title) = lower($1) AND ($2 = '' OR EXISTS (
             SELECT 1 FROM item_credits c JOIN persons pe ON pe.id = c."personId"
             WHERE c."itemId" = i.id AND c.role = 'artist' AND lower(pe.name) = lower($2)))
           ORDER BY i.id"#,
    )
    .bind(title)
    .bind(artist)
    .fetch_all(&st.db)
    .await?;
    for (item, _) in catalog::visible_tracks(&st.db, &c.libraries, &items).await? {
        let mut rows = lyrics::store::list(&st.db, item).await?;
        lyrics::store::sort(&mut rows);
        if let Some(r) = rows.iter().find(|r| r.kind == "main") {
            let text: Vec<&str> = r.doc.0.lines.iter().map(|l| l.text.as_str()).collect();
            return one(
                "lyrics",
                json!({"artist": artist, "title": title, "value": text.join("\n")}),
            );
        }
    }
    one("lyrics", json!({}))
}
