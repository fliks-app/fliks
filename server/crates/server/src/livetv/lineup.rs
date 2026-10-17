//! Fetching a lineup, whichever protocol the source speaks (`livetv-sources.md` rules 15-21, 35).
use super::{
    net::{self, Identity, Opts, Validators},
    playlist_file,
};
use chrono::{DateTime, Utc};
use fliks_domain::livetv::{
    m3u::parse_m3u,
    sync::Entry,
    xtream::{self, Credentials},
};
use reqwest::Url;
use std::collections::HashSet;

/// What a request needs from a source row (or from a test body).
#[derive(Debug, Clone)]
pub struct Conn {
    pub kind: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
}

impl Conn {
    pub fn identity(&self) -> Identity<'_> {
        Identity {
            user_agent: self.user_agent.as_deref(),
            referer: self.referer.as_deref(),
        }
    }

    pub fn credentials(&self) -> Credentials {
        Credentials {
            base_url: self.url.clone(),
            username: self.username.clone().unwrap_or_default(),
            password: self.password.clone().unwrap_or_default(),
        }
    }
}

#[derive(Debug)]
pub struct Lineup {
    pub entries: Vec<Entry>,
    /// Xtream: the bare guide url, its credentials are derived on demand (F71).
    pub guide_urls: Vec<String>,
    pub max_connections: Option<i32>,
    pub expires_at: Option<DateTime<Utc>>,
    pub account_status: Option<String>,
    pub playlist_etag: Option<String>,
    pub playlist_last_modified: Option<String>,
}

pub enum Fetched {
    NotModified,
    Lineup(Box<Lineup>),
}

/// `<base>/player_api.php?username&password[&action]`, form-encoded; the base is concatenated verbatim.
fn panel_url(c: &Credentials, action: Option<&str>) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("username", &c.username)
        .append_pair("password", &c.password);
    if let Some(a) = action {
        q.append_pair("action", a);
    }
    format!("{}/player_api.php?{}", c.base_url, q.finish())
}

async fn panel(
    c: &Conn,
    creds: &Credentials,
    action: Option<&str>,
    vetted: bool,
) -> Result<serde_json::Value, String> {
    let opts = Opts::PANEL.vetted(vetted);
    let reply = net::get(
        &panel_url(creds, action),
        &c.identity(),
        &Validators::default(),
        opts,
    )
    .await?;
    net::json(reply, opts.idle).await
}

fn into_entries(streams: Vec<xtream::LiveStream>, creds: &Credentials, format: &str) -> Vec<Entry> {
    let mut seen = HashSet::new();
    streams
        .into_iter()
        .filter(|s| seen.insert(s.stream_id.clone()))
        .map(|s| Entry {
            url: s
                .direct_source
                .clone()
                .unwrap_or_else(|| xtream::stream_url(creds, &s.stream_id, format)),
            external_id: s.stream_id,
            name: s.name.replace('\0', ""),
            logo: s.logo,
            group_name: s.category_name,
            tvg_id: s.guide_channel_id,
            number: s.number,
            quality_label: None,
            shift_minutes: 0,
            user_agent: None,
            referer: None,
        })
        .collect()
}

pub async fn fetch(c: &Conn, validators: &Validators<'_>, vetted: bool) -> Result<Fetched, String> {
    if c.kind == "xtream" {
        let creds = c.credentials();
        let (account, categories, streams) = tokio::join!(
            panel(c, &creds, None, vetted),
            panel(c, &creds, Some("get_live_categories"), vetted),
            panel(c, &creds, Some("get_live_streams"), vetted),
        );
        let account = xtream::account(&account?)?;
        let streams = xtream::live_streams(&categories?, &streams?)?;
        let format = xtream::pick_output_format(&account.allowed_output_formats);
        return Ok(Fetched::Lineup(Box::new(Lineup {
            entries: into_entries(streams, &creds, &format),
            guide_urls: vec![xtream::guide_url_bare(&creds)],
            max_connections: i32::try_from(account.max_connections)
                .ok()
                .filter(|n| *n != 0),
            expires_at: account.expires_at,
            account_status: account.status,
            playlist_etag: None,
            playlist_last_modified: None,
        })));
    }
    let Some(playlist) = m3u(&c.url, &c.identity(), validators, vetted).await? else {
        return Ok(Fetched::NotModified);
    };
    Ok(Fetched::Lineup(Box::new(Lineup {
        entries: playlist.0.entries.into_iter().map(Entry::from).collect(),
        guide_urls: playlist.0.guide_urls,
        max_connections: playlist.0.max_connections,
        expires_at: playlist.0.expires_at,
        account_status: None,
        playlist_etag: playlist.1,
        playlist_last_modified: playlist.2,
    })))
}

