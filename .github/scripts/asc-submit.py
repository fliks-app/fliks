#!/usr/bin/env python3
"""Submits a build uploaded to App Store Connect for App Review, once Apple has processed it.

Usage: asc-submit.py <IOS|TV_OS|MAC_OS> <version> <build number>
Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 key).
"""
import base64, json, os, subprocess, sys, time, urllib.error, urllib.request

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE_ID = "media.fliks.app"
EDITABLE = "PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY"
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
    claims = {"iss": os.environ["ASC_ISSUER_ID"], "exp": int(time.time()) + 600, "aud": "appstoreconnect-v1"}
    msg = head + b"." + b64(json.dumps(claims).encode())
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", os.environ["ASC_KEY_PATH"]],
                         input=msg, capture_output=True, check=True).stdout
    # openssl signs in DER (SEQUENCE of two INTEGERs); a JWS wants the raw 32-byte r and s.
    rlen = der[3]
    r, s = der[4:4 + rlen], der[6 + rlen:6 + rlen + der[5 + rlen]]
    return (msg + b"." + b64(r[-32:].rjust(32, b"\0") + s[-32:].rjust(32, b"\0"))).decode()


def call(method, path, data=None):
    body = json.dumps({"data": data}).encode() if data else None
    req = urllib.request.Request(API + path, body, method=method,
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read() or "null")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: {e.code} {e.read().decode()}")


def first(path):
    return next(iter(call("GET", path)["data"]), None)


def main(platform, version, build_number):
    app_id = first(f"/apps?filter[bundleId]={BUNDLE_ID}")["id"]

    for _ in range(90):
        build = first(f"/builds?filter[app]={app_id}&filter[version]={build_number}"
                      f"&filter[preReleaseVersion.platform]={platform}&filter[preReleaseVersion.version]={version}")
        state = build and build["attributes"]["processingState"]
        if state == "VALID":
            break
        if state in ("FAILED", "INVALID"):
            sys.exit(f"build {build_number}: {state}")
        print(f"build {build_number}: {state or 'not listed yet'}", flush=True)
        time.sleep(60)
    else:
        sys.exit(f"build {build_number} still not processed after 90 min")

    versions = f"/apps/{app_id}/appStoreVersions?filter[platform]={platform}"
    editable = first(f"{versions}&filter[appVersionState]={EDITABLE}")
    if editable:
        version_id = editable["id"]
        if editable["attributes"]["versionString"] != version:
            call("PATCH", f"/appStoreVersions/{version_id}",
                 {"type": "appStoreVersions", "id": version_id, "attributes": {"versionString": version}})
    else:
        version_id = call("POST", "/appStoreVersions", {
            "type": "appStoreVersions", "attributes": {"platform": platform, "versionString": version},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}})["data"]["id"]
    call("PATCH", f"/appStoreVersions/{version_id}/relationships/build", {"type": "builds", "id": build["id"]})

    # The first version of a platform takes no release notes; every later one requires them in each locale.
    if first(f"{versions}&filter[appVersionState]=READY_FOR_DISTRIBUTION"):
        for loc in call("GET", f"/appStoreVersions/{version_id}/appStoreVersionLocalizations")["data"]:
            notes = WHATS_NEW.get(loc["attributes"]["locale"].split("-")[0], WHATS_NEW["en"])
            call("PATCH", f"/appStoreVersionLocalizations/{loc['id']}",
                 {"type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": {"whatsNew": notes}})

    submission = first(f"/reviewSubmissions?filter[app]={app_id}&filter[platform]={platform}"
                       "&filter[state]=READY_FOR_REVIEW")
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
    call("PATCH", f"/reviewSubmissions/{sid}", {"type": "reviewSubmissions", "id": sid, "attributes": {"submitted": True}})
    print(f"{platform} {version} ({build_number}) submitted for review")


if __name__ == "__main__":
    main(*sys.argv[1:])
