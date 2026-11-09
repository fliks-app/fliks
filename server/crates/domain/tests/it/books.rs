//! Golden book-file vectors (`fixtures/books-opf`, `books-names`; `BLESS=1` rewrites `expected`).
use crate::common::replay;
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

fn description(inner: &str) -> Option<String> {
    let xml =
        format!("<package><metadata><dc:description>{inner}</dc:description></metadata></package>");
    opf::parse(xml.as_bytes()).description
}

#[test]
fn description_is_plain_text_in_both_forms() {
    let want = Some("First & line\nSecond\nline".to_owned());
    let escaped = "&lt;div&gt;&lt;p&gt;First &amp;amp; line&lt;/p&gt;&lt;p&gt;Second&lt;br/&gt;line&lt;/p&gt;&lt;/div&gt;";
    let inline = "<div><p>First &amp; line</p><p>Second<br/>line</p></div>";
    assert_eq!(description(escaped), want);
    assert_eq!(description(inline), want);
}

#[test]
fn description_source_whitespace_is_not_a_line_break_in_markup() {
    let want = Some("one two\nthree".to_owned());
    assert_eq!(description("<p>one\n   two</p>\n<p>three</p>"), want);
    assert_eq!(
        description("&lt;p&gt;one\n   two&lt;/p&gt;\n&lt;p&gt;three&lt;/p&gt;"),
        want
    );
}

#[test]
fn description_plain_text_keeps_its_paragraphs() {
    assert_eq!(
        description("First  line\nsecond line\n\n\n\nNext paragraph"),
        Some("First line\nsecond line\n\nNext paragraph".to_owned())
    );
}

#[test]
fn description_drops_scripts_styles_and_comments() {
    let want = Some("kept\nalso".to_owned());
    assert_eq!(
        description(
            "<p>kept</p><style>p { a: b }</style><script>x()</script><!-- a > b --><p>also</p>"
        ),
        want
    );
    assert_eq!(
        description(
            "&lt;p&gt;kept&lt;/p&gt;&lt;style&gt;p { a: b }&lt;/style&gt;&lt;script&gt;x()&lt;/script&gt;&lt;!-- a &gt; b --&gt;&lt;p&gt;also&lt;/p&gt;"
        ),
        want
    );
}

#[test]
fn description_decodes_named_entities_and_all_block_tags() {
    assert_eq!(
        description(
            "&lt;h5&gt;Caf&eacute;&lt;/h5&gt;&lt;dd&gt;&laquo;&nbsp;l&rsquo;&eacute;t&eacute;&nbsp;&raquo;&lt;/dd&gt;&lt;td&gt;a&hellip;&lt;/td&gt;"
        ),
        Some("Caf\u{e9}\n\u{ab} l\u{2019}\u{e9}t\u{e9} \u{bb}\na\u{2026}".to_owned())
    );
}
