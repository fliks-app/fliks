//! The mail of one book: every user-controlled string is stripped of control characters before it
//! reaches a header (`docs/spec/email-devices.md` rule 14).
use lettre::{
    Address, Message,
    address::Envelope,
    message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType},
};

/// Control characters become spaces, runs of whitespace collapse, and the result is cut to `max` characters.
pub fn clean(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

const NAME_MAX: usize = 150;

/// The name a reader shows: no path, quote or backslash, and never empty.
pub fn attachment_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let name = clean(&base.replace('"', "_"), usize::MAX);
    if name.is_empty() {
        return "book".into();
    }
    if name.chars().count() <= NAME_MAX {
        return name;
    }
    // The extension tells the reader what the file is, so only the stem is cut.
    let (stem, ext) = match name.rfind('.') {
        Some(i) if name.len() - i <= 10 => name.split_at(i),
        _ => (name.as_str(), ""),
    };
    let keep = NAME_MAX - ext.chars().count();
    format!("{}{ext}", stem.chars().take(keep).collect::<String>())
}

pub fn parse_address(s: &str) -> Option<Address> {
    let s = s.trim();
    (s.len() <= 254 && !s.chars().any(|c| c.is_control() || c.is_whitespace()))
        .then(|| s.parse().ok())?
}

/// The envelope and the wire bytes, so the message and the file behind it are freed before the send.
pub fn book_raw(
    from: &Mailbox,
    to: Address,
    file_name: &str,
    mime: &str,
    data: Vec<u8>,
) -> Result<(Envelope, Vec<u8>), String> {
    let m = book(from, to, file_name, mime, data)?;
    Ok((m.envelope().clone(), m.formatted()))
}

fn book(
    from: &Mailbox,
    to: Address,
    file_name: &str,
    mime: &str,
    data: Vec<u8>,
) -> Result<Message, String> {
    let name = attachment_name(file_name);
    let content_type = ContentType::parse(mime).map_err(|e| e.to_string())?;
    Message::builder()
        .from(from.clone())
        .to(Mailbox::new(None, to))
        .subject(name.clone())
        .multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::plain("Sent from Fliks.".to_owned()))
                .singlepart(Attachment::new(name).body(data, content_type)),
        )
        .map_err(|e| e.to_string())
}

pub fn test(from: &Mailbox, to: Address) -> Result<Message, String> {
    Message::builder()
        .from(from.clone())
        .to(Mailbox::new(None, to))
        .subject("Fliks test message")
        .body("The SMTP settings of your Fliks server work.".to_owned())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_cannot_open_a_header() {
        assert_eq!(clean("a\r\nBcc: x@y.z\t b", 100), "a Bcc: x@y.z b");
        assert_eq!(
            attachment_name("../x/\"a\r\nBcc: z\".epub"),
            "_a Bcc: z_.epub"
        );
        assert_eq!(attachment_name("dir/book.epub"), "book.epub");
        assert_eq!(attachment_name("\r\n"), "book");
        let long = format!("{}.epub", "x".repeat(300));
        let cut = attachment_name(&long);
        assert!(
            cut.ends_with("x.epub") && cut.chars().count() == NAME_MAX,
            "{cut}"
        );
        assert_eq!(attachment_name(&"y".repeat(300)).chars().count(), NAME_MAX);
        assert!(parse_address("a@b.example\r\nBcc: c@d.example").is_none());
        assert!(parse_address("Name <a@b.example>").is_none());
        assert!(parse_address("a@b.example").is_some());
    }

    #[test]
    fn the_mail_has_one_recipient_and_the_attachment() {
        let from: Mailbox = "Fliks <f@example.com>".parse().unwrap();
        let to = parse_address("me@kindle.example").unwrap();
        let (_, raw) = book_raw(
            &from,
            to,
            "x/y\r\nBcc: z@example.com.epub",
            "application/epub+zip",
            b"PK".to_vec(),
        )
        .unwrap();
        let raw = String::from_utf8(raw).unwrap();
        let (head, _) = raw.split_once("\r\n\r\n").unwrap();
        assert!(!head.to_lowercase().contains("\r\nbcc:"), "{head}");
        assert_eq!(head.matches("To: ").count(), 1);
        assert!(raw.contains("application/epub+zip"));
    }
}
