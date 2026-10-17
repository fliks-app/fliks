//! The guest side of proxied routes (SDK-8): the host's own matcher (`plugins.md` rule 8), so a
//! path the host routed to the plugin resolves to the same route inside it.

use crate::bindings::fliks::plugin::types::{HttpRequest, HttpResponse, Principal};
use fliks_domain::plugins::route::Matcher;
pub use fliks_domain::plugins::route::ParamValue;
use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct Request {
    pub method: String,
    /// As the client sent it, percent-encoded.
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub principal: Principal,
    /// The matched route's captures, decoded.
    pub params: Vec<(String, ParamValue)>,
}

impl Request {
    /// The first value of a repeated query key.
    pub fn query(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// A `:name` capture; a `*name` capture joined with `/`.
    pub fn param(&self, name: &str) -> Option<String> {
        self.params
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| match v {
                ParamValue::One(s) => s.clone(),
                ParamValue::Many(p) => p.join("/"),
            })
    }

    pub fn json<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_slice(&self.body)
    }

    /// The acting user's id; `None` for a system call.
    pub fn user(&self) -> Option<u32> {
        match self.principal {
            Principal::Delegated(id) => Some(id),
            Principal::System => None,
        }
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    /// `application/json`, as every Node plugin answered.
    pub fn json(status: u16, body: &impl Serialize) -> Self {
        Response {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(body).expect("a JSON value serialises"),
        }
    }

    pub fn empty(status: u16) -> Self {
        Response {
            status,
            headers: vec![],
            body: vec![],
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }
}

impl From<Response> for HttpResponse {
    fn from(r: Response) -> Self {
        HttpResponse {
            status: r.status,
            headers: r.headers,
            body: r.body,
        }
    }
}

pub type Handler = fn(&Request) -> Result<Response, String>;

#[derive(Default)]
pub struct Router {
    routes: Vec<(String, Matcher, Handler)>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    /// Panics on a pattern the host would refuse at install (`PLUGIN_BAD_MANIFEST`).
    pub fn route(mut self, method: &str, path: &str, handler: Handler) -> Self {
        let m = Matcher::new(path).unwrap_or_else(|e| panic!("route {path}: {e}"));
        self.routes.push((method.to_ascii_uppercase(), m, handler));
        self
    }

    /// The first route whose method and path match; a 404 `{"error":"not found"}` otherwise.
    pub fn handle(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let method = req.method.to_ascii_uppercase();
        for (m, matcher, handler) in &self.routes {
            if *m != method {
                continue;
            }
            if let Some(params) = matcher.matches(&req.path) {
                let r = Request {
                    method,
                    path: req.path,
                    query: req.query,
                    body: req.body,
                    principal: req.principal,
                    params,
                };
                return handler(&r).map(Into::into);
            }
        }
        Ok(not_found().into())
    }
}

pub fn not_found() -> Response {
    Response::json(404, &serde_json::json!({ "error": "not found" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, path: &str, query: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            method: method.into(),
            path: path.into(),
            query: query
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
            body: br#"{"n":1}"#.to_vec(),
            principal: Principal::Delegated(7),
        }
    }

    fn echo(r: &Request) -> Result<Response, String> {
        let n: serde_json::Value = r.json().map_err(|e| e.to_string())?;
        Ok(Response::json(
            200,
            &serde_json::json!({
                "route": "id", "id": r.param("id"), "q": r.query("q"), "n": n["n"], "user": r.user(),
            }),
        )
        .with_header("etag", "\"1\""))
    }

    fn first(_: &Request) -> Result<Response, String> {
        Ok(Response::json(
            200,
            &serde_json::json!({ "route": "cooldowns" }),
        ))
    }

    fn rest(r: &Request) -> Result<Response, String> {
        Ok(Response::empty(204).with_header("x-rest", &r.param("rest").unwrap()))
    }

    fn body(r: &HttpResponse) -> serde_json::Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn first_match_wins_and_decodes_after_splitting() {
        let router = Router::new()
            .route("GET", "/indexers/cooldowns", first)
            .route("get", "/indexers/:id", echo)
            .route("POST", "/files/*rest", rest);
        let r = router
            .handle(req("GET", "/indexers/cooldowns", &[]))
            .unwrap();
        assert_eq!(body(&r)["route"], "cooldowns");
        let r = router
            .handle(req("get", "/INDEXERS/a%2Fb/", &[("q", "1"), ("q", "2")]))
            .unwrap();
        assert_eq!(
            body(&r),
            serde_json::json!({"route": "id", "id": "a/b", "q": "1", "n": 1, "user": 7})
        );
        assert_eq!(
            r.headers[0],
            ("content-type".into(), "application/json".into())
        );
        assert_eq!(r.headers[1], ("etag".into(), "\"1\"".into()));
        let r = router.handle(req("POST", "/files/a/b%20c", &[])).unwrap();
        assert_eq!((r.status, r.headers[0].1.as_str()), (204, "a/b c"));
        assert_eq!(
            router
                .handle(req("POST", "/indexers/1", &[]))
                .unwrap()
                .status,
            404
        );
        assert_eq!(
            router
                .handle(req("GET", "/indexers/%E0%A4%A", &[]))
                .unwrap()
                .status,
            404
        );
        assert_eq!(
            body(&router.handle(req("GET", "/nope", &[])).unwrap())["error"],
            "not found"
        );
    }
}
