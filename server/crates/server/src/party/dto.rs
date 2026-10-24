//! Request bodies and response shapes (`docs/spec/watch-party.md`, DTOs): every key present.
use crate::http::{AppError, json::iso_ms};
use chrono::{DateTime, Utc};
use fliks_domain::party::{
    Action, Anchor, Item, MemberStatus, Message, Policy, Role, State, Voice,
};
use serde::{Deserialize, Deserializer, Serialize};

const MAX_INVITEES: usize = 50;
const MAX_TEXT: usize = 500;
const MAX_SIGNAL_BYTES: usize = 16 * 1024;

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

fn invalid(what: &str) -> AppError {
    AppError::bad_request(format!("party.error_invalid_{what}"))
}

pub fn valid_name(name: &str) -> Result<String, AppError> {
    let n = name.trim();
    let len = n.chars().count();
    if (1..=80).contains(&len) {
        Ok(n.to_owned())
    } else {
        Err(invalid("name"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Create {
    pub name: String,
    pub media_id: i32,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub policy: Option<Policy>,
    pub invitee_ids: Option<Vec<i32>>,
}

impl Create {
    pub fn validate(&self) -> Result<(), AppError> {
        valid_name(&self.name)?;
        if self
            .invitee_ids
            .as_ref()
            .is_some_and(|v| v.len() > MAX_INVITEES)
        {
            return Err(invalid("invitees"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Patch {
    pub name: Option<String>,
    pub policy: Option<Policy>,
    #[serde(default, deserialize_with = "nullable")]
    pub scheduled_at: Option<Option<DateTime<Utc>>>,
    pub regenerate_token: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Join {
    pub device_id: String,
    pub token: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ItemIn {
    pub media_id: i32,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
}

impl From<ItemIn> for Item {
    fn from(i: ItemIn) -> Self {
        Self {
            media_id: i.media_id,
            media_file_id: i.media_file_id,
            episode_id: i.episode_id,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntentIn {
    pub device_id: String,
    pub action: Action,
    pub position: Option<f64>,
    pub item: Option<ItemIn>,
    pub base_rev: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StatusIn {
    pub device_id: String,
    pub status: MemberStatus,
    pub position: f64,
    pub rtt_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MessageIn {
    pub device_id: String,
    pub text: String,
}

impl MessageIn {
    pub fn text(&self) -> Result<&str, AppError> {
        let t = self.text.trim();
        if t.is_empty() || t.chars().count() > MAX_TEXT {
            return Err(invalid("text"));
        }
        Ok(t)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoiceIn {
    pub device_id: String,
    pub joined: bool,
    pub muted: bool,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    Offer,
    Answer,
    Ice,
    Bye,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SignalIn {
    pub device_id: String,
    pub to: String,
    pub kind: SignalKind,
    pub data: serde_json::Value,
}

impl SignalIn {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.data.is_object() && self.data.to_string().len() <= MAX_SIGNAL_BYTES {
            Ok(())
        } else {
            Err(invalid("data"))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReactionIn {
    pub device_id: String,
    pub emoji: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InviteesIn {
    pub user_ids: Vec<i32>,
}

impl InviteesIn {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.user_ids.len() > MAX_INVITEES {
            return Err(invalid("invitees"));
        }
        Ok(())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PartyItem {
    pub media_id: i32,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub title: String,
    pub poster_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    pub user_id: i32,
    pub username: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartySummaryDto {
    pub id: i32,
    pub name: String,
    pub status: String,
    #[serde(with = "iso_ms::opt")]
    pub scheduled_at: Option<DateTime<Utc>>,
    pub host: UserRef,
    pub item: PartyItem,
    pub member_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDto {
    pub user_id: i32,
    pub username: String,
    pub device_id: String,
    pub role: Role,
    pub status: MemberStatus,
    pub device_name: Option<String>,
    pub form_factor: Option<String>,
    pub voice: Option<Voice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyLive {
    pub rev: u64,
    pub state: State,
    pub anchor: Anchor,
    pub members: Vec<MemberDto>,
    pub messages: Vec<Message>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyDto {
    #[serde(flatten)]
    pub summary: PartySummaryDto,
    pub policy: Policy,
    pub invite_token: Option<String>,
    pub invitees: Vec<UserRef>,
    pub live: Option<PartyLive>,
}

/// `RTCIceServer`; credentials pass through as stored.
#[derive(Deserialize, Serialize)]
pub struct IceServer {
    pub urls: IceUrls,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum IceUrls {
    One(String),
    Many(Vec<String>),
}
