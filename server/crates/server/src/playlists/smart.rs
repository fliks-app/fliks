//! Smart playlist evaluation (`docs/spec/playlists.md` rules 50-54): the rules as SQL over tracks.
use fliks_domain::music::playlist_rules::{Criterion, LOSSLESS_CODECS, Match, SmartRules, SortBy};
use sqlx::{PgPool, Postgres, QueryBuilder};
use std::collections::HashMap;

type Qb = QueryBuilder<Postgres>;

const ITEM_ARTIST: &str = r#"SELECT p.name AS name, c."creditedName" AS credited, p."sortName" AS sort_name, c.position AS pos
  FROM item_credits c JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist'"#;
const MEDIA_ARTIST: &str = r#"SELECT p.name AS name, NULL AS credited, p."sortName" AS sort_name, c.position AS pos
  FROM media_credits c JOIN persons p ON p.id = c."personId"
  WHERE c."mediaId" = m.id AND c.role = 'artist' AND c."editionId" IS NULL"#;
const PLAYS: &str = r#"(SELECT count(*) FROM playback_history h WHERE h."userId" = "#;
const LAST: &str = r#"(SELECT max(h."playedAt") FROM playback_history h WHERE h."userId" = "#;
const LIKED: &str = r#"EXISTS (SELECT 1 FROM likes l WHERE l."userId" = "#;
const DURATION: &str = r#"COALESCE(td."durationMs"::float8 / 1000, pf.dur)"#;

