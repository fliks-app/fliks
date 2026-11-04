use super::*;
use crate::content::split_sentences;
use std::io::Cursor;

const CONTAINER: &str = r#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

fn opf(spine_first: &str, extra: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>Sample</dc:title><meta name="cover" content="img1"/><meta name="calibre:timestamp" content="2020"/><dc:contributor opf:role="bkp">calibre</dc:contributor></metadata><manifest><item id="img1" href="cover.png" media-type="image/png"/><item id="c1" href="{spine_first}" media-type="application/xhtml+xml"/>{extra}</manifest><spine><itemref idref="c1"/></spine></package>"#
    )
}

fn epub(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default();
    for (n, b) in entries {
        w.start_file(*n, o).unwrap();
        w.write_all(b).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn book(chapter: &str, spine_first: &str) -> Vec<u8> {
    book_bytes(chapter.as_bytes(), spine_first)
}

fn book_bytes(chapter: &[u8], spine_first: &str) -> Vec<u8> {
    epub(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OEBPS/content.opf", opf(spine_first, "").as_bytes()),
        (&format!("OEBPS/{spine_first}"), chapter),
        ("OEBPS/cover.png", b"\x89PNG"),
        ("OEBPS/.DS_Store", b"x"),
        ("__MACOSX/junk", b"x"),
    ])
}

fn read(kepub: &[u8], name: &str) -> Option<String> {
    let mut z = ZipArchive::new(Cursor::new(kepub)).ok()?;
    let mut s = String::new();
    z.by_name(name).ok()?.read_to_string(&mut s).ok()?;
    Some(s)
}

fn names(kepub: &[u8]) -> Vec<String> {
    let mut z = ZipArchive::new(Cursor::new(kepub)).unwrap();
    (0..z.len())
        .map(|i| z.by_index_raw(i).unwrap().name().unwrap().into_owned())
        .collect()
}

fn convert_ok(b: &[u8]) -> Vec<u8> {
    convert_bytes(b, &Limits::default()).unwrap()
}

const CHAPTER: &str = r#"<?xml version="1.0" encoding="ISO-8859-1"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"/><title>t</title></head><body><h1>Title here.</h1><p>First one. Second one! "Third?" Fourth</p><p><img src="a.png" alt=""/></p><pre>keep  this</pre></body></html>"#;

#[test]
fn golden_content() {
    let out = convert_ok(&book(CHAPTER, "ch1.xhtml"));
    let c = read(&out, "OEBPS/ch1.xhtml").unwrap();
    assert!(
        c.starts_with(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC"#),
        "{c}"
    );
    assert!(c.contains(r#"content="text/html; charset=utf-8""#));
    assert!(c.contains(r#"<style type="text/css" class="kobostylehacks">div#book-inner { margin-top: 0; margin-bottom: 0;}</style></head>"#));
    assert!(c.contains(r#"<body><div id="book-columns"><div id="book-inner"><h1><span class="koboSpan" id="kobo.1.1">Title here.</span></h1>"#));
    assert!(c.contains(r#"<p><span class="koboSpan" id="kobo.2.1">First one. </span><span class="koboSpan" id="kobo.2.2">Second one! </span><span class="koboSpan" id="kobo.2.3">"Third?" </span><span class="koboSpan" id="kobo.2.4">Fourth</span></p>"#), "{c}");
    assert!(c.contains(
        r#"<p><span class="koboSpan" id="kobo.3.1"><img src="a.png" alt=""/></span></p>"#
    ));
    assert!(c.contains("<pre>keep  this</pre></div></div></body>"));
}

#[test]
fn archive_and_package() {
    let out = convert_ok(&book(CHAPTER, "ch1.xhtml"));
    let n = names(&out);
    assert_eq!(n[0], "mimetype");
    assert!(
        !n.iter()
            .any(|x| x.contains("DS_STORE") || x.contains("MACOSX"))
    );
    let o = read(&out, "OEBPS/content.opf").unwrap();
    assert!(
        o.contains(
            r#"<item id="img1" href="cover.png" media-type="image/png" properties="cover-image"/>"#
        ),
        "{o}"
    );
    assert!(!o.contains("calibre") && !o.contains("bkp"));
    let mut z = ZipArchive::new(Cursor::new(&out)).unwrap();
    let mut png = vec![];
    z.by_name("OEBPS/cover.png")
        .unwrap()
        .read_to_end(&mut png)
        .unwrap();
    assert_eq!(png, b"\x89PNG");
}

#[test]
fn converting_a_kepub_adds_nothing_twice() {
    let once = convert_ok(&book(CHAPTER, "ch1.xhtml"));
    let c = read(&convert_ok(&once), "OEBPS/ch1.xhtml").unwrap();
    assert_eq!(c.matches("id=\"book-inner\"").count(), 1);
    assert_eq!(c.matches("id=\"kobo.1.1\"").count(), 1);
}

#[test]
fn malformed_html_is_repaired() {
    let ch = "<HTML><BODY><P>One &nbsp;two &eacute; &bogus; &#x41;<BR>three<p>next <b>bold</BODY></HTML>";
    let c = read(&convert_ok(&book(ch, "ch1.xhtml")), "OEBPS/ch1.xhtml").unwrap();
    assert!(
        c.contains(r#"<html xmlns="http://www.w3.org/1999/xhtml"><head>"#),
        "{c}"
    );
    assert!(
        c.contains(r#"One &#160;two \u{e9} &amp;bogus; A"#.replace(r"\u{e9}", "\u{e9}").as_str()),
        "{c}"
    );
    assert!(c.contains("<br/>") && c.contains("<b>") && c.contains("</b></p>"));
    assert_eq!(c.matches("<p>").count(), 2);
}

#[test]
fn fragment_without_html_gets_a_skeleton() {
    let c = read(
        &convert_ok(&book("<p>Only a fragment.</p>", "ch1.xhtml")),
        "OEBPS/ch1.xhtml",
    )
    .unwrap();
    assert!(c.starts_with(r#"<html xmlns="http://www.w3.org/1999/xhtml"><head>"#));
    assert!(c.contains(r#"<body><div id="book-columns">"#));
}

#[test]
fn script_and_replacement_chars() {
    let ch = "<html><head><script>if (a<b && c) {}</script><meta name=\"Adept.resource\" content=\"x\"/></head><body><p>a\u{fffd}b</p><o:p> </o:p></body></html>";
    let c = read(&convert_ok(&book(ch, "ch1.xhtml")), "OEBPS/ch1.xhtml").unwrap();
    assert!(c.contains(r#"<script type="text/javascript">"#));
    assert!(c.contains("if (a<b && c) {}</script>"));
    assert!(!c.contains("Adept") && !c.contains("o:p") && c.contains(">ab<"));
}

#[test]
fn sentence_split_cases() {
    assert_eq!(split_sentences(""), [""]);
    assert_eq!(split_sentences("a. b"), ["a. ", "b"]);
    assert_eq!(
        split_sentences("Wait... \u{201C}No.\u{201D}  Yes"),
        ["Wait... ", "\u{201C}No.\u{201D}  ", "Yes"]
    );
    assert_eq!(split_sentences("3.14 is pi"), ["3.14 is pi"]);
    assert_eq!(split_sentences("end. "), ["end. "]);
    assert_eq!(split_sentences("a.\u{A0}b"), ["a.\u{A0}b"]);
}

#[test]
fn dummy_titlepage() {
    let short = convert_ok(&book("<html><body><p>Hi</p></body></html>", "ch1.xhtml"));
    let o = read(&short, "OEBPS/content.opf").unwrap();
    assert!(
        o.contains(r#"<itemref idref="kepubify-titlepage-dummy"/><itemref idref="c1"/>"#),
        "{o}"
    );
    assert!(read(&short, "OEBPS/kepubify-titlepage-dummy.xhtml").is_some());

    let cover = convert_ok(&book("<html><body><p>Hi</p></body></html>", "cover.xhtml"));
    assert!(read(&cover, "OEBPS/kepubify-titlepage-dummy.xhtml").is_none());

    let two_images = "<html><body><div><img src=\"a\"/><img src=\"b\"/></div></body></html>";
    assert!(
        read(
            &convert_ok(&book(two_images, "ch1.xhtml")),
            "OEBPS/kepubify-titlepage-dummy.xhtml"
        )
        .is_none()
    );
}

#[test]
fn hostile_zip_bomb() {
    let big = vec![0u8; 20 << 20];
    let b = epub(&[
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OEBPS/content.opf", opf("ch1.xhtml", "").as_bytes()),
        ("OEBPS/ch1.xhtml", b"<p>x</p>"),
        ("OEBPS/bomb.bin", &big),
    ]);
    let lim = Limits {
        max_entry_bytes: 1 << 20,
        ..Limits::default()
    };
    assert!(matches!(convert_bytes(&b, &lim), Err(Error::TooLarge)));
    let lim = Limits {
        max_total_bytes: 1 << 20,
        ..Limits::default()
    };
    assert!(matches!(convert_bytes(&b, &lim), Err(Error::TooLarge)));
    let lim = Limits {
        max_entries: 2,
        ..Limits::default()
    };
    assert!(matches!(
        convert_bytes(&b, &lim),
        Err(Error::TooManyEntries)
    ));
}

#[test]
fn hostile_names_are_dropped() {
    let b = epub(&[
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        (
            "OEBPS/content.opf",
            opf(
                "ch1.xhtml",
                r#"<item id="e" href="../../evil.xhtml" media-type="application/xhtml+xml"/>"#,
            )
            .as_bytes(),
        ),
        ("OEBPS/ch1.xhtml", b"<p>x</p>"),
        ("../evil.txt", b"x"),
        ("/abs.txt", b"x"),
        ("a/../../b.txt", b"x"),
        ("c:\\win.txt", b"x"),
    ]);
    let n = names(&convert_ok(&b));
    assert!(
        n.iter()
            .all(|x| !x.contains("..") && !x.starts_with('/') && !x.contains('\\')),
        "{n:?}"
    );
}

#[test]
fn hostile_markup() {
    let ent = "&".to_string() + &"a".repeat(100_000) + ";";
    let c = read(
        &convert_ok(&book(&format!("<p>{ent}</p>"), "ch1.xhtml")),
        "OEBPS/ch1.xhtml",
    )
    .unwrap();
    assert!(c.contains("&amp;aaaa"));

    let bomb = r#"<!DOCTYPE html [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><html><body><p>&b;</p></body></html>"#;
    let c = read(&convert_ok(&book(bomb, "ch1.xhtml")), "OEBPS/ch1.xhtml").unwrap();
    assert!(
        c.starts_with("<!DOCTYPE html>") && !c.contains("ENTITY") && c.contains("&amp;b;"),
        "{c}"
    );

    let deep = "<div>".repeat(10_000);
    assert!(matches!(
        convert_bytes(&book(&deep, "ch1.xhtml"), &Limits::default()),
        Err(Error::Malformed(_))
    ));

    let junk = "<p <<< =\"\" \"x=1 a'b>text</ </p><!-- unterminated";
    assert!(convert_bytes(&book(junk, "ch1.xhtml"), &Limits::default()).is_ok());
    assert!(
        convert_bytes(
            &book("<![CDATA[ no end <p", "ch1.xhtml"),
            &Limits::default()
        )
        .is_ok()
    );
}

#[test]
fn hostile_archives() {
    assert!(convert_bytes(b"not a zip", &Limits::default()).is_err());
    assert!(convert_bytes(&[], &Limits::default()).is_err());
    let no_container = epub(&[("a.txt", b"x")]);
    assert!(matches!(
        convert_bytes(&no_container, &Limits::default()),
        Err(Error::NoPackage)
    ));
    let escape = epub(&[(
        "META-INF/container.xml",
        CONTAINER
            .replace("OEBPS/content.opf", "../x.opf")
            .as_bytes(),
    )]);
    assert!(matches!(
        convert_bytes(&escape, &Limits::default()),
        Err(Error::NoPackage)
    ));
}

#[test]
fn utf16_chapter() {
    let mut b = vec![0xFF, 0xFE];
    for u in "<html><body><p>Caf\u{e9} ok.</p></body></html>".encode_utf16() {
        b.extend(u.to_le_bytes());
    }
    let e = epub(&[
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OEBPS/content.opf", opf("ch1.xhtml", "").as_bytes()),
        ("OEBPS/ch1.xhtml", &b),
    ]);
    assert!(
        read(&convert_ok(&e), "OEBPS/ch1.xhtml")
            .unwrap()
            .contains("Caf\u{e9} ok.")
    );
}

#[test]
fn random_markup_never_panics() {
    let alpha = [
        "<",
        "</",
        ">",
        "<!",
        "<!--",
        "-->",
        "<![CDATA[",
        "]]>",
        "<?",
        "?>",
        "[",
        "&",
        "&#",
        ";",
        "=",
        "\"",
        "'",
        "p",
        "script",
        "style",
        "\u{e9}",
        "\u{1F600}",
        " ",
        "/",
        "x",
        "<!DOCTYPE",
        "svg",
        "img",
    ];
    let mut seed = 0x2545F4914F6CDD1Du64;
    for _ in 0..3000 {
        let mut s = String::new();
        for _ in 0..40 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            s.push_str(alpha[(seed >> 33) as usize % alpha.len()]);
        }
        let _ = crate::content::transform(s.as_bytes());
        let _ = crate::dom::parse(&s, false);
    }
}

fn chapter_of(kepub_in: &[u8]) -> String {
    read(&convert_ok(kepub_in), "OEBPS/ch1.xhtml").unwrap()
}

#[test]
fn latin1_chapter_keeps_its_characters() {
    let latin1: Vec<u8> = CHAPTER
        .replace("Title here.", "Titl\u{e9} here.")
        .chars()
        .map(|c| c as u8)
        .collect();
    assert!(latin1.contains(&0xE9));
    let c = chapter_of(&book_bytes(&latin1, "ch1.xhtml"));
    assert!(c.contains("Titl\u{e9} here."), "{c}");
}

#[test]
fn undeclared_non_utf8_falls_back_to_windows_1252() {
    let c = chapter_of(&book_bytes(
        b"<html><body><p>\x80 5 \xE9t\xE9</p></body></html>",
        "ch1.xhtml",
    ));
    assert!(c.contains("\u{20ac} 5 \u{e9}t\u{e9}"), "{c}");
}

#[test]
fn full_xhtml_entity_table() {
    let c = chapter_of(&book(
        "<p>&minus;&alpha;&hearts;&lrm;&scaron;&circ;&apos;</p>",
        "ch1.xhtml",
    ));
    assert!(
        c.contains("\u{2212}\u{3b1}\u{2665}\u{200e}\u{161}\u{2c6}'"),
        "{c}"
    );
    assert_eq!(crate::entities::ENTITIES.len(), 253);
}

#[test]
fn bang_sections_parse_in_linear_time() {
    let src = "<!a>".repeat(400_000) + "[";
    let t = std::time::Instant::now();
    let _ = crate::dom::parse(&src, true);
    assert!(t.elapsed().as_secs() < 3);
}

#[test]
fn spans_count_against_the_node_budget() {
    let ch = format!("<div>{}</div>", "a. ".repeat(600_000));
    assert!(matches!(
        convert_bytes(&book(&ch, "ch1.xhtml"), &Limits::default()),
        Err(Error::Malformed(_))
    ));
}

#[test]
fn stray_content_around_html_joins_the_body() {
    let c = chapter_of(&book(
        "<p>junk</p><html><head></head><body><p>b</p></body></html><p>tail</p>",
        "ch1.xhtml",
    ));
    assert_eq!(c.matches("<html").count(), 1, "{c}");
    let inner = c.split("id=\"book-inner\">").nth(1).unwrap();
    assert!(inner.contains("junk") && inner.contains("tail"));
}

#[test]
fn doctype_is_uppercased() {
    let c = chapter_of(&book(
        "<!doctype html><html><body><p>x</p></body></html>",
        "ch1.xhtml",
    ));
    assert!(c.starts_with("<!DOCTYPE html>"), "{c}");
}

#[test]
fn package_path_case_mismatch_still_transforms() {
    let b = epub(&[
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("oebps/content.opf", opf("ch1.xhtml", "").as_bytes()),
        ("oebps/ch1.xhtml", b"<html><body><p>Hi</p></body></html>"),
    ]);
    let out = convert_ok(&b);
    let o = read(&out, "oebps/content.opf").unwrap();
    assert!(o.contains("kepubify-titlepage-dummy"), "{o}");
    assert!(read(&out, "oebps/kepubify-titlepage-dummy.xhtml").is_some());
    assert!(read(&out, "oebps/ch1.xhtml").unwrap().contains("koboSpan"));
}

/// Rewrites the compression method of one entry in its local and central headers.
fn set_method(z: &mut [u8], name: &str, method: u16) {
    for i in 0..z.len().saturating_sub(46) {
        let (sig, mo, lo, no) = match &z[i..i + 4] {
            b"PK\x03\x04" => (true, 8, 26, 30),
            b"PK\x01\x02" => (true, 10, 28, 46),
            _ => (false, 0, 0, 0),
        };
        if sig {
            let len = u16::from_le_bytes([z[i + lo], z[i + lo + 1]]) as usize;
            if &z[i + no..i + no + len] == name.as_bytes() {
                z[i + mo..i + mo + 2].copy_from_slice(&method.to_le_bytes());
            }
        }
    }
}

#[test]
fn unsupported_compression_on_junk_does_not_abort() {
    let mut z = book("<html><body><p>x</p></body></html>", "ch1.xhtml");
    set_method(&mut z, "__MACOSX/junk", 12);
    set_method(&mut z, "OEBPS/cover.png", 14);
    let out = convert_ok(&z);
    assert!(!names(&out).iter().any(|n| n.contains("MACOSX")));
    assert!(names(&out).contains(&"OEBPS/cover.png".to_string()));
}

#[test]
fn raw_xml_chars_and_case_insensitive_junk() {
    let c = chapter_of(&book(
        "<html><head><style>p{}\u{1}</style></head><body><p>x</p></body></html>",
        "ch1.xhtml",
    ));
    assert!(c.contains("p{}</style>"), "{c}");
    assert!(
        !names(&convert_ok(&book("<p>x</p>", "ch1.xhtml")))
            .iter()
            .any(|n| n.to_lowercase().contains(".ds_store"))
    );
}

#[test]
fn namespaced_svg_keeps_its_case() {
    let c = chapter_of(&book(
        r#"<body><svg:svg viewBox="0 0 1 1"><svg:linearGradient id="g"/></svg:svg><p>x</p></body>"#,
        "ch1.xhtml",
    ));
    assert!(c.contains(r#"<svg:svg viewBox="0 0 1 1"><svg:linearGradient id="g"></svg:linearGradient></svg:svg>"#), "{c}");
}

#[test]
fn malformed_qualified_names_are_not_markup() {
    let c = chapter_of(&book(
        r#"<body><p :d="1" a:b:c="2" ok="3">x</p><a:b:c>y</a:b:c></body>"#,
        "ch1.xhtml",
    ));
    assert!(
        c.contains(r#"<p ok="3">"#) && c.contains("&lt;a:b:c&gt;"),
        "{c}"
    );
}

#[test]
fn existing_dummy_page_is_left_alone() {
    let package = opf("ch1.xhtml", "");
    let e = [
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OEBPS/content.opf", package.as_bytes()),
        (
            "OEBPS/ch1.xhtml",
            b"<html><body><p>Hi</p></body></html>" as &[u8],
        ),
        (
            "OEBPS/kepubify-titlepage-dummy.xhtml",
            b"<html><body/></html>",
        ),
    ];
    let out = convert_ok(&epub(&e));
    assert_eq!(
        names(&out)
            .iter()
            .filter(|n| n.contains("titlepage-dummy"))
            .count(),
        1
    );
    assert!(
        !read(&out, "OEBPS/content.opf")
            .unwrap()
            .contains("itemref idref=\"kepubify")
    );
}

#[test]
fn an_encrypted_content_document_is_refused_but_an_obfuscated_font_is_not() {
    let enc = |uri: &str| {
        format!(
            r#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="{uri}"/></CipherData></EncryptedData></encryption>"#
        )
    };
    let with = |uri: &str| {
        epub(&[
            ("mimetype", b"application/epub+zip"),
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("META-INF/encryption.xml", enc(uri).as_bytes()),
            ("OEBPS/content.opf", opf("ch.xhtml", "").as_bytes()),
            ("OEBPS/ch.xhtml", b"x"),
            ("OEBPS/cover.png", b"\x89PNG"),
        ])
    };
    assert!(matches!(
        convert_bytes(&with("OEBPS/ch.xhtml"), &Limits::default()),
        Err(Error::Encrypted)
    ));
    assert!(convert_bytes(&with("OEBPS/font.otf"), &Limits::default()).is_ok());
}

#[test]
fn the_cover_fallback_skips_a_non_image_and_an_already_flagged_cover() {
    let pkg = |manifest: &str| {
        format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>{manifest}</manifest></package>"#
        )
    };
    let run = |manifest: &str| {
        let mut nodes = dom::parse(&pkg(manifest), false).unwrap();
        opf::cover_image(opf::root(&mut nodes).unwrap());
        dom::serialize(&nodes, false)
    };
    let page = run(r#"<item id="cover" href="c.xhtml" media-type="application/xhtml+xml"/>"#);
    assert!(!page.contains("cover-image"), "{page}");
    let two = run(
        r#"<item id="img" href="c.png" media-type="image/png" properties="cover-image"/><item id="cover" href="c2.png" media-type="image/png"/>"#,
    );
    assert_eq!(two.matches("cover-image").count(), 1, "{two}");
    let plain = run(r#"<item id="cover" href="c.png" media-type="image/png"/>"#);
    assert!(plain.contains("cover-image"), "{plain}");
}
