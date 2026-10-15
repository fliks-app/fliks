/// `DateTime<Utc>` as JS `toISOString()` (`2026-01-02T03:04:05.678Z`): `#[serde(with = "iso_ms")]`.
pub mod iso_ms {
    use chrono::{DateTime, SecondsFormat, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&dt.to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        DateTime::deserialize(d)
    }

    /// For `Option<DateTime<Utc>>`: `#[serde(with = "iso_ms::opt")]`.
    pub mod opt {
        use super::*;

        pub fn serialize<S: Serializer>(
            dt: &Option<DateTime<Utc>>,
            s: S,
        ) -> Result<S::Ok, S::Error> {
            match dt {
                Some(dt) => super::serialize(dt, s),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            d: D,
        ) -> Result<Option<DateTime<Utc>>, D::Error> {
            Option::deserialize(d)
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone, Utc};
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct T {
        #[serde(with = "super::iso_ms")]
        at: DateTime<Utc>,
        #[serde(with = "super::iso_ms::opt")]
        maybe: Option<DateTime<Utc>>,
    }

    #[test]
    fn round_trip_millis_z() {
        let at =
            Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap() + chrono::Duration::milliseconds(60);
        let t = T { at, maybe: None };
        let s = serde_json::to_string(&t).unwrap();
        assert_eq!(s, r#"{"at":"2026-01-02T03:04:05.060Z","maybe":null}"#);
        assert_eq!(serde_json::from_str::<T>(&s).unwrap(), t);
        let t = T {
            at,
            maybe: Some(at),
        };
        let s = serde_json::to_string(&t).unwrap();
        assert!(s.contains(r#""maybe":"2026-01-02T03:04:05.060Z""#));
        assert_eq!(serde_json::from_str::<T>(&s).unwrap(), t);
    }
}
