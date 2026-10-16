//! Language and region to per-provider dialects (`metadata.md` rule 23).

struct Lang {
    iso1: &'static str,
    tvdb: &'static str,
    region: &'static str,
}

const LANGUAGES: [Lang; 12] = [
    Lang {
        iso1: "en",
        tvdb: "eng",
        region: "US",
    },
    Lang {
        iso1: "fr",
        tvdb: "fra",
        region: "FR",
    },
    Lang {
        iso1: "es",
        tvdb: "spa",
        region: "ES",
    },
    Lang {
        iso1: "de",
        tvdb: "deu",
        region: "DE",
    },
    Lang {
        iso1: "it",
        tvdb: "ita",
        region: "IT",
    },
    Lang {
        iso1: "pt",
        tvdb: "por",
        region: "PT",
    },
    Lang {
        iso1: "nl",
        tvdb: "nld",
        region: "NL",
    },
    Lang {
        iso1: "pl",
        tvdb: "pol",
        region: "PL",
    },
    Lang {
        iso1: "ru",
        tvdb: "rus",
        region: "RU",
    },
    Lang {
        iso1: "ja",
        tvdb: "jpn",
        region: "JP",
    },
    Lang {
        iso1: "ko",
        tvdb: "kor",
        region: "KR",
    },
    Lang {
        iso1: "zh",
        tvdb: "zho",
        region: "CN",
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub iso1: &'static str,
    pub tmdb_locale: String,
    pub include_image_language: String,
    pub logo_iso1: &'static str,
    pub tvdb_code: &'static str,
    pub region: String,
    pub release_date_priority: Vec<String>,
}

/// Unknown or empty language is English; an empty region is the language's default.
pub fn resolve(language: Option<&str>, region: Option<&str>) -> Resolved {
    let norm = language
        .unwrap_or_default()
        .to_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_owned();
    let opt = LANGUAGES
        .iter()
        .find(|l| l.iso1 == norm)
        .unwrap_or(&LANGUAGES[0]);
    let region = match region.unwrap_or_default().to_uppercase() {
        r if r.is_empty() => opt.region.to_owned(),
        r => r,
    };
    let release_date_priority = if region == "US" {
        vec!["US".into()]
    } else {
        vec![region.clone(), "US".into()]
    };
    Resolved {
        iso1: opt.iso1,
        tmdb_locale: format!("{}-{region}", opt.iso1),
        include_image_language: if opt.iso1 == "en" {
            "en,null".into()
        } else {
            format!("{},en,null", opt.iso1)
        },
        logo_iso1: opt.iso1,
        tvdb_code: opt.tvdb,
        region,
        release_date_priority,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_language_table() {
        for l in &LANGUAGES {
            let r = resolve(Some(l.iso1), None);
            assert_eq!(r.tmdb_locale, format!("{}-{}", l.iso1, l.region));
            assert_eq!(r.tvdb_code, l.tvdb);
        }
    }

    #[test]
    fn normalises_and_falls_back() {
        assert_eq!(resolve(Some("fr-CA"), None).iso1, "fr");
        assert_eq!(resolve(Some("EN_us"), Some("")).tmdb_locale, "en-US");
        assert_eq!(resolve(Some("xx"), Some("fr")).tmdb_locale, "en-FR");
        assert_eq!(resolve(None, None).tmdb_locale, "en-US");
        assert_eq!(resolve(Some(""), Some("gb")).region, "GB");
    }

    #[test]
    fn image_languages_and_release_priority() {
        let en = resolve(Some("en"), Some("US"));
        assert_eq!(en.include_image_language, "en,null");
        assert_eq!(en.release_date_priority, ["US"]);
        let fr = resolve(Some("fr"), None);
        assert_eq!(fr.include_image_language, "fr,en,null");
        assert_eq!(fr.release_date_priority, ["FR", "US"]);
        assert_eq!(fr.logo_iso1, "fr");
    }
}
