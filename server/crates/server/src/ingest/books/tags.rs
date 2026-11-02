//! File tags and package metadata to hints and `file` records (`docs/spec/book-ingest.md` rule 12). Pure.
use crate::metadata::books::identify::BookHints;
use fliks_domain::{
    books::{
        filename::{BookNameGuess, parse_path},
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

fn guess_series(g: &BookNameGuess) -> Option<(String, Option<String>)> {
    g.series
        .clone()
        .map(|s| (s, g.series_position.map(position_text)))
}

pub fn name_hints(family: Family, name_path: &str) -> BookHints {
    let g = parse_path(name_path);
    BookHints {
        family,
        isbns: vec![],
        asin: None,
        title: g.title.clone(),
        authors: g.authors.clone(),
        narrators: g.narrators.clone(),
        language: None,
        series: guess_series(&g),
        year: g.year,
    }
}

/// An audio file: the tags first, the name of the file for what they lack.
pub fn audio_hints(tags: Option<&MediaTags>, name_path: &str) -> BookHints {
    let mut h = name_hints(Family::Audio, name_path);
    let Some(t) = tags else { return h };
    let pick = |a: &Option<String>, b: &Option<String>| a.clone().or_else(|| b.clone());
    h.title = pick(&t.album, &t.title).or(h.title);
    let authors = pick(&t.artist, &t.album_artist).map(|a| split_people(&a));
    h.authors = authors.filter(|a| !a.is_empty()).unwrap_or(h.authors);
    let narrators = t.narrator.as_deref().map(split_people);
    h.narrators = narrators.filter(|a| !a.is_empty()).unwrap_or(h.narrators);
    h.language = language(t.language.as_deref());
    if let Some(s) = &t.series {
        h.series = Some((s.clone(), t.series_part.clone()));
    }
    h.year = t.year.and_then(|y| i32::try_from(y).ok()).or(h.year);
    h.isbns = t
        .isbn
        .as_deref()
        .and_then(isbn::parse)
        .map(|i| vec![i.isbn13])
        .unwrap_or_default();
    h.asin = t
        .asin
        .as_deref()
        .and_then(|a| ExternalProvider::Asin.normalize(a));
    h
}

/// An EPUB: the package first, the name of the file for what it lacks.
pub fn epub_hints(m: &OpfMetadata, name_path: &str) -> BookHints {
    let mut h = name_hints(Family::Text, name_path);
    let named = |role| -> Vec<String> {
        m.creators
            .iter()
            .filter(|c| c.role == role)
            .map(|c| c.name.clone())
            .collect()
    };
    h.title = m.title.clone().or(h.title);
    let authors = named(Role::Aut);
    h.authors = if authors.is_empty() {
        h.authors
    } else {
        authors
    };
    let narrators = named(Role::Nrt);
    h.narrators = if narrators.is_empty() {
        h.narrators
    } else {
        narrators
    };
    h.language = language(m.language.as_deref());
    if let Some(s) = &m.series {
        h.series = Some((s.name.clone(), s.position.map(position_text)));
    }
    h.year = m.year.or(h.year);
    h.isbns = m.isbns.iter().map(|i| i.isbn13.clone()).collect();
    h.asin = m
        .asin
        .as_deref()
        .and_then(|a| ExternalProvider::Asin.normalize(a));
    h
}

fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

fn names(v: &[String]) -> Option<Value> {
    (!v.is_empty()).then(|| json!(v))
}

fn series_value(s: &Option<(String, Option<String>)>) -> Option<Value> {
    s.as_ref().map(|(n, p)| json!([{"name": n, "position": p}]))
}

/// The `file` record of an audio file for `attach_with`.
pub fn audio_record(tags: &MediaTags, h: &BookHints, duration: Option<f64>) -> Map<String, Value> {
    let mut m = Map::new();
    put(&mut m, "title", h.title.clone().map(Value::from));
    put(&mut m, "authors", names(&h.authors));
    put(&mut m, "narrators", names(&h.narrators));
    put(&mut m, "language", h.language.clone().map(Value::from));
    put(&mut m, "publisher", tags.publisher.clone().map(Value::from));
    put(&mut m, "year", h.year.map(Value::from));
    put(
        &mut m,
        "overview",
        tags.description.clone().map(Value::from),
    );
    put(&mut m, "series", series_value(&h.series));
    put(&mut m, "isbn13", names(&h.isbns));
    put(&mut m, "asin", h.asin.clone().map(Value::from));
    put(
        &mut m,
        "durationSeconds",
        duration
            .filter(|d| *d >= 1.0)
            .map(|d| Value::from(d.round() as i64)),
    );
    m
}

/// The `file` record of an EPUB for `attach_with`.
pub fn epub_record(meta: &OpfMetadata, h: &BookHints, format: &str) -> Map<String, Value> {
    let mut m = Map::new();
    put(&mut m, "title", h.title.clone().map(Value::from));
    put(&mut m, "subtitle", meta.subtitle.clone().map(Value::from));
    put(&mut m, "authors", names(&h.authors));
    put(&mut m, "narrators", names(&h.narrators));
    put(&mut m, "language", h.language.clone().map(Value::from));
    put(&mut m, "publisher", meta.publisher.clone().map(Value::from));
    put(&mut m, "year", h.year.map(Value::from));
    put(
        &mut m,
        "overview",
        meta.description.clone().map(Value::from),
    );
    put(&mut m, "subjects", names(&meta.subjects));
    put(&mut m, "series", series_value(&h.series));
    put(&mut m, "isbn13", names(&h.isbns));
    put(&mut m, "asin", h.asin.clone().map(Value::from));
    put(&mut m, "releaseDate", meta.date.clone().map(Value::from));
    m.insert("format".into(), format.into());
    m
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
            let got = json_of(&audio_hints(
                tags.as_ref(),
                c["input"]["namePath"].as_str().unwrap(),
            ));
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
        let h = epub_hints(&meta, "Autre Nom - Autre Titre.epub");
        assert_eq!(h.title.as_deref(), Some("Mirelune"));
        assert_eq!(h.authors, ["Olympe Faucheval"]);
        assert_eq!(h.language.as_deref(), Some("fr"));
        assert_eq!(h.isbns, ["9791234567896"]);
        let bare = epub_hints(
            &OpfMetadata::default(),
            "Aldric Vexmoor - Le Phare des Brumes.epub",
        );
        assert_eq!(bare.title.as_deref(), Some("Le Phare des Brumes"));
        assert_eq!(bare.authors, ["Aldric Vexmoor"]);
        let rec = epub_record(&meta, &h, "epub");
        assert_eq!(rec["format"], "epub");
        assert_eq!(rec["isbn13"], json!(["9791234567896"]));
    }
}
