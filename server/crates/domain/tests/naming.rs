//! Golden naming vectors (`fixtures/naming`; `BLESS=1` rewrites `expected`) and the rules without a vector.
mod common;

use common::replay;
use fliks_domain::naming::*;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Special {
    title: Option<String>,
}

impl HasTitle for Special {
    fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
}

fn data<T: for<'de> Deserialize<'de>>(i: &Value) -> T {
    serde_json::from_value(i["data"].clone()).unwrap()
}

#[test]
fn naming_reproduces_expected() {
    replay("naming", 2321, |i| {
        let s = |k: &str| i[k].as_str().unwrap();
        match s("fn") {
            "getFormats" => {
                let rows: Vec<(String, Option<String>)> = i["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        (
                            r["key"].as_str().unwrap().into(),
                            r["value"].as_str().map(Into::into),
                        )
                    })
                    .collect();
                json!(formats_from_rows(&rows))
            }
            "applyMovieFormat" => json!(apply_movie_format(s("format"), &data(i))),
            "applySeriesFormat" => json!(apply_series_format(s("format"), &data(i))),
            "applyMovieFolderFormat" => json!(apply_movie_folder_format(s("format"), &data(i))),
            "applySeriesFolderFormat" => json!(apply_series_folder_format(s("format"), &data(i))),
            "applySeasonFolderFormat" => {
                json!(apply_season_folder_format(
                    s("format"),
                    i["data"]["season"].as_i64().unwrap()
                ))
            }
            "extractReleaseGroup" => json!(extract_release_group(s("title"))),
            "parseEpisodeNumbers" => {
                json!(parse_episode_numbers(s("title"), i["filePath"].as_str()))
            }
            "isSpecialFile" => json!(is_special_file(s("path"))),
            _ => {
                let specials: Vec<Special> = serde_json::from_value(i["specials"].clone()).unwrap();
                json!(match_special_by_title(s("filename"), &specials))
            }
        }
    });
}

#[test]
fn dollar_signs_in_titles_are_literal() {
    let f = |t: &str| MovieFolder {
        title: t.into(),
        ..Default::default()
    };
    assert_eq!(
        apply_movie_folder_format("{Movie Title}", &f("Money $$$")),
        "Money $$$"
    );
    assert_eq!(
        apply_movie_folder_format("{Movie Title}", &f("A $& B")),
        "A $& B"
    );
}

#[test]
fn folder_results_are_not_remapped() {
    let f = |t: &str| SeriesFolder {
        series_title: t.into(),
        ..Default::default()
    };
    assert_eq!(apply_series_folder_format("{Series Title}", &f("..")), "..");
    assert_eq!(apply_series_folder_format("{Series Title}", &f("???")), "");
    assert_eq!(apply_series_folder_format("{Series Title}", &f(".")), ".");
}

#[test]
fn empty_formats_render_empty() {
    let m = MovieFile {
        title: "T".into(),
        quality: "q".into(),
        ..Default::default()
    };
    assert_eq!(apply_movie_format("", &m), "");
    assert_eq!(
        formats_from_rows(&[("naming_movie_format".into(), Some(String::new()))]).movie,
        ""
    );
}

#[test]
fn folder_name_validator() {
    assert_eq!(validate_folder_name("Show (2020)"), Ok("Show (2020)"));
    assert_eq!(validate_folder_name(""), Err(FolderNameError::Empty));
    assert_eq!(validate_folder_name("."), Err(FolderNameError::Dot));
    assert_eq!(validate_folder_name(".."), Err(FolderNameError::DotDot));
    assert_eq!(validate_folder_name("a/b"), Err(FolderNameError::Separator));
    assert_eq!(
        validate_folder_name("a\\b"),
        Err(FolderNameError::Separator)
    );
    assert_eq!(validate_folder_name("a\0b"), Err(FolderNameError::Nul));
    assert_eq!(validate_folder_name("..."), Ok("..."));
}