fn like(s: &str) -> String {
    format!(
        "%{}%",
        s.trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn range<'a, T: sqlx::Encode<'a, Postgres> + sqlx::Type<Postgres> + Send + 'a>(
    qb: &mut Qb,
    expr: &str,
    min: Option<T>,
    max: Option<T>,
) {
    qb.push("(");
    let mut first = true;
    for (op, v) in [(">=", min), ("<=", max)] {
        if let Some(v) = v {
            if !first {
                qb.push(" AND ");
            }
            first = false;
            qb.push(expr).push(format!(" {op} ")).push_bind(v);
        }
    }
    qb.push(")");
}

fn days(qb: &mut Qb, expr: &str, within: Option<i32>, older: Option<i32>, never: bool) {
    qb.push("(");
    let mut first = true;
    if let Some(d) = within {
        first = false;
        qb.push(format!("{expr} >= now() - make_interval(days => "))
            .push_bind(d)
            .push(")");
    }
    if let Some(d) = older {
        if !first {
            qb.push(" AND ");
        }
        qb.push(format!("({expr} < now() - make_interval(days => "))
            .push_bind(d)
            .push(")");
        if never {
            qb.push(format!(" OR {expr} IS NULL"));
        }
        qb.push(")");
    }
    qb.push(")");
}

/// Artist credits of the track, falling back to the album's when the track has none (as `TrackRow`).
fn artist_like(qb: &mut Qb, name: &str, with_item: bool) {
    let pat = like(name);
    let test = " WHERE (a.name ILIKE ";
    if with_item {
        qb.push(format!("(EXISTS (SELECT 1 FROM ({ITEM_ARTIST}) a{test}"))
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR a.credited ILIKE ")
            .push_bind(pat.clone())
            .push(format!(
                " ESCAPE '\\')) OR (NOT EXISTS (SELECT 1 FROM ({ITEM_ARTIST}) a0) AND EXISTS (SELECT 1 FROM ({MEDIA_ARTIST}) a{test}"
            ))
            .push_bind(pat)
            .push(" ESCAPE '\\'))))");
    } else {
        qb.push(format!("EXISTS (SELECT 1 FROM ({MEDIA_ARTIST}) a{test}"))
            .push_bind(pat)
            .push(" ESCAPE '\\'))");
    }
}

fn criterion(qb: &mut Qb, c: &Criterion, owner: i32) {
    match c {
        Criterion::Artist { name } => artist_like(qb, name, true),
        Criterion::AlbumArtist { name } => artist_like(qb, name, false),
        Criterion::Composer { name } => {
            let pat = like(name);
            qb.push(
                r#"(EXISTS (SELECT 1 FROM item_credits c JOIN persons p ON p.id = c."personId"
    WHERE c."itemId" = i.id AND c.role = 'composer' AND p.name ILIKE "#,
            )
            .push_bind(pat.clone())
            .push(
                r#" ESCAPE '\') OR EXISTS (SELECT 1 FROM item_works iw JOIN works w ON w.id = iw."workId"
    JOIN persons p ON p.id = w."composerPersonId" WHERE iw."itemId" = i.id AND p.name ILIKE "#,
            )
            .push_bind(pat)
            .push(r#" ESCAPE '\'))"#);
        }
        Criterion::Work { title } => {
            qb.push(
                r#"EXISTS (SELECT 1 FROM item_works iw JOIN works w ON w.id = iw."workId"
    WHERE iw."itemId" = i.id AND w.title ILIKE "#,
            )
            .push_bind(like(title))
            .push(r#" ESCAPE '\')"#);
        }
        Criterion::Genre { name } => {
            qb.push(
                "(jsonb_typeof(m.genres) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.genres) g WHERE lower(g) = lower(",
            )
            .push_bind(name.trim())
            .push(")))");
        }
        Criterion::Year { min, max } => range(qb, "m.year", *min, *max),
        Criterion::OriginalYear { min, max } => range(
            qb,
            r#"EXTRACT(year FROM ad."firstReleaseDate")::int"#,
            *min,
            *max,
        ),
        Criterion::ReleaseType { types } => {
            qb.push(r#"(ad."primaryType" = ANY("#)
                .push_bind(types)
                .push(r#") OR ad."secondaryTypes" && "#)
                .push_bind(types)
                .push("::text[])");
        }
        Criterion::Compilation { value } => {
            qb.push(r#"(COALESCE(ad."isCompilation", false) = "#)
                .push_bind(*value)
                .push(")");
        }
        Criterion::Favourite { value } => {
            qb.push(format!("({LIKED}{owner} AND l.\"itemId\" = i.id) = "))
                .push_bind(*value)
                .push(")");
        }
        Criterion::PlayCount { min, max } => {
            let expr = format!("{PLAYS}{owner} AND h.\"itemId\" = i.id)");
            range(qb, &expr, *min, *max);
        }
        Criterion::LastPlayed {
            within_days,
            older_than_days,
        } => {
            let expr = format!("{LAST}{owner} AND h.\"itemId\" = i.id)");
            days(qb, &expr, *within_days, *older_than_days, true);
        }
        Criterion::AddedAt {
            within_days,
            older_than_days,
        } => days(
            qb,
            r#"i."createdAt""#,
            *within_days,
            *older_than_days,
            false,
        ),
        Criterion::Duration {
            min_seconds,
            max_seconds,
        } => range(qb, DURATION, *min_seconds, *max_seconds),
        Criterion::Lossless { value } => {
            qb.push("(COALESCE(lower(pf.codec) = ANY(")
                .push_bind(LOSSLESS_CODECS.map(String::from).to_vec())
                .push(r#") OR lower(pf.codec) LIKE 'pcm\_%', false) = "#)
                .push_bind(*value)
                .push(")");
        }
        Criterion::Codec { codecs } => {
            qb.push("(lower(pf.codec) = ANY(")
                .push_bind(
                    codecs
                        .iter()
                        .map(|c| c.trim().to_lowercase())
                        .collect::<Vec<_>>(),
                )
                .push("))");
        }
        Criterion::Popularity { min, max } => range(qb, "td.popularity", *min, *max),
        Criterion::Library { ids } => {
            qb.push(r#"(COALESCE(e."libraryId", m."libraryId") = ANY("#)
                .push_bind(ids)
                .push("))");
        }
    }
}

fn sort_expr(by: SortBy, owner: i32) -> String {
    match by {
        SortBy::Artist => format!(
            "lower(COALESCE((SELECT COALESCE(a.sort_name, a.name) FROM ({ITEM_ARTIST}) a ORDER BY a.pos LIMIT 1), (SELECT COALESCE(a.sort_name, a.name) FROM ({MEDIA_ARTIST}) a ORDER BY a.pos LIMIT 1)))"
        ),
        SortBy::Album => "lower(m.title)".into(),
        SortBy::Title => "lower(i.title)".into(),
        SortBy::Year => "m.year".into(),
        SortBy::PlayCount => format!("{PLAYS}{owner} AND h.\"itemId\" = i.id)"),
        SortBy::LastPlayed => format!("{LAST}{owner} AND h.\"itemId\" = i.id)"),
        SortBy::AddedAt => r#"i."createdAt""#.into(),
        SortBy::Duration => DURATION.into(),
        SortBy::Popularity => "td.popularity".into(),
        SortBy::Random => "hashtextextended(i.id::text || current_date::text, 0)".into(),
    }
}

/// The track item ids the rules select, sorted and limited; `owner` supplies favourites and
/// plays, `acl` the readable libraries.
pub async fn evaluate(
    db: &PgPool,
    owner: i32,
    acl: &[i32],
    rules: &SmartRules,
) -> sqlx::Result<Vec<i32>> {
    let mut qb: Qb = QueryBuilder::new(
        r#"SELECT i.id FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
LEFT JOIN album_details ad ON ad."mediaId" = m.id
JOIN LATERAL (SELECT f."streamInfo"->'audio'->0->>'codec' AS codec,
      (f."streamInfo"->>'durationSeconds')::float8 AS dur
    FROM item_parts p JOIN media_files f ON f.id = p."mediaFileId"
    WHERE p."itemId" = i.id ORDER BY p.version DESC, p.position LIMIT 1) pf ON true
WHERE COALESCE(e."libraryId", m."libraryId") = ANY("#,
    );
    qb.push_bind(acl).push(") AND (");
    let join = if rules.match_ == Match::All {
        " AND "
    } else {
        " OR "
    };
    for (n, c) in rules.criteria.iter().enumerate() {
        if n > 0 {
            qb.push(join);
        }
        criterion(&mut qb, c, owner);
    }
    qb.push(") ORDER BY ")
        .push(sort_expr(rules.sort.by, owner))
        .push(if rules.sort.descending {
            " DESC"
        } else {
            " ASC"
        })
        .push(r#" NULLS LAST, lower(m.title), m.id, td."discNumber", td.position, i.id"#);
    if let Some(l) = rules.limit {
        qb.push(" LIMIT ").push_bind(i64::from(l));
    }
    qb.build_query_scalar().fetch_all(db).await
}

/// `itemCount` and up to 4 distinct album posters of an evaluation, in track order.
pub async fn stats(db: &PgPool, ids: &[i32]) -> sqlx::Result<(i32, Vec<String>)> {
    let rows: Vec<(i32, Option<String>)> = sqlx::query_as(
        r#"SELECT i.id, m."posterUrl" FROM items i JOIN media m ON m.id = i."mediaId"
           WHERE i.id = ANY($1)"#,
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    let poster: HashMap<i32, String> = rows
        .into_iter()
        .filter_map(|(i, p)| Some((i, p?)))
        .collect();
    let mut posters: Vec<String> = vec![];
    for p in ids.iter().filter_map(|i| poster.get(i)) {
        if posters.len() == 4 {
            break;
        }
        if !posters.contains(p) {
            posters.push(p.clone());
        }
    }
    Ok((i32::try_from(ids.len()).unwrap_or(i32::MAX), posters))
}
