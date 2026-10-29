//! Request bodies and response shapes (`docs/spec/watch-party.md`, DTOs): every key present.
use super::cover::{Cover, CoverDto};
use crate::http::{AppError, json::iso_ms};
use chrono::{DateTime, Utc};
use fliks_domain::party::{
    Action, Anchor, Item, MemberStatus, Message, Policy, Role, State, Voice,
};
use serde::{Deserialize, Serialize};

pub const MAX_PROGRAMME: usize = 500;
const MAX_INVITEES: usize = 50;
const MAX_TEXT: usize = 500;
const MAX_SIGNAL_BYTES: usize = 16 * 1024;

/// For `Option<Option<T>>` fields: absent is `None`, an explicit null is `Some(None)`.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
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
    pub media_id: Option<i32>,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub playlist_id: Option<i32>,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub policy: Option<Policy>,
    pub reactions_enabled: Option<bool>,
    pub chat_enabled: Option<bool>,
    pub link_sharing: Option<bool>,
    pub public: Option<bool>,
    pub invitee_ids: Option<Vec<i32>>,
    pub items: Option<Vec<ItemIn>>,
    pub cover: Option<Cover>,
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
        if let Some(items) = &self.items
            && (items.len() > MAX_PROGRAMME
                || self.media_id.is_some()
                || self.media_file_id.is_some()
                || self.episode_id.is_some()
                || self.playlist_id.is_some())
        {
            return Err(invalid("item"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Patch {
    pub name: Option<String>,
    pub policy: Option<Policy>,
    pub reactions_enabled: Option<bool>,
    pub chat_enabled: Option<bool>,
    pub link_sharing: Option<bool>,
    pub public: Option<bool>,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub regenerate_token: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub cover: Option<Option<Cover>>,
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

#[derive(Deserialize, Clone)]
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
pub struct ProgrammeIn {
    pub items: Vec<ItemIn>,
}

/// `Action` plus the programme steps, which the server turns into a `setItem` of its own choosing.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IntentAction {
    Play,
    Pause,
    Seek,
    SetItem,
    Ended,
    Next,
    Previous,
}

impl IntentAction {
    pub fn machine(self) -> Option<Action> {
        match self {
            Self::Play => Some(Action::Play),
            Self::Pause => Some(Action::Pause),
            Self::Seek => Some(Action::Seek),
            Self::SetItem => Some(Action::SetItem),
            Self::Ended => Some(Action::Ended),
            Self::Next | Self::Previous => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntentIn {
    pub device_id: String,
    pub action: IntentAction,
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
    pub to_user_id: i32,
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
    pub fanart_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
    /// Episode only, else null: still, series title, season and episode numbers, episode title.
    pub still_url: Option<String>,
    pub series_title: Option<String>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub episode_title: Option<String>,
    /// The viewer cannot open the media: title and artwork are blanked, the ids stay.
    pub hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    pub user_id: i32,
    pub username: String,
}

/// A party row for a user: `source` is `invite` or `link`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDto {
    pub user_id: i32,
    pub username: String,
    pub source: String,
}

#[derive(Serialize, Clone)]
pub struct PlaylistRef {
    pub id: i32,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PartySummaryDto {
    pub id: i32,
    pub name: String,
    pub status: String,
    #[serde(with = "iso_ms::opt")]
    pub scheduled_at: Option<DateTime<Utc>>,
    pub host: UserRef,
    pub item: Option<PartyItem>,
    pub playlist: Option<PlaylistRef>,
    pub member_count: usize,
    pub public: bool,
    pub cover: Option<CoverDto>,
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
pub struct PlaybackDto {
    pub state: State,
    pub anchor: Anchor,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyLive {
    pub rev: u64,
    pub playback: Option<PlaybackDto>,
    pub members: Vec<MemberDto>,
    pub messages: Vec<Message>,
}

/// A film put forward by a member; `item` is masked for a viewer who cannot open it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    pub id: i32,
    pub item: PartyItem,
    pub proposed_by: i32,
    pub upvoter_ids: Vec<i32>,
    pub downvoter_ids: Vec<i32>,
}

/// `1` up, `-1` down.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoteIn {
    #[serde(deserialize_with = "vote_value")]
    pub value: i16,
}

fn vote_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i16, D::Error> {
    match i16::deserialize(d)? {
        v @ (1 | -1) => Ok(v),
        _ => Err(serde::de::Error::custom("value must be 1 or -1")),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProposalIn {
    pub media_id: i32,
    pub episode_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalsIn {
    pub items: Vec<ProposalIn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyDto {
    #[serde(flatten)]
    pub summary: PartySummaryDto,
    pub policy: Policy,
    pub reactions_enabled: bool,
    pub chat_enabled: bool,
    pub link_sharing: bool,
    pub invite_token: Option<String>,
    pub guests: Vec<GuestDto>,
    pub proposals: Vec<ProposalDto>,
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
