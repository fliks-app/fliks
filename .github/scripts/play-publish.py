#!/usr/bin/env python3
"""Uploads an app bundle to a Google Play track and sends it for review, unless changes are already in review.

Usage: play-publish.py <bundle.aab> <track>
Env: PLAY_SERVICE_ACCOUNT_JSON (the service account key file contents).
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

PACKAGE = "media.fliks.app"
API = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{PACKAGE}"
UPLOAD = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{PACKAGE}"
WHATS_NEW = {
    "en": "Bug fixes and performance improvements.",
    "fr": "Corrections de bugs et amélioration des performances.",
    "de": "Fehlerbehebungen und Leistungsverbesserungen.",
    "es": "Corrección de errores y mejoras de rendimiento.",
    "it": "Correzioni di bug e miglioramenti delle prestazioni.",
    "pt": "Correções de erros e melhorias de desempenho.",
}


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def request(method, url, body=None, headers=None, retry=False):
    """Returns (status, headers, body), status 0 on a network error; 429s, and 5xx with `retry`, are retried."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, body, headers or {}, method=method), timeout=300) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            response = e.code, e.headers, e.read()
            if attempt == 4 or not (e.code == 429 or (retry and e.code >= 500)):
                return response
        except (urllib.error.URLError, TimeoutError) as e:
            response = 0, {}, str(e).encode()
            if attempt == 4 or not retry:
                return response
        time.sleep(2 ** attempt)


def access_token(account):
    now = int(time.time())
    head = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": account["private_key_id"]}).encode())
    claims = {"iss": account["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
              "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600}
    msg = head + b"." + b64(json.dumps(claims).encode())
    with tempfile.NamedTemporaryFile("w") as key:
        key.write(account["private_key"])
        key.flush()
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key.name],
                             input=msg, capture_output=True, check=True).stdout
    form = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": (msg + b"." + b64(sig)).decode()}).encode()
    status, _, body = request("POST", "https://oauth2.googleapis.com/token", form,
                              {"Content-Type": "application/x-www-form-urlencoded"}, retry=True)
    if status != 200:
        sys.exit(f"token: {status} {body.decode()}")
    return json.loads(body)["access_token"]


def main(bundle_path, track):
    auth = {"Authorization": f"Bearer {access_token(json.loads(os.environ['PLAY_SERVICE_ACCOUNT_JSON']))}"}

    def api(method, path, data=None, ok=(200,)):
        body = json.dumps(data).encode() if data is not None else None
        status, _, text = request(method, API + path, body, {**auth, "Content-Type": "application/json"}, retry=method == "GET")
        if status not in ok:
            sys.exit(f"{method} {path}: {status} {text.decode()}")
        return status, json.loads(text or "null")

    edit = api("POST", "/edits", {})[1]["id"]

    with open(bundle_path, "rb") as f:
        bundle = f.read()
    size = len(bundle)
    status, headers, text = request("POST", f"{UPLOAD}/edits/{edit}/bundles?uploadType=resumable", b"", {
        **auth, "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": str(size)})
    if status != 200:
        sys.exit(f"upload session: {status} {text.decode()}")
    session, offset = headers["Location"], 0
    # An interrupted PUT resumes from the offset the session reports, as the resumable protocol prescribes.
    for attempt in range(5):
        status, headers, text = request("PUT", session, bundle[offset:], {
            "Content-Type": "application/octet-stream", "Content-Range": f"bytes {offset}-{size - 1}/{size}"})
        if status in (200, 201):
            break
        if 0 < status < 500:
            sys.exit(f"upload: {status} {text.decode()}")
        time.sleep(2 ** attempt)
        status, headers, text = request("PUT", session, b"", {"Content-Range": f"bytes */{size}"})
        if status in (200, 201):
            break
        if status == 308:
            offset = int(headers["Range"].rsplit("-", 1)[1]) + 1 if headers.get("Range") else 0
    else:
        sys.exit(f"upload: gave up after 5 attempts ({status} {text.decode()})")
    version_code = json.loads(text)["versionCode"]

    notes = [{"language": l["language"], "text": WHATS_NEW.get(l["language"].split("-")[0], WHATS_NEW["en"])}
             for l in api("GET", f"/edits/{edit}/listings")[1]["listings"]]
    api("PUT", f"/edits/{edit}/tracks/{track}", {"track": track, "releases": [
        {"versionCodes": [str(version_code)], "status": "completed", "releaseNotes": notes}]})

    status, _, text = request("POST", f"{API}/edits/{edit}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW", b"", auth)
    if status == 400 and b"CHANGES_ALREADY_IN_REVIEW" in text:
        # The edit stays open and the next one invalidates it; the next tag ships once this review is over.
        print(f"::warning::{version_code} not sent to {track}: other changes are still in review")
        return
    if status != 200:
        sys.exit(f"commit: {status} {text.decode()}")
    print(f"{version_code} sent to {track} for review")


if __name__ == "__main__":
    main(*sys.argv[1:])
