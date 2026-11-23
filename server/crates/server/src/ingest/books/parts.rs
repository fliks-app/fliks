//! Several files as one version of an item (`docs/spec/book-ingest.md` rule 5).
use crate::media::items::lock_versions;
use sqlx::PgConnection;
use std::collections::{HashMap, HashSet};

/// `(file, version, position)` of every file of `versions`, keeping the version a file has in `existing`.
pub fn layout(existing: &[(i32, i32)], versions: &[Vec<i32>]) -> Vec<(i32, i32, i32)> {
    let had: HashMap<i32, i32> = existing.iter().copied().collect();
    let mut next = existing.iter().map(|e| e.1 + 1).max().unwrap_or(0);
    let mut claimed: HashSet<i32> = HashSet::new();
    let mut out = vec![];
    for files in versions {
        let kept = files
            .iter()
            .filter_map(|f| had.get(f).copied())
            .filter(|v| !claimed.contains(v))
            .min();
        let v = kept.unwrap_or_else(|| {
            next += 1;
            next - 1
        });
        claimed.insert(v);
        out.extend(files.iter().enumerate().map(|(i, f)| (*f, v, i as i32)));
    }
    out
}

/// Writes the layout of `item`; a part already where it belongs is left alone.
pub async fn write_versions(
    c: &mut PgConnection,
    media: i32,
    item: i32,
    versions: &[Vec<i32>],
) -> sqlx::Result<()> {
    lock_versions(c, media).await?;
    let rows = sqlx::query!(
        r#"SELECT "mediaFileId", "version", position FROM item_parts WHERE "itemId" = $1"#,
        item
    )
    .fetch_all(&mut *c)
    .await?;
    let old: Vec<(i32, i32, i32)> = rows
        .iter()
        .map(|r| (r.mediaFileId, r.version, r.position))
        .collect();
    let existing: Vec<(i32, i32)> = old.iter().map(|p| (p.0, p.1)).collect();
    let new = layout(&existing, versions);
    let at: HashSet<(i32, i32, i32)> = old.iter().copied().collect();
    let stale: Vec<(i32, i32, i32)> = new.iter().copied().filter(|p| !at.contains(p)).collect();
    if stale.is_empty() {
        return Ok(());
    }
    let (moved, states) = shifts(c, item, &old, &new, &stale).await?;
    let files: Vec<i32> = stale.iter().map(|p| p.0).collect();
    let vs: Vec<i32> = stale.iter().map(|p| p.1).collect();
    let ps: Vec<i32> = stale.iter().map(|p| p.2).collect();
    sqlx::query!(
        r#"DELETE FROM item_parts WHERE "itemId" = $1 AND "mediaFileId" = ANY($2)"#,
        item,
        &files
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version", position)
           SELECT $1, v.f, $2, v.v, v.p FROM UNNEST($3::int[], $4::int[], $5::int[]) AS v(f, v, p)"#,
        item,
        media,
        &files,
        &vs,
        &ps
    )
    .execute(&mut *c)
    .await?;
    follow(c, item, &moved, &states).await
}

/// `(file, from, to)` of each file that was a part and moved: its old and new version.
type Moved = Vec<(i32, i32, i32)>;

/// `(state, file, position)`: a saved place re-homed to the part its position falls in, with the
/// position counted from the start of that part's new version.
type States = Vec<(i32, i32, f64)>;

