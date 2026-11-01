//! Golden book-file vectors (`fixtures/books-opf`, `books-names`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::books::{filename, isbn, opf};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn bytes(i: &Value) -> Vec<u8> {
    match i["hex"].as_str() {
        Some(h) => (0..h.len())
            .step_by(2)
            .map(|k| u8::from_str_radix(&h[k..k + 2], 16).unwrap())
            .collect(),
        None => i["xml"].as_str().unwrap().as_bytes().to_vec(),
    }
}

#[test]
fn opf_reproduces_expected() {
    replay("books-opf", 56, |i| match i["fn"].as_str().unwrap() {
        "opf" => json!(opf::parse(&bytes(i))),
        "container" => json!(opf::container_rootfile(&bytes(i))),
        "isbn" => json!(isbn::parse(i["raw"].as_str().unwrap())),
        "href" => json!(opf::resolve_href(
            i["opf"].as_str().unwrap(),
            i["href"].as_str().unwrap()
        )),
        f => panic!("unknown fn {f}"),
    });
}

#[test]
fn names_reproduce_expected() {
    replay("books-names", 102, |i| {
        json!(filename::parse_path(i["path"].as_str().unwrap()))
    });
}

#[test]
fn deep_nesting_is_capped_and_fast() {
    let n = 100_000;
    let (open, close) = ("<x>".repeat(n), "</x>".repeat(n));
    let flat = format!(
        "<package><metadata><dc:title>Plat</dc:title>{open}{close}<dc:language>fr</dc:language></metadata></package>"
    );
    let inside = format!(
        "<package><metadata><dc:title>{}profond{}</dc:title></metadata></package>",
        "<b>".repeat(n),
        "</b>".repeat(n)
    );
    let unclosed =
        format!("<package><metadata><dc:title>Ouvert</dc:title>{open}</metadata></package>");
    let started = Instant::now();
    let m = opf::parse(flat.as_bytes());
    assert_eq!(
        (m.title.as_deref(), m.language.as_deref()),
        (Some("Plat"), Some("fr"))
    );
    assert_eq!(
        opf::parse(inside.as_bytes()).title.as_deref(),
        Some("profond")
    );
    assert_eq!(
        opf::parse(unclosed.as_bytes()).title.as_deref(),
        Some("Ouvert")
    );
    let stray = format!(
        "<package><metadata><dc:title>Sec</dc:title></metadata>{}</package>",
        "</x>".repeat(n)
    );
    assert_eq!(opf::parse(stray.as_bytes()).title.as_deref(), Some("Sec"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn many_repeated_values_are_deduplicated() {
    let n = 20_000;
    let subjects = (0..n)
        .map(|i| format!("<dc:subject>s{}</dc:subject>", i % 50))
        .collect::<String>();
    let creators = (0..n)
        .map(|i| format!("<dc:creator>Auteur {}</dc:creator>", i % 50))
        .collect::<String>();
    let isbns = "<dc:identifier>978-2-99999-001-2</dc:identifier>".repeat(n);
    let xml = format!("<package><metadata>{subjects}{creators}{isbns}</metadata></package>");
    let started = Instant::now();
    let m = opf::parse(xml.as_bytes());
    assert_eq!(
        (m.subjects.len(), m.creators.len(), m.isbns.len()),
        (50, 50, 1)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}
