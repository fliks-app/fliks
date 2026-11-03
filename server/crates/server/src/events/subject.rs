//! `buildMediaProgressSubject` / `formatMediaProgressSubject`: the one way to name a media or file.
use super::Subject;
use fliks_domain::media::kind::MediaKind;
use sqlx::PgPool;
use std::collections::HashMap;

impl Subject {
    pub fn titled(title: &str) -> Self {
        Self {
            title: title.to_owned(),
            ..Self::default()
        }
    }

    pub fn media(id: i32, title: &str, kind: Option<MediaKind>) -> Self {
        Self {
            media_id: Some(i64::from(id)),
            media_type: kind,
            ..Self::titled(title)
        }
    }

    /// No season, no episode; the number, title and id only come with a number.
    #[must_use]
    pub fn with_episode(
        mut self,
        id: Option<i32>,
        season: Option<i32>,
        number: Option<i32>,
        title: Option<String>,
    ) -> Self {
        let Some(season) = season else { return self };
        self.season_number = Some(i64::from(season));
        if let Some(number) = number {
            self.episode_number = Some(i64::from(number));
            self.episode_title = title;
            self.episode_id = id.map(i64::from);
        }
        self
    }

    pub fn format(&self) -> String {
        let Some(season) = self.season_number else {
            return self.title.clone();
        };
        let Some(ep) = self.episode_number else {
            return format!("{} S{season:02}", self.title);
        };
        match self.episode_title.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => format!("{} S{season:02}E{ep:02}: {t}", self.title),
            None => format!("{} S{season:02}E{ep:02}", self.title),
        }
    }
}

/// The subject of every file: its media, plus its episode; in chunks of 1 000 ids.
pub async fn for_files(db: &PgPool, ids: &[i32]) -> sqlx::Result<HashMap<i32, Subject>> {
    type Row = (
        i32,
        i32,
        String,
        String,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<i32>,
    );
    let mut out = HashMap::new();
    for chunk in ids.chunks(1000) {
        let rows: Vec<Row> = sqlx::query_as(
            r#"SELECT f.id, m.id, m."type", m.title, e.id, e."number", e.title, s."number"
               FROM media_files f JOIN media m ON m.id = f."mediaId"
               LEFT JOIN items e ON e.id = (SELECT fi."episodeId" FROM media_file_items fi WHERE fi."mediaFileId" = f.id) LEFT JOIN item_groups s ON s.id = e."groupId"
               WHERE f.id = ANY($1)"#,
        )
        .bind(chunk)
        .fetch_all(db)
        .await?;
        for (file, media, kind, title, ep, number, ep_title, season) in rows {
            let subject = Subject::media(media, &title, Some(crate::db::kind(&kind)?))
                .with_episode(ep, season, number, ep_title);
            out.insert(file, subject);
        }
    }
    Ok(out)
}

/// `for_files` of one file; `None` when the file or its media is gone.
pub async fn for_file(db: &PgPool, id: i32) -> sqlx::Result<Option<Subject>> {
    Ok(for_files(db, &[id]).await?.remove(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_text_matches_the_ts_formatter() {
        let mut s = Subject::media(1, "Show", Some(MediaKind::Series));
        assert_eq!(s.format(), "Show");
        s.season_number = Some(1);
        assert_eq!(s.format(), "Show S01");
        s.episode_number = Some(12);
        assert_eq!(s.format(), "Show S01E12");
        s.episode_title = Some("Pilot".into());
        assert_eq!(s.format(), "Show S01E12: Pilot");
    }

    #[test]
    fn an_episode_without_a_season_or_number_stays_partial() {
        let s = Subject::titled("Show");
        assert_eq!(s.clone().with_episode(Some(3), None, Some(2), None), s);
        let partial = s.with_episode(Some(3), Some(1), None, Some("Pilot".into()));
        assert_eq!(
            (
                partial.season_number,
                partial.episode_title,
                partial.episode_id
            ),
            (Some(1), None, None)
        );
    }
}