async fn shifts(
    c: &mut PgConnection,
    item: i32,
    old: &[(i32, i32, i32)],
    new: &[(i32, i32, i32)],
    stale: &[(i32, i32, i32)],
) -> sqlx::Result<(Moved, States)> {
    let ids: Vec<i32> = old.iter().map(|p| p.0).collect();
    let durations: HashMap<i32, f64> = sqlx::query_as::<_, (i32, Option<f64>)>(
        r#"SELECT id, ("streamInfo"->>'durationSeconds')::float8 FROM media_files WHERE id = ANY($1)"#,
    )
    .bind(&ids)
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .map(|(id, d)| (id, d.unwrap_or(0.0)))
    .collect();
    let offsets = |parts: &[(i32, i32, i32)]| {
        let mut sorted = parts.to_vec();
        sorted.sort_by_key(|p| (p.1, p.2));
        let (mut at, mut version) = (0.0, -1);
        let mut out = HashMap::new();
        for (f, v, _) in sorted {
            if v != version {
                (at, version) = (0.0, v);
            }
            out.insert(f, at);
            at += durations.get(&f).copied().unwrap_or(0.0);
        }
        out
    };
    let (before, after) = (offsets(old), offsets(new));
    let moved = stale
        .iter()
        .filter_map(|n| Some((n.0, old.iter().find(|o| o.0 == n.0)?.1, n.1)))
        .collect();
    let saved = sqlx::query_as::<_, (i32, i32, f64)>(
        r#"SELECT id, "mediaFileId", "positionSeconds" FROM playback_states
           WHERE "itemId" = $1 AND "mediaFileId" = ANY($2)"#,
    )
    .bind(item)
    .bind(&ids)
    .fetch_all(&mut *c)
    .await?;
    let stale_files: HashSet<i32> = stale.iter().map(|p| p.0).collect();
    let states = saved
        .into_iter()
        .filter_map(|(id, file, at)| {
            let version = old.iter().find(|o| o.0 == file)?.1;
            let mut parts: Vec<_> = old.iter().filter(|o| o.1 == version).collect();
            parts.sort_by_key(|p| p.2);
            let part = parts
                .iter()
                .rev()
                .find(|p| before[&p.0] <= at)
                .unwrap_or(&parts[0])
                .0;
            stale_files
                .contains(&part)
                .then(|| (id, part, at + after[&part] - before[&part]))
        })
        .collect();
    Ok((moved, states))
}

/// Carries each saved position to the part it falls in, and lets a version that no longer holds a
/// file resolve to the one that took it.
async fn follow(
    c: &mut PgConnection,
    item: i32,
    moved: &Moved,
    states: &States,
) -> sqlx::Result<()> {
    if moved.is_empty() {
        return Ok(());
    }
    let ids: Vec<i32> = states.iter().map(|s| s.0).collect();
    let files: Vec<i32> = states.iter().map(|s| s.1).collect();
    let at: Vec<f64> = states.iter().map(|s| s.2).collect();
    // Naming `"mediaFileId"` makes the `playback_states_version` trigger move the saved version.
    sqlx::query(
        r#"UPDATE playback_states ps SET "positionSeconds" = v.p, "mediaFileId" = v.f
           FROM UNNEST($1::int[], $2::int[], $3::float8[]) AS v(id, f, p)
           WHERE ps.id = v.id"#,
    )
    .bind(&ids)
    .bind(&files)
    .bind(&at)
    .execute(&mut *c)
    .await?;
    let from: Vec<i32> = moved.iter().map(|m| m.1).collect();
    let to: Vec<i32> = moved.iter().map(|m| m.2).collect();
    sqlx::query(
        r#"INSERT INTO item_version_aliases ("itemId", version, "toVersion")
           SELECT $1, v.f, min(v.t) FROM UNNEST($2::int[], $3::int[]) AS v(f, t)
           WHERE v.f <> v.t AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = $1 AND p.version = v.f)
           GROUP BY v.f
           ON CONFLICT ("itemId", version) DO UPDATE SET "toVersion" = EXCLUDED."toVersion""#,
    )
    .bind(item)
    .bind(&from)
    .bind(&to)
    .execute(&mut *c)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::layout;

    #[test]
    fn a_new_version_is_the_next_one_and_positions_follow_the_order() {
        assert_eq!(
            layout(&[], &[vec![5, 6, 7], vec![8]]),
            [(5, 0, 0), (6, 0, 1), (7, 0, 2), (8, 1, 0)]
        );
    }

    #[test]
    fn a_file_keeps_its_version_when_a_part_joins() {
        let l = layout(&[(5, 3), (6, 3), (8, 4)], &[vec![5, 6, 7], vec![8]]);
        assert_eq!(l, [(5, 3, 0), (6, 3, 1), (7, 3, 2), (8, 4, 0)]);
    }

    #[test]
    fn a_split_version_does_not_share_a_number() {
        let l = layout(&[(1, 0), (2, 0)], &[vec![1], vec![2]]);
        assert_eq!(l, [(1, 0, 0), (2, 1, 0)]);
    }
}
