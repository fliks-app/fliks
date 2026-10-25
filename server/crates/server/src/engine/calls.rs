//! The engine calls the host makes (`engine-glue.md` section D), typed with `fliks_engine_core::api`.
use super::{
    Engine, Timing,
    client::{Client, Reply, enc},
};
use fliks_engine_core::api::{
    CacheDeleteResult, CacheSummary, CapabilitiesResponse, EstimateSizesRequest, HeartbeatRequest,
    HeartbeatResponse, IntroDetectRequest, IntroDetectResponse, JobAccepted, JobRequest,
    JobSnapshot, LiveSnapshot, MediaInfo, MediaRef, OpenLiveRequest, OpenLiveResponse,
    OpenSessionRequest, OpenSessionResponse, ProbeRequest, ProbeResult, QualityEstimate,
    SessionAction, SessionCommand, SessionSnapshot,
};
use reqwest::Method;
use serde::Serialize;
use std::{fmt, time::Instant};

const DEFAULT_RENDER_NODE: &str = "/dev/dri/renderD128";

/// A failed engine call; the 503 variants carry the 4.x messages.
#[derive(Debug)]
pub enum EngineError {
    /// No adopted engine: 503 "The streaming engine is not running".
    NotRunning,
    /// The engine has no `live` feature: 503 "The engine has no live TV runtime".
    NoLive,
    /// A non-2xx answer: `what` names the call, `code` is the error body's `code` (`live_at_capacity`).
    Http {
        what: String,
        status: u16,
        code: Option<String>,
    },
    /// The engine did not answer.
    Transport(String),
    /// A background job ended `failed` or `cancelled`.
    Job {
        state: String,
        what: String,
    },
    Other(String),
}

impl EngineError {
    pub(super) fn http(what: &str, reply: &Reply) -> Self {
        Self::Http {
            what: what.to_owned(),
            status: reply.status.as_u16(),
            code: reply.code(),
        }
    }

    /// The HTTP status of an `Http` error.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunning => f.write_str("The streaming engine is not running"),
            Self::NoLive => f.write_str("The engine has no live TV runtime"),
            Self::Http { what, status, .. } => write!(f, "{what} -> {status}"),
            Self::Transport(e) | Self::Other(e) => f.write_str(e),
            Self::Job { state, what } => write!(f, "engine job {state}: {what}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<reqwest::Error> for EngineError {
    fn from(e: reqwest::Error) -> Self {
        Self::Transport(e.without_url().to_string())
    }
}

impl From<sqlx::Error> for EngineError {
    fn from(e: sqlx::Error) -> Self {
        Self::Other(format!("database: {e}"))
    }
}

/// `GET /v1/sessions` filters.
#[derive(Debug, Default, Clone)]
pub struct SessionFilter {
    pub owner_id: Option<String>,
    pub media_file_id: Option<u32>,
}

/// `POST /api/engine/remote/test` result: `ok: false` with `error`, or the hello and the probe outcome.
#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_error: Option<String>,
}

impl ConnectionTest {
    fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }
}

/// `data`, `Http` with the call's name, or `Other` with why a 2xx body is not a `T`.
fn expect<T: serde::de::DeserializeOwned>(what: &str, reply: &Reply) -> Result<T, EngineError> {
    match reply.parse() {
        Ok(data) => Ok(data),
        Err(e) if reply.ok() => Err(EngineError::Other(format!(
            "{what}: unreadable answer: {e}"
        ))),
        Err(_) => Err(EngineError::http(what, reply)),
    }
}

/// A session the engine opened but the host cannot read is closed, else it runs until the engine reaps it.
async fn release_unread(client: &Client, reply: &Reply) {
    let Some(sid) = reply.body.as_ref().and_then(|b| b["sessionId"].as_str()) else {
        return;
    };
    match client
        .delete(&format!("/v1/sessions/{}", enc(sid)), &[])
        .await
    {
        Ok(r) if !r.ok() => tracing::warn!("DELETE unread session -> {}", r.status.as_u16()),
        Err(e) => tracing::warn!("DELETE unread session failed: {}", e.without_url()),
        Ok(_) => {}
    }
}

fn seconds(t: &Timing, secs: f64) -> std::time::Duration {
    t.second.mul_f64(secs)
}

