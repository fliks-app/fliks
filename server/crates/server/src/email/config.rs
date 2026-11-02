//! The admin's SMTP settings (`app_settings`, `docs/spec/email-devices.md` rules 1-4).
use lettre::{
    AsyncSmtpTransport, Tokio1Executor,
    message::Mailbox,
    transport::smtp::{authentication::Credentials, extension::ClientId},
};
use sqlx::PgPool;
use std::time::Duration;

pub const KEYS: [&str; 7] = [
    "smtp_host",
    "smtp_port",
    "smtp_security",
    "smtp_username",
    "smtp_password",
    "smtp_from",
    "smtp_max_attachment_mb",
];
/// Amazon's own limit; also what bounds the memory of a mail (about 2.4 times the file).
const MAX_MB: u64 = 50;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    StartTls,
    Tls,
    None,
}

impl Security {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "starttls" => Self::StartTls,
            "tls" => Self::Tls,
            "none" => Self::None,
            _ => return None,
        })
    }

    fn default_port(self) -> u16 {
        match self {
            Self::StartTls => 587,
            Self::Tls => 465,
            Self::None => 25,
        }
    }
}

#[derive(Clone)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: Option<String>,
    pub password: Option<String>,
    pub from: Mailbox,
    pub max_bytes: u64,
}

/// `None` until the host and the sender are set, which is also what hides "Send to…" from users.
pub async fn load(db: &PgPool) -> sqlx::Result<Option<Smtp>> {
    let rows = sqlx::query!(
        r#"SELECT "key", "value" FROM app_settings WHERE "key" = ANY($1)"#,
        &KEYS.map(String::from)[..]
    )
    .fetch_all(db)
    .await?;
    let get = |k: &str| {
        rows.iter()
            .find(|r| r.key == k)
            .and_then(|r| r.value.as_deref())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let (Some(host), Some(from)) = (get("smtp_host"), get("smtp_from")) else {
        return Ok(None);
    };
    let Ok(from) = from.parse() else {
        return Ok(None);
    };
    let security = get("smtp_security")
        .and_then(Security::parse)
        .unwrap_or(Security::StartTls);
    let max_mb = get("smtp_max_attachment_mb")
        .and_then(|v| v.parse().ok())
        .filter(|n| (1..=MAX_MB).contains(n))
        .unwrap_or(MAX_MB);
    Ok(Some(Smtp {
        host: host.to_owned(),
        port: get("smtp_port")
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| security.default_port()),
        security,
        username: get("smtp_username").map(String::from),
        password: rows
            .iter()
            .find(|r| r.key == "smtp_password")
            .and_then(|r| r.value.clone())
            .filter(|v| !v.is_empty()),
        from,
        max_bytes: max_mb * 1024 * 1024,
    }))
}

impl std::fmt::Debug for Smtp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Smtp")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("from", &self.from)
            .finish_non_exhaustive()
    }
}

impl Smtp {
    /// Connect and I/O bound of one mail: a fixed part plus the time to push `bytes` at 256 KiB/s.
    pub fn budget(bytes: usize) -> Duration {
        Duration::from_secs(60 + (bytes / (256 * 1024)) as u64)
    }

    /// Certificates are always verified. Credentials never travel in clear text: `none` refuses them.
    pub fn transport(&self) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
        let creds = match (&self.username, &self.password) {
            (Some(u), p) => Some(Credentials::new(u.clone(), p.clone().unwrap_or_default())),
            _ => None,
        };
        if creds.is_some() && self.security == Security::None {
            return Err("smtp_security none cannot carry a username".into());
        }
        let builder = match self.security {
            Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host),
            Security::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.host),
            Security::None => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(
                &self.host,
            )),
        }
        .map_err(|e| e.to_string())?
        .port(self.port)
        .hello_name(ClientId::Domain(self.from.email.domain().to_owned()))
        .timeout(Some(TIMEOUT));
        Ok(match creds {
            Some(c) => builder.credentials(c),
            None => builder,
        }
        .build())
    }
}

/// The write-time check of an `smtp_*` key; a blank value unsets it and always passes.
pub fn validate(key: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    let bad = |what: &str| Err(format!("{key} {what}"));
    if value.is_empty() || !KEYS.contains(&key) {
        return Ok(());
    }
    if value.chars().any(char::is_control) {
        return bad("must not contain control characters");
    }
    match key {
        "smtp_port" if value.parse::<u16>().is_ok_and(|p| p > 0) => Ok(()),
        "smtp_port" => bad("must be a port number"),
        "smtp_security" if Security::parse(value).is_some() => Ok(()),
        "smtp_security" => bad("must be one of the following values: starttls, tls, none"),
        "smtp_from" if value.parse::<Mailbox>().is_ok() => Ok(()),
        "smtp_from" => bad("must be an e-mail address, optionally with a name"),
        "smtp_host" if value.len() <= 253 && value.bytes().all(|b| b.is_ascii_graphic()) => Ok(()),
        "smtp_host" => bad("must be a host name or an address"),
        "smtp_max_attachment_mb"
            if value
                .parse::<u64>()
                .is_ok_and(|n| (1..=MAX_MB).contains(&n)) =>
        {
            Ok(())
        }
        "smtp_max_attachment_mb" => bad(&format!("must be between 1 and {MAX_MB}")),
        _ if value.len() <= 255 => Ok(()),
        _ => bad("must be shorter than or equal to 255 characters"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_time_rules() {
        assert!(validate("smtp_port", "587").is_ok());
        for bad in ["0", "65536", "x", "-1"] {
            assert!(validate("smtp_port", bad).is_err(), "{bad}");
        }
        assert!(validate("smtp_security", "tls").is_ok());
        assert!(validate("smtp_security", "ssl").is_err());
        assert!(validate("smtp_from", "Fliks <books@example.com>").is_ok());
        assert!(validate("smtp_from", "not an address").is_err());
        assert!(validate("smtp_from", "a@example.com\r\nBcc: b@example.com").is_err());
        assert!(validate("smtp_host", "smtp.example.com").is_ok());
        assert!(validate("smtp_host", "smtp example.com").is_err());
        assert!(validate("smtp_max_attachment_mb", "0").is_err());
        assert!(validate("smtp_max_attachment_mb", "50").is_ok());
        assert!(validate("smtp_max_attachment_mb", "51").is_err());
        assert!(validate("smtp_port", "").is_ok(), "blank unsets");
        assert!(validate("other", "anything").is_ok());
    }

    #[test]
    fn clear_text_transport_refuses_credentials() {
        let c = Smtp {
            host: "h".into(),
            port: 25,
            security: Security::None,
            username: Some("u".into()),
            password: None,
            from: "a@example.com".parse().unwrap(),
            max_bytes: 1,
        };
        assert!(c.transport().is_err());
        let ok = Smtp {
            username: None,
            ..c
        };
        assert!(ok.transport().is_ok());
    }
}
