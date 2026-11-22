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
    let moved = shifts(c, &old, &new, &stale).await?;
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
    follow(c, item, &moved).await
}

/// `(file, from, to, shift)` of each file that was a part and moved: its old and new version, and
/// how far its start moved on the version's timeline.
type Moved = Vec<(i32, i32, i32, f64)>;

async fn shifts(
    c: &mut PgConnection,
    old: &[(i32, i32, i32)],
    new: &[(i32, i32, i32)],
    stale: &[(i32, i32, i32)],
) -> sqlx::Result<Moved> {
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
    Ok(stale
        .iter()
        .filter_map(|n| {
            let o = old.iter().find(|o| o.0 == n.0)?;
            Some((n.0, o.1, n.1, after[&n.0] - before[&n.0]))
        })
        .collect())
}

/// Carries each saved position to the file's new place, and lets a version that no longer holds a
/// file resolve to the one that took it.
async fn follow(c: &mut PgConnection, item: i32, moved: &Moved) -> sqlx::Result<()> {
    if moved.is_empty() {
        return Ok(());
    }
    let files: Vec<i32> = moved.iter().map(|m| m.0).collect();
    let by: Vec<f64> = moved.iter().map(|m| m.3).collect();
    // Naming `"mediaFileId"` makes the `playback_states_version` trigger move the saved version.
    sqlx::query(
        r#"UPDATE playback_states ps SET "positionSeconds" = ps."positionSeconds" + v.s, "mediaFileId" = ps."mediaFileId"
           FROM UNNEST($2::int[], $3::float8[]) AS v(f, s)
           WHERE ps."itemId" = $1 AND ps."mediaFileId" = v.f"#,
    )
    .bind(item)
    .bind(&files)
    .bind(&by)
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
