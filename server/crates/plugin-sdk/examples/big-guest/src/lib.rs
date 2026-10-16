//! Size stand-in: generated code reachable from one route.

use fliks_plugin_sdk::{HttpRequest, HttpResponse, Plugin, json_response};

include!(concat!(env!("OUT_DIR"), "/gen.rs"));

struct Big;

impl Plugin for Big {
    fn http(req: HttpRequest) -> Result<HttpResponse, String> {
        let i = req.body.len() % FNS.len();
        Ok(json_response(
            200,
            FNS[i](req.body.len() as u64).to_string(),
        ))
    }
}

fliks_plugin_sdk::export!(Big);
