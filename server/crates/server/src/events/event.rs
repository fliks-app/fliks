//! Wire events (`docs/spec/events-hub.md`, Events): the 50 `SseEvent` types, the 11 `DomainEvent`
//! types and the plugin envelope. Field names and omission rules follow `JSON.stringify` of the 4.x objects.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// A JS number: whole values serialize as integers (`5`, never `5.0`), like `JSON.stringify`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Num(pub f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.0.fract() == 0.0 && self.0.abs() < 9.0e15 {
            s.serialize_i64(self.0 as i64)
        } else {
            s.serialize_f64(self.0)
        }
    }
}

impl From<i64> for Num {
    fn from(v: i64) -> Self {
        Self(v as f64)
    }
}

impl From<f64> for Num {
    fn from(v: f64) -> Self {
        Self(v)
    }
}

/// `x?: T | null`: absent stays `None`, an explicit `null` is `Some(None)`.
fn nullable<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// `MediaProgressSubject`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Movie,
    Series,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Queued,
    Active,
    Stalled,
    Paused,
    Importing,
}

/// One download of a `download.progress` snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub r#ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_number: Option<i64>,
    pub progress: Num,
    pub dlspeed: Num,
    pub eta: Num,
    pub state: DownloadState,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerAction {
    Pause,
    Play,
    Stop,
    Message,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteAction {
    Load,
    Play,
    Pause,
    Playpause,
    Stop,
    Seek,
    Volume,
    Mute,
    Next,
    Audio,
    Subtitle,
    Quality,
    Browse,
}

/// `Option<Option<T>>` as the wire shows it: absent is `None`, `null` is `Some(None)`.
mod present {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        v.as_ref().and_then(Option::as_ref).serialize(s)
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

/// 4.x stores and relays any truthy heartbeat `state` verbatim, whatever its JSON type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayState {
    Playing,
    Paused,
    Buffering,
    #[serde(untagged)]
    Other(Value),
}

/// One rung of a remote target's quality ladder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityRung {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_bandwidth: Option<bool>,
}