/// A playlist from a URL or an uploaded file, with the validators to store; `None` when not modified.
/// A file has no ETag: its mtime plays that role.
pub async fn m3u(
    url: &str,
    identity: &Identity<'_>,
    validators: &Validators<'_>,
    vetted: bool,
) -> Result<
    Option<(
        fliks_domain::livetv::m3u::M3uPlaylist,
        Option<String>,
        Option<String>,
    )>,
    String,
> {
    if !playlist_file::is_http_source(url) {
        let local = playlist_file::read_local(url).await?;
        if validators.last_modified == Some(local.version.as_str()) {
            return Ok(None);
        }
        return Ok(Some((parse_m3u(&local.body), None, Some(local.version))));
    }
    let opts = Opts::PLAYLIST.vetted(vetted);
    let reply = net::get(url, identity, validators, opts).await?;
    if reply.not_modified() {
        return Ok(None);
    }
    let (etag, last_modified) = reply.validators();
    let body = net::text(reply, opts.idle).await?;
    Ok(Some((parse_m3u(&body), etag, last_modified)))
}

/// The guide url of a source: the panel's for Xtream, the stored `x-tvg-url` for M3U, else the playlist's own.
pub async fn guide_url(source: &super::model::Source) -> Result<String, String> {
    if source.kind == "xtream" {
        let creds = Credentials {
            base_url: source.url.clone(),
            username: source.username.clone().unwrap_or_default(),
            password: source.password.clone().unwrap_or_default(),
        };
        return Ok(xtream::guide_url(&creds));
    }
    if let Some(first) = source.guide_urls.0.first() {
        return Ok(first.clone());
    }
    let identity = Identity {
        user_agent: source.user_agent.as_deref(),
        referer: source.referer.as_deref(),
    };
    let found = m3u(&source.url, &identity, &Validators::default(), false).await?;
    found
        .and_then(|(p, ..)| p.guide_urls.into_iter().next())
        .ok_or_else(|| {
            format!(
                "Source \"{}\" playlist has no x-tvg-url header",
                source.name
            )
        })
}

/// `true` for a URL the DTO accepts as a location: http or https with a host.
pub fn is_fetchable_url(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty())
    }) && !raw.chars().any(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_calls_use_form_encoding_and_the_base_verbatim() {
        let c = Credentials {
            base_url: "http://h:8080/".into(),
            username: "u v".into(),
            password: "p&q~".into(),
        };
        assert_eq!(
            panel_url(&c, Some("get_live_streams")),
            "http://h:8080//player_api.php?username=u+v&password=p%26q%7E&action=get_live_streams"
        );
        assert!(!panel_url(&c, None).contains("action"));
    }

    #[test]
    fn a_duplicated_stream_id_keeps_the_first() {
        let creds = Credentials {
            base_url: "http://h".into(),
            username: "u".into(),
            password: "p".into(),
        };
        let s = |id: &str, name: &str, direct: Option<&str>| xtream::LiveStream {
            stream_id: id.into(),
            name: name.into(),
            number: None,
            logo: None,
            guide_channel_id: None,
            category_name: "G".into(),
            direct_source: direct.map(Into::into),
        };
        let e = into_entries(
            vec![
                s("1", "A", None),
                s("1", "B", None),
                s("2", "C", Some("http://cdn/c.m3u8")),
            ],
            &creds,
            "ts",
        );
        assert_eq!(
            e.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["A", "C"]
        );
        assert_eq!(e[0].url, "http://h/live/u/p/1.ts");
        assert_eq!(e[1].url, "http://cdn/c.m3u8");
    }

    #[test]
    fn locations_are_http_urls() {
        for ok in [
            "http://h/x.m3u",
            "https://localhost:8080/a",
            "http://192.168.1.2/p",
        ] {
            assert!(is_fetchable_url(ok), "{ok}");
        }
        for bad in [
            "ftp://h/x",
            "h/x",
            "/etc/passwd",
            "http://",
            "http://h /x",
            "file:///x",
        ] {
            assert!(!is_fetchable_url(bad), "{bad}");
        }
    }
}
