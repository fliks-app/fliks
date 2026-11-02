//! The watched rule (`media-query.md` rule 20), one SQL fragment for every kind.
use fliks_domain::media::kind::MediaKind;
use std::fmt::Display;

/// The seasonal kinds as a SQL `text[]` literal; registry constants, never user text.
fn seasonal_array() -> String {
    let kinds = MediaKind::seasonal_names();
    debug_assert!(kinds.iter().all(|n| !n.contains('\'')));
    let names: Vec<String> = kinds.into_iter().map(|n| format!("'{n}'")).collect();
    format!("ARRAY[{}]::text[]", names.join(", "))
}

/// Seasonal: every on-disk item of its groups above 0 is completed; any other: one item is completed.
/// `uid` is a user id, a bound parameter or a column, never user text; `m` aliases the media row.
pub(crate) fn predicate(uid: impl Display, m: &str) -> String {
    let seasonal = seasonal_array();
    format!(
        r#"CASE WHEN {m}.type = ANY({seasonal}) THEN
    EXISTS (
      SELECT 1 FROM item_groups s JOIN items e ON e."groupId" = s.id
      WHERE s."mediaId" = {m}.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM item_groups s JOIN items e ON e."groupId" = s.id
      WHERE s."mediaId" = {m}.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
        AND NOT EXISTS (
          SELECT 1 FROM playback_states ps2
          WHERE ps2."userId" = {uid} AND ps2."itemId" = e.id AND ps2.completed = true
        )
    )
  ELSE EXISTS (
      SELECT 1 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
      WHERE ps."userId" = {uid} AND i."mediaId" = {m}.id AND ps.completed = true
    )
  END"#
    )
}

/// The percentage of the most recent unfinished ungrouped item of a media; `0` for a seasonal kind, 100 for a watched book.
pub(crate) fn progress(uid: impl Display, m: &str) -> String {
    let seasonal = seasonal_array();
    let (book, watched) = (MediaKind::Book.as_str(), predicate(&uid, m));
    format!(
        r#"CASE WHEN {m}.type = ANY({seasonal}) THEN 0 WHEN {m}.type = '{book}' AND ({watched}) THEN 100 ELSE COALESCE((
    SELECT ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)::int
    FROM playback_states ps JOIN items i ON i.id = ps."itemId"
    WHERE ps."userId" = {uid} AND i."mediaId" = {m}.id AND i."groupId" IS NULL
      AND ps.completed = false AND ps."durationSeconds" > 0
    ORDER BY ps."lastPlayedAt" DESC LIMIT 1
  ), 0) END"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_come_from_the_registry_and_the_other_arm_is_never_null() {
        assert!(predicate(1, "m").contains("ANY(ARRAY['series']::text[])"));
        let p = progress("$1", "m");
        assert!(p.contains("ELSE COALESCE(") && p.contains("), 0) END"));
        assert!(p.contains("type = 'book' AND (CASE WHEN") && p.contains("THEN 100 ELSE"));
        assert!(!p.contains("'movie'") && !predicate(1, "m").contains("'movie'"));
    }
}