/// Everything a client can receive on `/api/system/events` except `ping` and `plugin.*` (see `RawEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SseEvent {
    #[serde(rename = "sse.connected")]
    SseConnected { connection_id: String },
    #[serde(rename = "task.progress")]
    TaskProgress {
        command: String,
        current: Num,
        total: Num,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subject: Option<Subject>,
    },
    #[serde(rename = "subtitle.synced")]
    SubtitleSynced {
        subtitle_id: i64,
        language: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automatic: Option<bool>,
    },
    #[serde(rename = "subtitle.sync_failed")]
    SubtitleSyncFailed {
        subtitle_id: i64,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_id: Option<i64>,
    },
    #[serde(rename = "subtitle.sync_cancelled")]
    SubtitleSyncCancelled {
        subtitle_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_id: Option<i64>,
    },
    #[serde(rename = "subtitle.downloaded")]
    SubtitleDownloaded {
        media_id: i64,
        title: String,
        language: String,
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automatic: Option<bool>,
    },
    #[serde(rename = "subtitle.failed")]
    SubtitleFailed {
        media_id: i64,
        title: String,
        language: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automatic: Option<bool>,
    },
    #[serde(rename = "subtitle.list_changed")]
    SubtitleListChanged { media_id: i64 },
    #[serde(rename = "subtitle.translation_progress")]
    SubtitleTranslationProgress {
        subtitle_id: i64,
        media_id: i64,
        progress: Num,
    },
    #[serde(rename = "import.complete")]
    ImportComplete {
        media_id: i64,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        season_number: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        episode_number: Option<i64>,
    },
    #[serde(rename = "import.failed")]
    ImportFailed {
        media_id: i64,
        title: String,
        error: String,
    },
    #[serde(rename = "download.progress")]
    DownloadProgress {
        media_id: i64,
        media_type: MediaKind,
        downloads: Vec<Download>,
    },
    #[serde(rename = "stalled.removed")]
    StalledRemoved { title: String },
    #[serde(rename = "queue.updated")]
    QueueUpdated {},
    #[serde(rename = "activity.changed")]
    ActivityChanged {},
    #[serde(rename = "command.started")]
    CommandStarted { name: String },
    #[serde(rename = "command.completed")]
    CommandCompleted { name: String, status: String },
    #[serde(rename = "rescan.started")]
    RescanStarted { media_id: i64, title: String },
    #[serde(rename = "rescan.completed")]
    RescanCompleted {
        media_id: i64,
        title: String,
        added: i64,
        removed: i64,
        updated: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle_removed_missing: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle_removed_duplicates: Option<i64>,
    },
    #[serde(rename = "rescan.failed")]
    RescanFailed {
        media_id: i64,
        title: String,
        error: String,
    },
    #[serde(rename = "media.files.delete_failed")]
    MediaFilesDeleteFailed { media_id: i64, title: String },
    #[serde(rename = "player.command")]
    PlayerCommand {
        session_id: String,
        media_file_id: i64,
        user_id: i64,
        action: PlayerAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "markers.season.completed")]
    MarkersSeasonCompleted {
        media_id: i64,
        season_id: i64,
        season_number: i64,
        intros_detected: i64,
    },
    #[serde(rename = "metadata.started")]
    MetadataStarted { media_id: i64, title: String },
    #[serde(rename = "metadata.refreshed")]
    MetadataRefreshed { media_id: i64, title: String },
    #[serde(rename = "metadata.failed")]
    MetadataFailed {
        media_id: i64,
        title: String,
        error: String,
    },
    #[serde(rename = "watch-history.import.started")]
    WatchHistoryImportStarted { server_id: i64, server_name: String },
    #[serde(rename = "watch-history.import.completed")]
    WatchHistoryImportCompleted {
        server_id: i64,
        server_name: String,
        users: i64,
        users_created: i64,
        imported: i64,
        skipped: i64,
    },
    #[serde(rename = "watch-history.import.failed")]
    WatchHistoryImportFailed {
        server_id: i64,
        server_name: String,
        error: String,
    },
    #[serde(rename = "seerr.import.started")]
    SeerrImportStarted {},
    #[serde(rename = "seerr.import.completed")]
    SeerrImportCompleted {
        users: i64,
        users_created: i64,
        imported: i64,
        updated: i64,
        skipped: i64,
    },
    #[serde(rename = "seerr.import.failed")]
    SeerrImportFailed { error: String },
    #[serde(rename = "pairing.requested")]
    PairingRequested {
        user_id: i64,
        pairing_id: String,
        device_name: String,
        device_id: String,
    },
    #[serde(rename = "remote.command")]
    RemoteCommand {
        cmd_id: String,
        expires_at: i64,
        by_target_id: Option<String>,
        action: RemoteAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<MediaKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_file_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        episode_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position_seconds: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "nullable",
            skip_serializing_if = "Option::is_none"
        )]
        subtitle_id: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quality_id: Option<String>,
    },
    #[serde(rename = "remote.state")]
    RemoteState {
        target_id: String,
        session_id: String,
        media_id: Option<i64>,
        /// Echoes the heartbeat body: absent stays absent, a JSON `null` stays `null`.
        #[serde(default, skip_serializing_if = "Option::is_none", with = "present")]
        media_file_id: Option<Option<i64>>,
        episode_id: Option<i64>,
        media_title: Option<String>,
        episode_label: Option<String>,
        poster_url: Option<String>,
        fanart_url: Option<String>,
        position_seconds: Num,
        #[serde(default, skip_serializing_if = "Option::is_none", with = "present")]
        duration_seconds: Option<Option<Num>>,
        state: PlayState,
        volume: Option<Num>,
        muted: Option<bool>,
        supports_volume: Option<bool>,
        subtitle_id: Option<String>,
        quality: Option<String>,
        qualities: Option<Vec<QualityRung>>,
        autoplay_blocked: bool,
        has_next: bool,
        audio_track_index: Option<i64>,
        subtitle_track_index: Option<i64>,
        last_cmd_id: Option<String>,
    },
    #[serde(rename = "remote.targets_changed")]
    RemoteTargetsChanged {},
    #[serde(rename = "remote.stopped")]
    RemoteStopped { target_id: String },
    #[serde(rename = "social.followed")]
    SocialFollowed {
        user_id: i64,
        username: String,
        avatar: Option<String>,
    },
    #[serde(rename = "social.follow_request")]
    SocialFollowRequest {
        user_id: i64,
        username: String,
        avatar: Option<String>,
    },
    #[serde(rename = "social.follow_accepted")]
    SocialFollowAccepted {
        user_id: i64,
        username: String,
        avatar: Option<String>,
    },
    #[serde(rename = "social.content_recommended")]
    SocialContentRecommended {
        user_id: i64,
        username: String,
        avatar: Option<String>,
        media_title: String,
    },
    #[serde(rename = "party.state")]
    PartyState {
        party_id: i64,
        rev: i64,
        state: String,
        item: Value,
        anchor: Value,
        when_ms: Option<i64>,
        by: Option<Value>,
        action: Option<String>,
    },
    #[serde(rename = "party.members")]
    PartyMembers {
        party_id: i64,
        rev: i64,
        members: Value,
    },
    #[serde(rename = "party.settings")]
    PartySettings {
        party_id: i64,
        rev: i64,
        name: String,
        policy: String,
        reactions_enabled: bool,
        chat_enabled: bool,
        link_sharing: bool,
    },
    #[serde(rename = "party.message")]
    PartyMessage { party_id: i64, message: Value },
    #[serde(rename = "party.reaction")]
    PartyReaction {
        party_id: i64,
        user_id: i64,
        username: String,
        emoji: String,
    },
    #[serde(rename = "party.closed")]
    PartyClosed { party_id: i64, reason: String },
    #[serde(rename = "party.invited")]
    PartyInvited {
        party_id: i64,
        name: String,
        scheduled_at: Option<String>,
        host: Value,
        item: Value,
    },
    #[serde(rename = "party.starting")]
    PartyStarting { party_id: i64, name: String },
    #[serde(rename = "party.updated")]
    PartyUpdated { party_id: i64 },
    #[serde(rename = "party.signal")]
    PartySignal {
        party_id: i64,
        from: Value,
        kind: String,
        data: Value,
    },
    #[serde(rename = "party.selection")]
    PartySelection {
        party_id: i64,
        rev: i64,
        item: Option<Value>,
    },
}