impl Engine {
    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        what: &str,
        path: &str,
        query: &[(&str, Option<String>)],
    ) -> Result<T, EngineError> {
        expect(what, &self.need()?.get(path, query).await?)
    }

    async fn post<B: Serialize + ?Sized, T: serde::de::DeserializeOwned>(
        &self,
        what: &str,
        path: &str,
        body: &B,
    ) -> Result<T, EngineError> {
        let reply = self.need()?.send(Method::POST, path, body).await?;
        expect(what, &reply)
    }

    /// `GET /v1/capabilities`, waiting out the 503 + `Retry-After` of the first detection run.
    pub async fn capabilities(&self) -> Result<CapabilitiesResponse, EngineError> {
        let client = self.need()?;
        let t = self.timing();
        let deadline = Instant::now() + t.capabilities_deadline;
        loop {
            let reply = client.get("/v1/capabilities", &[]).await?;
            if let Some(caps) = reply.data() {
                return Ok(caps);
            }
            if reply.status.as_u16() != 503 || Instant::now() > deadline {
                return Err(EngineError::http("GET /v1/capabilities", &reply));
            }
            tokio::time::sleep(seconds(&t, reply.retry_after_secs())).await;
        }
    }

    /// Capabilities of the run for `gpu_render_node`: a re-run keeps serving the previous snapshot,
    /// and `default_gpu` (set whenever there are GPUs) is the only field that tells them apart.
    pub async fn capabilities_for(
        &self,
        gpu_render_node: &str,
    ) -> Result<CapabilitiesResponse, EngineError> {
        let pin = gpu_render_node.trim();
        let want = if pin.is_empty() || pin == "auto" {
            DEFAULT_RENDER_NODE
        } else {
            pin
        };
        let t = self.timing();
        let deadline = Instant::now() + t.capabilities_deadline;
        loop {
            let caps = self.capabilities().await?;
            let c = &caps.capabilities;
            if c.gpus.is_empty() || c.default_gpu.as_deref() == Some(want) {
                return Ok(caps);
            }
            if Instant::now() > deadline {
                tracing::warn!(
                    "capabilities still on {:?} after pinning {want}",
                    c.default_gpu
                );
                return Ok(caps);
            }
            tokio::time::sleep(t.second).await;
        }
    }

    pub async fn probe(
        &self,
        path: &str,
        crop: bool,
        mkv_tags: bool,
        moviehash: bool,
    ) -> Result<ProbeResult, EngineError> {
        let body = ProbeRequest {
            media: MediaRef {
                media_file_id: 0,
                path: path.to_owned(),
            },
            crop,
            mkv_tags,
            moviehash,
        };
        self.post("POST /v1/probe", "/v1/probe", &body).await
    }

    /// Download size per quality rung of a probed file; `info` absent sends an empty object.
    pub async fn estimate_sizes(
        &self,
        info: Option<&MediaInfo>,
        file_size: f64,
    ) -> Result<Vec<QualityEstimate>, EngineError> {
        let body = match info {
            Some(info) => serde_json::to_value(EstimateSizesRequest {
                info: info.clone(),
                file_size,
            }),
            None => Ok(serde_json::json!({"info": {}, "fileSize": file_size})),
        }
        .map_err(|e| EngineError::Other(e.to_string()))?;
        self.post("POST /v1/estimate-sizes", "/v1/estimate-sizes", &body)
            .await
    }

    /// Drops the file's jobs, cache entries and subtitle extracts, best effort: a replaced file.
    pub async fn invalidate(&self, media_file_id: u32) {
        let Ok(client) = self.need() else { return };
        let body = serde_json::json!({"mediaFileId": media_file_id});
        match client.send(Method::POST, "/v1/invalidate", &body).await {
            Ok(r) if !r.ok() => tracing::warn!("POST /v1/invalidate -> {}", r.status.as_u16()),
            Err(e) => tracing::warn!("POST /v1/invalidate failed: {}", e.without_url()),
            Ok(_) => {}
        }
    }

    /// `POST /v1/sessions`, waiting out the 503 + `Retry-After` of the first detection run.
    /// `replaces` retires that session in the same call, sent only to an engine that lists
    /// `session-replaces`.
    pub async fn open_session(
        &self,
        body: &OpenSessionRequest,
        replaces: Option<&str>,
    ) -> Result<OpenSessionResponse, EngineError> {
        let client = self.need()?;
        let mut body = serde_json::to_value(body).map_err(|e| EngineError::Other(e.to_string()))?;
        if let Some(sid) = replaces
            && self
                .engine_features()
                .iter()
                .any(|f| f == "session-replaces")
        {
            body["replaces"] = sid.into();
        }
        self.open_retrying(&client, "POST /v1/sessions", "/v1/sessions", &body, false)
            .await
    }

    /// `POST /v1/live`; a `live_*` error body surfaces as `Http` with its `code`.
    pub async fn open_live(&self, body: &OpenLiveRequest) -> Result<OpenLiveResponse, EngineError> {
        let client = self.need()?;
        if !self.engine_features().iter().any(|f| f == "live") {
            return Err(EngineError::NoLive);
        }
        self.open_retrying(&client, "POST /v1/live", "/v1/live", body, true)
            .await
    }

    pub(super) async fn open_retrying<B: Serialize, T: serde::de::DeserializeOwned>(
        &self,
        client: &Client,
        what: &str,
        path: &str,
        body: &B,
        coded_errors_are_final: bool,
    ) -> Result<T, EngineError> {
        let t = self.timing();
        let deadline = Instant::now() + t.open_deadline;
        loop {
            let reply = client.send(Method::POST, path, body).await?;
            match expect(what, &reply) {
                Ok(data) => return Ok(data),
                Err(e @ EngineError::Other(_)) => {
                    release_unread(client, &reply).await;
                    return Err(e);
                }
                Err(_) => {}
            }
            let coded = coded_errors_are_final && reply.code().is_some();
            if reply.status.as_u16() != 503 || coded || Instant::now() > deadline {
                return Err(EngineError::http(what, &reply));
            }
            tokio::time::sleep(seconds(&t, reply.retry_after_secs())).await;
        }
    }

    pub async fn list_live(
        &self,
        owner_id: Option<&str>,
    ) -> Result<Vec<LiveSnapshot>, EngineError> {
        let query = [("ownerId", owner_id.map(str::to_owned))];
        self.get("GET /v1/live", "/v1/live", &query).await
    }

    /// One viewer of a live session; `None` on 404.
    pub async fn get_live(&self, sid: &str) -> Result<Option<LiveSnapshot>, EngineError> {
        let reply = self
            .need()?
            .get(&format!("/v1/live/{}", enc(sid)), &[])
            .await?;
        if reply.status.as_u16() == 404 {
            return Ok(None);
        }
        expect("GET live", &reply).map(Some)
    }

    /// `session_lost` when the engine no longer knows the sid; `Http` 403 for another owner.
    pub async fn heartbeat(
        &self,
        sid: &str,
        body: &HeartbeatRequest,
    ) -> Result<HeartbeatResponse, EngineError> {
        let path = format!("/v1/sessions/{}/heartbeat", enc(sid));
        self.post("POST heartbeat", &path, body).await
    }

    /// Idempotent: an unknown sid is fine.
    pub async fn delete_session(&self, sid: &str, reason: Option<&str>) -> Result<(), EngineError> {
        let path = format!("/v1/sessions/{}", enc(sid));
        let query = [("reason", reason.map(str::to_owned))];
        let reply = self.need()?.delete(&path, &query).await?;
        if reply.ok() {
            Ok(())
        } else {
            Err(EngineError::http("DELETE session", &reply))
        }
    }

    /// The HTTP status of the command: 204 done, 404 unknown sid, 409 nothing to pause or stop.
    pub async fn session_command(
        &self,
        sid: &str,
        action: SessionAction,
    ) -> Result<u16, EngineError> {
        let path = format!("/v1/sessions/{}/command", enc(sid));
        let body = SessionCommand { action };
        let reply = self.need()?.send(Method::POST, &path, &body).await?;
        Ok(reply.status.as_u16())
    }

    pub async fn list_sessions(
        &self,
        filter: &SessionFilter,
    ) -> Result<Vec<SessionSnapshot>, EngineError> {
        let query = [
            ("ownerId", filter.owner_id.clone()),
            ("mediaFileId", filter.media_file_id.map(|n| n.to_string())),
        ];
        self.get("GET /v1/sessions", "/v1/sessions", &query).await
    }

    /// `None` on 404.
    pub async fn get_session(&self, sid: &str) -> Result<Option<SessionSnapshot>, EngineError> {
        let reply = self
            .need()?
            .get(&format!("/v1/sessions/{}", enc(sid)), &[])
            .await?;
        if reply.status.as_u16() == 404 {
            return Ok(None);
        }
        expect("GET session", &reply).map(Some)
    }

    pub async fn cache(&self) -> Result<CacheSummary, EngineError> {
        self.get("GET /v1/cache", "/v1/cache", &[]).await
    }

    /// Removes the matching non-live entries; the count removed.
    pub async fn purge_cache(
        &self,
        media_file_id: Option<u32>,
        owner_id: Option<&str>,
    ) -> Result<u32, EngineError> {
        let query = [
            ("mediaFileId", media_file_id.map(|n| n.to_string())),
            ("ownerId", owner_id.map(str::to_owned)),
        ];
        let reply = self.need()?.delete("/v1/cache", &query).await?;
        expect::<CacheDeleteResult>("DELETE /v1/cache", &reply).map(|r| r.removed)
    }

    pub async fn intro_detect(
        &self,
        body: &IntroDetectRequest,
    ) -> Result<IntroDetectResponse, EngineError> {
        self.post("POST /v1/intro-detect", "/v1/intro-detect", body)
            .await
    }

    /// The job's id; an identical request still queued or running answers the same one.
    pub async fn submit_job(&self, req: &JobRequest) -> Result<String, EngineError> {
        let accepted: JobAccepted = self.post("POST /v1/jobs", "/v1/jobs", req).await?;
        Ok(accepted.job_id)
    }

    /// Idempotent: an ended or unknown job is fine.
    pub async fn cancel_job(&self, job_id: &str) -> Result<(), EngineError> {
        let reply = self
            .need()?
            .delete(&format!("/v1/jobs/{}", enc(job_id)), &[])
            .await?;
        if reply.ok() || reply.status.as_u16() == 404 {
            Ok(())
        } else {
            Err(EngineError::http("DELETE job", &reply))
        }
    }

    /// `None` on 404.
    pub async fn get_job(&self, job_id: &str) -> Result<Option<JobSnapshot>, EngineError> {
        let reply = self
            .need()?
            .get(&format!("/v1/jobs/{}", enc(job_id)), &[])
            .await?;
        if reply.status.as_u16() == 404 {
            return Ok(None);
        }
        expect("GET job", &reply).map(Some)
    }

    /// One-shot hello (and optional probe) without adopting the engine; blank `url`/`token` take the
    /// configured ones.
    pub async fn test_connection(
        &self,
        url: &str,
        token: &str,
        probe_path: Option<&str>,
    ) -> ConnectionTest {
        let (saved_url, saved_token) = self.configured();
        let url = Some(url.trim())
            .filter(|u| !u.is_empty())
            .unwrap_or(&saved_url);
        let token = Some(token.trim())
            .filter(|t| !t.is_empty())
            .unwrap_or(&saved_token);
        if url.is_empty() || token.is_empty() {
            return ConnectionTest::failed("Engine URL and token are required".into());
        }
        let client = Client::new(url, token);
        let unreachable =
            || ConnectionTest::failed(format!("The streaming engine at {url} did not answer"));
        let Some(hello) = client
            .get("/v1/hello", &[])
            .await
            .ok()
            .and_then(|r| r.data::<fliks_engine_core::api::Hello>())
        else {
            return unreachable();
        };
        let base = ConnectionTest {
            ok: true,
            engine_version: Some(hello.engine_version),
            protocol_version: Some(hello.protocol_version),
            ..ConnectionTest::default()
        };
        let Some(path) = probe_path.map(str::trim).filter(|p| !p.is_empty()) else {
            return base;
        };
        let body = ProbeRequest {
            media: MediaRef {
                media_file_id: 0,
                path: path.to_owned(),
            },
            crop: false,
            mkv_tags: false,
            moviehash: false,
        };
        let (probe_ok, probe_error) = match client.send(Method::POST, "/v1/probe", &body).await {
            Err(_) => (false, Some("Probe did not answer".to_owned())),
            Ok(r) if !r.ok() => (false, Some(format!("probe -> {}", r.status.as_u16()))),
            Ok(r) => match r.data::<ProbeResult>() {
                Some(p) if !p.ok => (
                    false,
                    Some(p.error.unwrap_or_else(|| "Probe failed".into())),
                ),
                _ => (true, None),
            },
        };
        ConnectionTest {
            probe_ok: Some(probe_ok),
            probe_error,
            ..base
        }
    }
}
