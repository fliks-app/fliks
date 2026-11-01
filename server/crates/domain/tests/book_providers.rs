//! Golden vectors of the book providers (`fixtures/books-providers/<provider>`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::book_providers::audible::{self, Region};
use fliks_domain::book_providers::{ParseError, audnexus, bnf, googlebooks, openlibrary};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::PathBuf;

/// The inline `body`, or the fixture `file` of the provider's directory.
fn body(set: &str, i: &Value) -> String {
    if let Some(b) = i["body"].as_str() {
        return b.into();
    }
    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("run through cargo test");
    let path = PathBuf::from(dir).join(format!(
        "../../fixtures/books-providers/{set}/{}",
        i["file"].as_str().unwrap()
    ));
    std::fs::read_to_string(path).unwrap()
}

fn res<T: Serialize>(r: Result<T, ParseError>) -> Value {
    match r {
        Ok(v) => json!(v),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

struct Args<'a>(&'a Value);

impl<'a> Args<'a> {
    fn s(&self, k: &str) -> Option<&'a str> {
        self.0["args"][k].as_str()
    }
    fn n(&self, k: &str) -> Option<u32> {
        self.0["args"][k].as_u64().map(|n| n as u32)
    }
    fn region(&self) -> Region {
        Region::from_code(self.s("region").unwrap()).unwrap()
    }
}

#[test]
fn openlibrary_reproduces_expected() {
    use openlibrary::*;
    replay("books-providers/openlibrary", 34, |i| {
        let a = Args(i);
        let b = || body("openlibrary", i);
        match i["fn"].as_str().unwrap() {
            "parse_search" => res(parse_search(&b())),
            "parse_work" => res(parse_work(&b())),
            "parse_edition" => res(parse_edition(&b())),
            "parse_editions" => res(parse_editions(&b())),
            "parse_isbn_batch" => res(parse_isbn_batch(&b())),
            "parse_author" => res(parse_author(&b())),
            "search_url" => json!(search_url(&Search {
                title: a.s("title"),
                author: a.s("author"),
                isbn: a.s("isbn"),
                q: a.s("q"),
                lang: a.s("lang"),
                limit: a.n("limit"),
                page: a.n("page"),
            })),
            "isbn_url" => json!(isbn_url(a.s("isbn").unwrap())),
            "isbn_batch_url" => {
                let v = i["args"]["isbns"].as_array().unwrap();
                let v: Vec<&str> = v.iter().filter_map(Value::as_str).collect();
                json!(isbn_batch_url(&v))
            }
            "work_url" => json!(work_url(a.s("id").unwrap())),
            "work_editions_url" => json!(work_editions_url(
                a.s("id").unwrap(),
                a.n("limit").unwrap(),
                a.n("offset").unwrap()
            )),
            "edition_url" => json!(edition_url(a.s("id").unwrap())),
            "author_url" => json!(author_url(a.s("id").unwrap())),
            f => panic!("unknown fn {f}"),
        }
    });
}

#[test]
fn googlebooks_reproduces_expected() {
    use googlebooks::*;
    replay("books-providers/googlebooks", 18, |i| {
        let a = Args(i);
        let b = || body("googlebooks", i);
        match i["fn"].as_str().unwrap() {
            "parse_volumes" => res(parse_volumes(&b())),
            "parse_volume" => res(parse_volume(&b())),
            "search_url" => json!(search_url(&Search {
                title: a.s("title"),
                author: a.s("author"),
                isbn: a.s("isbn"),
                text: a.s("text"),
                lang: a.s("lang"),
                max_results: a.n("max_results"),
                start_index: a.n("start_index"),
            })),
            "volume_url" => json!(volume_url(a.s("id").unwrap())),
            f => panic!("unknown fn {f}"),
        }
    });
}

#[test]
fn bnf_reproduces_expected() {
    use bnf::*;
    replay("books-providers/bnf", 18, |i| {
        let a = Args(i);
        let b = || body("bnf", i);
        match i["fn"].as_str().unwrap() {
            "parse_search" => res(parse_search(&b())),
            "parse_record" => res(parse_record(&b())),
            "isbn_url" => json!(isbn_url(a.s("isbn").unwrap())),
            "title_author_url" => json!(title_author_url(
                a.s("title").unwrap(),
                a.s("author"),
                a.n("start").unwrap(),
                a.n("max").unwrap()
            )),
            "record_url" => json!(record_url(a.s("ark").unwrap())),
            f => panic!("unknown fn {f}"),
        }
    });
}

#[test]
fn audible_reproduces_expected() {
    use audible::*;
    replay("books-providers/audible", 18, |i| {
        let a = Args(i);
        let b = || body("audible", i);
        match i["fn"].as_str().unwrap() {
            "parse_search" => res(parse_search(&b())),
            "parse_product" => res(parse_product(&b())),
            "search_url" => json!(search_url(
                a.region(),
                &Search {
                    title: a.s("title"),
                    author: a.s("author"),
                    narrator: a.s("narrator"),
                    keywords: a.s("keywords"),
                    num_results: a.n("num_results"),
                    page: a.n("page"),
                }
            )),
            "product_url" => json!(product_url(a.region(), a.s("asin").unwrap())),
            "region_codes" => json!(Region::ALL.map(|r| json!([r.code(), r.tld()]))),
            f => panic!("unknown fn {f}"),
        }
    });
}

#[test]
fn audnexus_reproduces_expected() {
    use audnexus::*;
    replay("books-providers/audnexus", 17, |i| {
        let a = Args(i);
        let b = || body("audnexus", i);
        let region = || a.s("region").map(|_| a.region());
        match i["fn"].as_str().unwrap() {
            "parse_book" => res(parse_book(&b())),
            "parse_chapters" => res(parse_chapters(&b())),
            "parse_author" => res(parse_author(&b())),
            "book_url" => json!(book_url(a.s("asin").unwrap(), region())),
            "chapters_url" => json!(chapters_url(a.s("asin").unwrap(), region())),
            "author_url" => json!(author_url(a.s("asin").unwrap(), region())),
            f => panic!("unknown fn {f}"),
        }
    });
}