impl SseEvent {
    /// The three types the household fan-out hook widens past their owner (rule 18).
    pub fn is_household_scoped(&self) -> bool {
        matches!(
            self,
            Self::RemoteState { .. } | Self::RemoteTargetsChanged {} | Self::RemoteStopped { .. }
        )
    }
}

/// A plugin event outside the closed union: wire `{"type":"plugin.<id>.<type>","payload":...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawEvent {
    pub r#type: String,
    pub payload: Value,
}

/// In-process only: never reaches a browser (rules 37-39).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum DomainEvent {
    #[serde(rename = "media.imported")]
    MediaImported {
        media_id: i64,
        tmdb_id: Option<i64>,
        media_type: String,
        library_id: Option<i64>,
        added_by_user_id: Option<i64>,
    },
    #[serde(rename = "media.monitored.changed")]
    MediaMonitoredChanged { media_id: i64, monitored: bool },
    #[serde(rename = "media.season.monitored.changed")]
    MediaSeasonMonitoredChanged {
        media_id: i64,
        season_number: i64,
        monitored: bool,
    },
    #[serde(rename = "media.removed")]
    MediaRemoved {
        media_id: i64,
        tmdb_id: Option<i64>,
        media_type: String,
    },
    #[serde(rename = "media.files.imported")]
    MediaFilesImported {
        media_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        season_number: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        episode_number: Option<i64>,
        source: ImportSource,
    },
    #[serde(rename = "media.acquisition.requested")]
    MediaAcquisitionRequested { media_ids: Vec<i64>, reason: String },
    #[serde(rename = "acquisition.grabbed")]
    AcquisitionGrabbed {
        media_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        season_number: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        episode_number: Option<i64>,
    },
    #[serde(rename = "request.created")]
    RequestCreated {
        request_id: i64,
        media_type: String,
        tmdb_id: i64,
        user_id: Option<i64>,
        kind: String,
        seasons: Option<Vec<i64>>,
    },
    #[serde(rename = "request.approved")]
    RequestApproved {
        request_id: i64,
        media_id: Option<i64>,
        media_type: String,
        tmdb_id: i64,
        seasons: Option<Vec<i64>>,
        approved_by_user_id: Option<i64>,
    },
    #[serde(rename = "library.scan.completed")]
    LibraryScanCompleted {
        library_id: i64,
        added: i64,
        updated: i64,
    },
    #[serde(rename = "settings.changed")]
    SettingsChanged { key: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportSource {
    Download,
    Disk,
}

/// What the in-process subscribers see: `{"kind":..,"event":{..}}`.
// Built per emit and moved once into an Arc: boxing `SseEvent` would only add a hop.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "event", rename_all = "lowercase")]
pub enum Bus {
    Sse(SseEvent),
    Raw(RawEvent),
    Domain(DomainEvent),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One minimal wire sample per `SseEvent` type of the spec table (50).
    fn samples() -> Vec<Value> {
        let sub = json!({"title": "T"});
        vec![
            json!({"type":"sse.connected","connectionId":"c"}),
            json!({"type":"task.progress","command":"c","current":1,"total":2,"message":"m","subject":sub}),
            json!({"type":"subtitle.synced","subtitleId":1,"language":"en"}),
            json!({"type":"subtitle.sync_failed","subtitleId":1,"error":"e","mediaId":2}),
            json!({"type":"subtitle.downloaded","mediaId":1,"title":"t","language":"en","provider":"p"}),
            json!({"type":"subtitle.failed","mediaId":1,"title":"t","language":"en","error":"e","scope":"daily"}),
            json!({"type":"subtitle.list_changed","mediaId":1}),
            json!({"type":"subtitle.translation_progress","subtitleId":1,"mediaId":2,"progress":50}),
            json!({"type":"import.complete","mediaId":1,"title":"t","seasonNumber":1}),
            json!({"type":"import.failed","mediaId":1,"title":"t","error":"e"}),
            json!({"type":"download.progress","mediaId":1,"mediaType":"series","downloads":[
                {"ref":"r","episodeNumber":3,"progress":0.5,"dlspeed":10,"eta":60,"state":"active"}]}),
            json!({"type":"stalled.removed","title":"t"}),
            json!({"type":"queue.updated"}),
            json!({"type":"activity.changed"}),
            json!({"type":"command.started","name":"n"}),
            json!({"type":"command.completed","name":"n","status":"failed"}),
            json!({"type":"rescan.started","mediaId":1,"title":"t"}),
            json!({"type":"rescan.completed","mediaId":1,"title":"t","added":1,"removed":0,"updated":2,"subtitleRemovedMissing":0}),
            json!({"type":"rescan.failed","mediaId":1,"title":"t","error":"e"}),
            json!({"type":"media.files.delete_failed","mediaId":1,"title":"t"}),
            json!({"type":"player.command","sessionId":"s","mediaFileId":1,"userId":2,"action":"message","message":"m"}),
            json!({"type":"markers.season.completed","mediaId":1,"seasonId":2,"seasonNumber":3,"introsDetected":4}),
            json!({"type":"metadata.started","mediaId":1,"title":"t"}),
            json!({"type":"metadata.refreshed","mediaId":1,"title":"t"}),
            json!({"type":"metadata.failed","mediaId":1,"title":"t","error":"e"}),
            json!({"type":"watch-history.import.started","serverId":1,"serverName":"s"}),
            json!({"type":"watch-history.import.completed","serverId":1,"serverName":"s","users":1,"usersCreated":0,"imported":2,"skipped":3}),
            json!({"type":"watch-history.import.failed","serverId":1,"serverName":"s","error":""}),
            json!({"type":"seerr.import.started"}),
            json!({"type":"seerr.import.completed","users":1,"usersCreated":0,"imported":2,"updated":3,"skipped":4}),
            json!({"type":"seerr.import.failed","error":"e"}),
            json!({"type":"pairing.requested","userId":1,"pairingId":"p","deviceName":"n","deviceId":"d"}),
            json!({"type":"remote.command","cmdId":"c","expiresAt":10,"byTargetId":null,"action":"seek","positionSeconds":12.5,"subtitleId":null,"qualityId":"q"}),
            json!({"type":"remote.state","targetId":"t","sessionId":"s","mediaId":null,"mediaFileId":1,"episodeId":null,
                "mediaTitle":null,"episodeLabel":null,"posterUrl":null,"fanartUrl":null,"positionSeconds":1,"durationSeconds":2,
                "state":"playing","volume":null,"muted":null,"supportsVolume":true,"subtitleId":null,"quality":null,
                "qualities":[{"id":"i","label":"l","lowBandwidth":true}],"autoplayBlocked":false,"hasNext":false,
                "audioTrackIndex":null,"subtitleTrackIndex":null,"lastCmdId":null}),
            json!({"type":"remote.targets_changed"}),
            json!({"type":"remote.stopped","targetId":"t"}),
            json!({"type":"social.followed","userId":1,"username":"u","avatar":null}),
            json!({"type":"social.follow_request","userId":1,"username":"u","avatar":"a"}),
            json!({"type":"social.follow_accepted","userId":1,"username":"u","avatar":null}),
            json!({"type":"social.content_recommended","userId":1,"username":"u","avatar":null,"mediaTitle":"m"}),
            json!({"type":"party.state","partyId":1,"rev":2,"state":"playing","item":{"mediaId":1},"anchor":{"position":1.5,"serverTimeMs":3},"whenMs":null,"by":{"userId":1,"username":"u"},"action":"play"}),
            json!({"type":"party.members","partyId":1,"rev":2,"members":[]}),
            json!({"type":"party.settings","partyId":1,"rev":2,"name":"n","policy":"host_only",
                "reactionsEnabled":true,"chatEnabled":true,"linkSharing":false}),
            json!({"type":"party.message","partyId":1,"message":{"id":1}}),
            json!({"type":"party.reaction","partyId":1,"userId":2,"username":"u","emoji":"x"}),
            json!({"type":"party.closed","partyId":1,"reason":"expired"}),
            json!({"type":"party.invited","partyId":1,"name":"n","scheduledAt":null,"host":{"userId":1,"username":"u"},"item":{"mediaId":1}}),
            json!({"type":"party.starting","partyId":1,"name":"n"}),
            json!({"type":"party.updated","partyId":1}),
            json!({"type":"party.signal","partyId":1,"from":{"userId":2,"deviceId":"d"},"kind":"offer","data":{"sdp":"x"}}),
            json!({"type":"party.selection","partyId":1,"rev":3,"item":{"mediaId":1}}),
        ]
    }

    #[test]
    fn every_type_round_trips_to_the_same_json() {
        let all = samples();
        assert_eq!(all.len(), 51);
        for want in all {
            let ev: SseEvent = serde_json::from_value(want.clone()).unwrap();
            assert_eq!(serde_json::to_value(&ev).unwrap(), want);
        }
    }

    #[test]
    fn numbers_print_like_json_stringify_and_nulls_survive() {
        let ev = SseEvent::TaskProgress {
            command: "c".into(),
            current: 5.0.into(),
            total: 7.5.into(),
            message: String::new(),
            subject: None,
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"type":"task.progress","command":"c","current":5,"total":7.5,"message":""}"#
        );
        let cmd: SseEvent = serde_json::from_value(
            json!({"type":"remote.command","cmdId":"c","expiresAt":1,"byTargetId":null,"action":"load","subtitleId":null}),
        )
        .unwrap();
        assert!(matches!(
            cmd,
            SseEvent::RemoteCommand {
                subtitle_id: Some(None),
                ..
            }
        ));
    }

    #[test]
    fn the_eleven_domain_events_and_the_bus_envelope_round_trip() {
        let all = [
            json!({"type":"media.imported","mediaId":1,"tmdbId":null,"mediaType":"movie","libraryId":null,"addedByUserId":2}),
            json!({"type":"media.monitored.changed","mediaId":1,"monitored":true}),
            json!({"type":"media.season.monitored.changed","mediaId":1,"seasonNumber":2,"monitored":false}),
            json!({"type":"media.removed","mediaId":1,"tmdbId":3,"mediaType":"series"}),
            json!({"type":"media.files.imported","mediaId":1,"episodeNumber":2,"source":"disk"}),
            json!({"type":"media.acquisition.requested","mediaIds":[1,2],"reason":"r"}),
            json!({"type":"acquisition.grabbed","mediaId":1}),
            json!({"type":"request.created","requestId":1,"mediaType":"movie","tmdbId":2,"userId":null,"kind":"k","seasons":null}),
            json!({"type":"request.approved","requestId":1,"mediaId":null,"mediaType":"movie","tmdbId":2,"seasons":[1],"approvedByUserId":null}),
            json!({"type":"library.scan.completed","libraryId":1,"added":2,"updated":3}),
            json!({"type":"settings.changed","key":"k"}),
        ];
        for want in all {
            let ev: DomainEvent = serde_json::from_value(want.clone()).unwrap();
            assert_eq!(serde_json::to_value(&ev).unwrap(), want);
            let bus = json!({"kind":"domain","event":want});
            let b: Bus = serde_json::from_value(bus.clone()).unwrap();
            assert_eq!(serde_json::to_value(&b).unwrap(), bus);
        }
        let raw = json!({"kind":"raw","event":{"type":"plugin.a.b","payload":{"x":1}}});
        let b: Bus = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(&b).unwrap(), raw);
    }
}
