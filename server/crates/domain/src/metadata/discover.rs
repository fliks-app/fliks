//! `/discover` query parsing and the TMDB parameters it becomes (`metadata.md` rule 14).
use crate::media::query::js_parse_int;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Options {
    pub genre_ids: Vec<i64>,
    pub sort_by: Option<String>,
    pub vote_average_gte: Option<f64>,
    pub year_gte: Option<i64>,
    pub year_lte: Option<i64>,
}

/// `parseFloat`: the longest decimal prefix; `None` is NaN.
fn parse_float(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(i);
    i += int;
    let mut frac = 0;
    if b.get(i) == Some(&b'.') {
        frac = digits(i + 1);
        if int + frac > 0 {
            i += 1 + frac;
        }
    }
    if int + frac == 0 {
        return None;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        let exp = digits(i + 1 + sign);
        if exp > 0 {
            i += 1 + sign + exp;
        }
    }
    t[..i].parse().ok()
}

/// Empty or non-numeric values are dropped, like `x ? parse(x) : undefined` followed by the truthy check.
pub fn parse(
    genres: Option<&str>,
    sort: Option<&str>,
    vote_gte: Option<&str>,
    year_gte: Option<&str>,
    year_lte: Option<&str>,
) -> Options {
    let int = |v: Option<&str>| {
        v.filter(|s| !s.is_empty())
            .and_then(js_parse_int)
            .filter(|n| *n != 0)
    };
    Options {
        genre_ids: genres
            .unwrap_or_default()
            .split(',')
            .filter_map(js_parse_int)
            .collect(),
        sort_by: sort.filter(|s| !s.is_empty()).map(str::to_owned),
        vote_average_gte: vote_gte
            .filter(|s| !s.is_empty())
            .and_then(parse_float)
            .filter(|n| n.is_finite() && *n != 0.0),
        year_gte: int(year_gte),
        year_lte: int(year_lte),
    }
}

/// Query parameters of `/discover/movie` (`tv = false`) or `/discover/tv`.
pub fn params(o: &Options, locale: &str, tv: bool) -> Vec<(String, String)> {
    let sort = o.sort_by.as_deref().unwrap_or("popularity.desc");
    let sort = if tv {
        sort.replacen("primary_release_date", "first_air_date", 1)
    } else {
        sort.to_owned()
    };
    let mut p = vec![("language".to_owned(), locale.to_owned())];
    if !tv {
        p.push(("include_adult".into(), "false".into()));
    }
    p.push(("sort_by".into(), sort));
    p.push(("vote_count.gte".into(), "50".into()));
    if !o.genre_ids.is_empty() {
        let ids: Vec<String> = o.genre_ids.iter().map(i64::to_string).collect();
        p.push(("with_genres".into(), ids.join(",")));
    }
    if let Some(v) = o.vote_average_gte {
        p.push(("vote_average.gte".into(), v.to_string()));
    }
    let (gte, lte) = if tv {
        ("first_air_date.gte", "first_air_date.lte")
    } else {
        ("primary_release_date.gte", "primary_release_date.lte")
    };
    if let Some(y) = o.year_gte {
        p.push((gte.into(), format!("{y}-01-01")));
    }
    if let Some(y) = o.year_lte {
        p.push((lte.into(), format!("{y}-12-31")));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genres_keep_the_integers() {
        assert_eq!(
            parse(Some("28,abc,12"), None, None, None, None).genre_ids,
            [28, 12]
        );
        assert_eq!(parse(Some("28|12"), None, None, None, None).genre_ids, [28]);
        assert!(parse(Some(""), None, None, None, None).genre_ids.is_empty());
        assert!(parse(None, None, None, None, None).genre_ids.is_empty());
    }

    #[test]
    fn numbers_are_dropped_when_nan_or_zero() {
        let o = parse(None, Some(""), Some("NaN"), Some("0"), Some("abc"));
        assert_eq!(o, Options::default());
        let o = parse(
            None,
            Some("vote_average.desc"),
            Some("7.5x"),
            Some("1999"),
            Some("2001"),
        );
        assert_eq!(o.vote_average_gte, Some(7.5));
        assert_eq!((o.year_gte, o.year_lte), (Some(1999), Some(2001)));
        assert_eq!(o.sort_by.as_deref(), Some("vote_average.desc"));
    }

    #[test]
    fn float_prefixes() {
        for (s, want) in [
            ("7", Some(7.0)),
            (".5", Some(0.5)),
            ("1e2x", Some(100.0)),
            ("-", None),
            ("x", None),
            ("1.", Some(1.0)),
            ("1e", Some(1.0)),
        ] {
            assert_eq!(parse_float(s), want, "{s}");
        }
    }

    #[test]
    fn movie_and_tv_params() {
        let o = parse(
            Some("28,12"),
            Some("primary_release_date.desc"),
            Some("7"),
            Some("2000"),
            Some("2010"),
        );
        let m: Vec<_> = params(&o, "en-US", false)
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        assert_eq!(
            m,
            [
                "language=en-US",
                "include_adult=false",
                "sort_by=primary_release_date.desc",
                "vote_count.gte=50",
                "with_genres=28,12",
                "vote_average.gte=7",
                "primary_release_date.gte=2000-01-01",
                "primary_release_date.lte=2010-12-31",
            ]
        );
        let t: Vec<_> = params(&o, "fr-FR", true)
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        assert_eq!(t[1], "sort_by=first_air_date.desc");
        assert!(t.contains(&"first_air_date.gte=2000-01-01".to_owned()));
        assert!(!t.iter().any(|p| p.starts_with("include_adult")));
        let d = params(&Options::default(), "en-US", true);
        assert_eq!(d[1], ("sort_by".into(), "popularity.desc".into()));
    }
}
