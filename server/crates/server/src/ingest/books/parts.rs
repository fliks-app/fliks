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
    let existing: Vec<(i32, i32)> = rows.iter().map(|r| (r.mediaFileId, r.version)).collect();
    let at: HashSet<(i32, i32, i32)> = rows
        .iter()
        .map(|r| (r.mediaFileId, r.version, r.position))
        .collect();
    let stale: Vec<(i32, i32, i32)> = layout(&existing, versions)
        .into_iter()
        .filter(|p| !at.contains(p))
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
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
