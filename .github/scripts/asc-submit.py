#!/usr/bin/env python3
"""Submits a build uploaded to App Store Connect for App Review, once Apple has processed it.

Usage: asc-submit.py <IOS|TV_OS|MAC_OS> <version> <build number>
Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 key).
"""
import base64, json, os, subprocess, sys, time, urllib.error, urllib.request

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE_ID = "media.fliks.app"
EDITABLE = ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY")
IN_FLIGHT = "WAITING_FOR_REVIEW,IN_REVIEW,ACCEPTED,PENDING_DEVELOPER_RELEASE,PENDING_APPLE_RELEASE,PROCESSING_FOR_DISTRIBUTION"
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


def token():
    head = b64(json.dumps({"alg": "ES256", "kid": os.environ["ASC_KEY_ID"], "typ": "JWT"}).encode())
    now = int(time.time())
    claims = {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    msg = head + b"." + b64(json.dumps(claims).encode())
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", os.environ["ASC_KEY_PATH"]],
                         input=msg, capture_output=True, check=True).stdout
    # openssl signs in DER (SEQUENCE of two INTEGERs); a JWS wants the raw 32-byte r and s.
    rlen = der[3]
    r, s = der[4:4 + rlen], der[6 + rlen:6 + rlen + der[5 + rlen]]
    return (msg + b"." + b64(r[-32:].rjust(32, b"\0") + s[-32:].rjust(32, b"\0"))).decode()


def call(method, path, data=None):
    body = json.dumps({"data": data}).encode() if data else None
    for attempt in range(5):
        req = urllib.request.Request(API + path, body, method=method,
                                     headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read() or "null")
        except urllib.error.HTTPError as e:
            # A write that hit a 5xx may have landed, so only reads and rate-limited requests are retried.
            if attempt == 4 or not (e.code == 429 or (method == "GET" and e.code >= 500)):
                sys.exit(f"{method} {path}: {e.code} {e.read().decode()}")
        except urllib.error.URLError as e:
            if attempt == 4 or method != "GET":
                sys.exit(f"{method} {path}: {e.reason}")
        time.sleep(15 * (attempt + 1))


def first(path):
    return next(iter(call("GET", path)["data"]), None)


def main(platform, version, build_number):
    app_id = next(a["id"] for a in call("GET", f"/apps?filter[bundleId]={BUNDLE_ID}")["data"]
                  if a["attributes"]["bundleId"] == BUNDLE_ID)
    versions = f"/apps/{app_id}/appStoreVersions?filter[platform]={platform}"

    ours = first(f"{versions}&filter[versionString]={version}")
    state = ours and ours["attributes"]["appVersionState"]
    if state and state not in EDITABLE + ("READY_FOR_REVIEW",):
        print(f"{platform} {version} is already {state}")
        return

    if state == "READY_FOR_REVIEW":
        version_id = ours["id"]
    else:
        editable = ours or first(f"{versions}&filter[appVersionState]={','.join(EDITABLE)}")
        busy = not editable and first(f"{versions}&filter[appVersionState]={IN_FLIGHT}")
        if busy:
            # Apple opens no new version while one is in flight; the next tag submits once it is live.
            attrs = busy["attributes"]
            print(f"::warning::{platform} {version} not submitted: {attrs['versionString']} is {attrs['appVersionState']}")
            return

        for _ in range(90):
            build = first(f"/builds?filter[app]={app_id}&filter[version]={build_number}"
                          f"&filter[preReleaseVersion.platform]={platform}&filter[preReleaseVersion.version]={version}")
            build_state = build and build["attributes"]["processingState"]
            if build_state == "VALID":
                break
            if build_state in ("FAILED", "INVALID"):
                sys.exit(f"build {build_number}: {build_state}")
            print(f"build {build_number}: {build_state or 'not listed yet'}", flush=True)
            time.sleep(60)
        else:
            sys.exit(f"build {build_number} still not processed after 90 min")

        attrs = {"versionString": version, "releaseType": "AFTER_APPROVAL"}
        if editable:
            version_id = editable["id"]
            call("PATCH", f"/appStoreVersions/{version_id}", {"type": "appStoreVersions", "id": version_id, "attributes": attrs})
        else:
            version_id = call("POST", "/appStoreVersions", {
                "type": "appStoreVersions", "attributes": {"platform": platform, **attrs},
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}})["data"]["id"]
        call("PATCH", f"/appStoreVersions/{version_id}/relationships/build", {"type": "builds", "id": build["id"]})

        # The first version of a platform takes no release notes; every later one requires them in each locale.
        if first(f"{versions}&filter[appVersionState]=READY_FOR_DISTRIBUTION"):
            for loc in call("GET", f"/appStoreVersions/{version_id}/appStoreVersionLocalizations")["data"]:
                notes = WHATS_NEW.get(loc["attributes"]["locale"].split("-")[0], WHATS_NEW["en"])
                call("PATCH", f"/appStoreVersionLocalizations/{loc['id']}",
                     {"type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": {"whatsNew": notes}})

    # A rejected version is resubmitted through its UNRESOLVED_ISSUES submission, never a new one.
    submission = first(f"/reviewSubmissions?filter[app]={app_id}&filter[platform]={platform}"
                       "&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES")
    if not submission:
        submission = call("POST", "/reviewSubmissions", {
            "type": "reviewSubmissions", "attributes": {"platform": platform},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}})["data"]
    sid = submission["id"]
    items = call("GET", f"/reviewSubmissions/{sid}/items?include=appStoreVersion")["data"]
    if not any((i["relationships"]["appStoreVersion"].get("data") or {}).get("id") == version_id for i in items):
        call("POST", "/reviewSubmissionItems", {"type": "reviewSubmissionItems", "relationships": {
            "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sid}},
            "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}}})
        # Submitting before the version reaches READY_FOR_REVIEW gets a 409 "not ready to be submitted yet".
        for _ in range(20):
            if call("GET", f"/appStoreVersions/{version_id}")["data"]["attributes"]["appVersionState"] == "READY_FOR_REVIEW":
                break
            time.sleep(15)
    call("PATCH", f"/reviewSubmissions/{sid}", {"type": "reviewSubmissions", "id": sid, "attributes": {"submitted": True}})
    print(f"{platform} {version} ({build_number}) submitted for review")


if __name__ == "__main__":
    main(*sys.argv[1:])
