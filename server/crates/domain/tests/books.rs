//! Golden book-file vectors (`fixtures/books-opf`, `books-names`, `books-koreader`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::books::{filename, isbn, koreader, opf};
use serde_json::{Value, json};

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
    replay("books-opf", 55, |i| match i["fn"].as_str().unwrap() {
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
    replay("books-names", 90, |i| {
        json!(filename::parse_path(i["path"].as_str().unwrap()))
    });
}

/// The bytes of the generated files: a pattern for the first 2 MiB, zeros beyond.
fn synthetic(size: u64, offset: u64, len: usize) -> Vec<u8> {
    let end = size.min(offset + len as u64);
    (offset..end)
        .map(|i| {
            if i < 1 << 21 {
                (i * 131 + (i >> 7)) as u8
            } else {
                0
            }
        })
        .collect()
}

#[test]
fn koreader_hash_reproduces_koreader_lua() {
    replay("books-koreader", 25, |i| {
        let size = i["size"].as_u64().unwrap();
        let hash = koreader::partial_md5(|off, len| Ok::<_, ()>(synthetic(size, off, len)));
        json!(hash.unwrap())
    });
}
