//! File tags and package metadata to `file` records and the hints read back from them (`docs/spec/book-ingest.md` rule 12). Pure.
use crate::metadata::books::identify::BookHints;
use fliks_domain::{
    books::{
        filename::parse_path,
        isbn,
        opf::{OpfMetadata, Role},
    },
    external_id::ExternalProvider,
    language::normalize_language_code,
    media::family::Family,
};
use fliks_engine_core::api::MediaTags;
use serde_json::{Map, Value, json};

fn split_people(s: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for p in s
        .split(';')
        .flat_map(|p| p.split(" & "))
        .flat_map(|p| p.split(" / "))
    {
        let p = p.trim();
        if !p.is_empty() && !out.iter().any(|o| o == p) {
            out.push(p.to_owned());
        }
    }
    out
}

fn language(raw: Option<&str>) -> Option<String> {
    Some(normalize_language_code(raw)).filter(|l| l != "und")
}

fn position_text(p: f64) -> String {
    p.to_string()
}

fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

fn names(v: &[String]) -> Option<Value> {
    (!v.is_empty()).then(|| json!(v))
}

fn series_value(name: &str, position: Option<String>) -> Value {
    json!([{"name": name, "position": position}])
}

/// The record the name of a file gives: title, people, series, year.
pub fn name_record(name_path: &str) -> Map<String, Value> {
    let g = parse_path(name_path);
    let mut m = Map::new();
    put(&mut m, "title", g.title.map(Value::from));
    put(&mut m, "authors", names(&g.authors));
    put(&mut m, "narrators", names(&g.narrators));
    put(
        &mut m,
        "series",
        g.series
            .map(|s| series_value(&s, g.series_position.map(position_text))),
    );
    put(&mut m, "year", g.year.map(Value::from));
    m
}

/// An audio file: the tags first, the name of the file for what they lack.
pub fn audio_record(
    tags: Option<&MediaTags>,
    name_path: &str,
    duration: Option<f64>,
) -> Map<String, Value> {
    let mut m = name_record(name_path);
    let Some(t) = tags else { return m };
    let pick = |a: &Option<String>, b: &Option<String>| a.clone().or_else(|| b.clone());
    put(&mut m, "title", pick(&t.album, &t.title).map(Value::from));
    let authors = pick(&t.artist, &t.album_artist).map(|a| split_people(&a));
    put(&mut m, "authors", authors.as_deref().and_then(names));
    let narrators = t.narrator.as_deref().map(split_people);
    put(&mut m, "narrators", narrators.as_deref().and_then(names));
    put(
        &mut m,
        "language",
        language(t.language.as_deref()).map(Value::from),
    );
    put(&mut m, "publisher", t.publisher.clone().map(Value::from));
    put(
        &mut m,
        "year",
        t.year.and_then(|y| i32::try_from(y).ok()).map(Value::from),
    );
    put(&mut m, "overview", t.description.clone().map(Value::from));
    if let Some(s) = &t.series {
        m.insert("series".into(), series_value(s, t.series_part.clone()));
    }
    let isbn = t.isbn.as_deref().and_then(isbn::parse);
    put(&mut m, "isbn13", isbn.map(|i| json!([i.isbn13])));
    put(&mut m, "asin", asin(t.asin.as_deref()));
    put(
        &mut m,
        "durationSeconds",
        duration
            .filter(|d| *d >= 1.0)
            .map(|d| Value::from(d.round() as i64)),
    );
    m
}

fn asin(raw: Option<&str>) -> Option<Value> {
    raw.and_then(|a| ExternalProvider::Asin.normalize(a))
        .map(Value::from)
}

/// An EPUB: the package first, the name of the file for what it lacks.
pub fn epub_record(m: &OpfMetadata, name_path: &str, format: &str) -> Map<String, Value> {
    let mut r = name_record(name_path);
    let named = |role| -> Vec<String> {
        m.creators
            .iter()
            .filter(|c| c.role == role)
            .map(|c| c.name.clone())
            .collect()
    };
    put(&mut r, "title", m.title.clone().map(Value::from));
    put(&mut r, "subtitle", m.subtitle.clone().map(Value::from));
    put(&mut r, "authors", names(&named(Role::Aut)));
    put(&mut r, "narrators", names(&named(Role::Nrt)));
    put(
        &mut r,
        "language",
        language(m.language.as_deref()).map(Value::from),
    );
    put(&mut r, "publisher", m.publisher.clone().map(Value::from));
    put(&mut r, "year", m.year.map(Value::from));
    put(&mut r, "overview", m.description.clone().map(Value::from));
    put(&mut r, "subjects", names(&m.subjects));
    // A file name that numbers the volume beats a package series that does not.
    let numbered = r
        .get("series")
        .is_some_and(|v| v[0]["position"].is_string());
    if let Some(s) = m
        .series
        .as_ref()
        .filter(|s| s.position.is_some() || !numbered)
    {
        r.insert(
            "series".into(),
            series_value(&s.name, s.position.map(position_text)),
        );
    }
    let isbns: Vec<String> = m.isbns.iter().map(|i| i.isbn13.clone()).collect();
    put(&mut r, "isbn13", names(&isbns));
    put(&mut r, "asin", asin(m.asin.as_deref()));
    put(&mut r, "releaseDate", m.date.clone().map(Value::from));
    r.insert("format".into(), format.into());
    r
}

