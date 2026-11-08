//! Ids of the API: a prefix names the table (`docs/spec/opensubsonic.md` rule 14).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Id {
    Artist(i32),
    Album(i32),
    Track(i32),
    Playlist(i32),
}

impl Id {
    pub fn parse(s: &str) -> Option<Self> {
        let (prefix, n) = s.split_once('-')?;
        if n.is_empty() || n.len() > 10 || !n.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: i32 = n.parse().ok().filter(|n| *n > 0)?;
        Some(match prefix {
            "ar" => Self::Artist(n),
            "al" => Self::Album(n),
            "tr" => Self::Track(n),
            "pl" => Self::Playlist(n),
            _ => return None,
        })
    }
}

pub fn artist(id: i32) -> String {
    format!("ar-{id}")
}

pub fn album(id: i32) -> String {
    format!("al-{id}")
}

pub fn track(id: i32) -> String {
    format!("tr-{id}")
}

pub fn playlist(id: i32) -> String {
    format!("pl-{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_round_trips_and_a_bad_one_names_nothing() {
        assert_eq!(Id::parse(&artist(4)), Some(Id::Artist(4)));
        assert_eq!(Id::parse(&album(5)), Some(Id::Album(5)));
        assert_eq!(Id::parse(&track(6)), Some(Id::Track(6)));
        assert_eq!(Id::parse(&playlist(7)), Some(Id::Playlist(7)));
        for bad in [
            "",
            "7",
            "al-",
            "al-0",
            "al--1",
            "al-1x",
            "xx-1",
            "al-99999999999",
            "al-+1",
        ] {
            assert_eq!(Id::parse(bad), None, "{bad}");
        }
    }
}