impl BookHints {
    /// What identifies a book, read back from its file record.
    pub fn of_record(family: Family, r: &Map<String, Value>) -> Self {
        let text = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
        let list = |k: &str| -> Vec<String> {
            r.get(k)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            family,
            isbns: list("isbn13"),
            asin: text("asin"),
            title: text("title"),
            authors: list("authors"),
            narrators: list("narrators"),
            language: text("language"),
            series: r.get("series").and_then(|s| s.get(0)).and_then(|s| {
                let position = s.get("position").and_then(Value::as_str);
                Some((
                    s.get("name")?.as_str()?.to_owned(),
                    position.map(str::to_owned),
                ))
            }),
            year: r
                .get("year")
                .and_then(Value::as_i64)
                .and_then(|y| i32::try_from(y).ok()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fliks_domain::books::opf;

    fn json_of(h: &BookHints) -> Value {
        json!({
            "family": h.family, "isbns": h.isbns, "asin": h.asin, "title": h.title,
            "authors": h.authors, "narrators": h.narrators, "language": h.language,
            "series": h.series, "year": h.year,
        })
    }

    #[test]
    fn tags_reproduce_expected() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/books-tags/cases.json"
        );
        let mut fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let bless = std::env::var("BLESS").is_ok_and(|v| v == "1");
        let cases = fx["cases"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 5);
        for (i, c) in cases.iter().enumerate() {
            let tags: Option<MediaTags> =
                serde_json::from_value(c["input"]["tags"].clone()).unwrap();
            let record = audio_record(
                tags.as_ref(),
                c["input"]["namePath"].as_str().unwrap(),
                None,
            );
            let got = json_of(&BookHints::of_record(Family::Audio, &record));
            if bless {
                fx["cases"][i]["expected"] = got;
            } else {
                assert_eq!(got, c["expected"], "case {}", c["name"]);
            }
        }
        if bless {
            let list = fx["cases"].as_array().unwrap();
            let body: Vec<String> = list.iter().map(Value::to_string).collect();
            std::fs::write(path, format!("{{\"cases\":[\n{}\n]}}\n", body.join(",\n"))).unwrap();
        }
    }

    #[test]
    fn the_opf_wins_over_the_name_and_the_name_fills_the_gaps() {
        let meta = opf::parse(
            br#"<package><metadata xmlns:dc="x"><dc:title>Mirelune</dc:title>
            <dc:creator>Olympe Faucheval</dc:creator><dc:language>fre</dc:language>
            <dc:identifier>urn:isbn:9791234567896</dc:identifier></metadata></package>"#,
        );
        let rec = epub_record(&meta, "Autre Nom - Autre Titre.epub", "epub");
        let h = BookHints::of_record(Family::Text, &rec);
        assert_eq!(h.title.as_deref(), Some("Mirelune"));
        assert_eq!(h.authors, ["Olympe Faucheval"]);
        assert_eq!(h.language.as_deref(), Some("fr"));
        assert_eq!(h.isbns, ["9791234567896"]);
        let bare = BookHints::of_record(
            Family::Text,
            &epub_record(
                &OpfMetadata::default(),
                "Aldric Vexmoor - Le Phare des Brumes.epub",
                "epub",
            ),
        );
        assert_eq!(bare.title.as_deref(), Some("Le Phare des Brumes"));
        assert_eq!(bare.authors, ["Aldric Vexmoor"]);
        assert_eq!(rec["format"], "epub");
        assert_eq!(rec["isbn13"], json!(["9791234567896"]));
    }

    #[test]
    fn a_numbered_file_name_series_beats_an_unnumbered_package_series() {
        let series = |opf: &str, name: &str| {
            let meta = opf::parse(
                format!(r#"<package><metadata xmlns:dc="x"><dc:title>T</dc:title>{opf}</metadata></package>"#)
                    .as_bytes(),
            );
            epub_record(&meta, name, "epub")["series"].clone()
        };
        let stray = r#"<meta name="calibre:series" content="Stray Shelf"/>"#;
        let numbered = r#"<meta name="calibre:series" content="Saga"/><meta name="calibre:series_index" content="4"/>"#;
        assert_eq!(
            series(stray, "Ana Placeholder - Saga T3 - Title.epub"),
            json!([{"name": "Saga", "position": "3"}])
        );
        assert_eq!(
            series(stray, "Ana Placeholder - Title.epub"),
            json!([{"name": "Stray Shelf", "position": null}])
        );
        assert_eq!(
            series(numbered, "Ana Placeholder - Other T3 - Title.epub"),
            json!([{"name": "Saga", "position": "4"}])
        );
    }
}
