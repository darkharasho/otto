#!/usr/bin/env python3
"""Submit an iOS build that's already in TestFlight for App Store review, without third-party packages.

  asc-submit.py status <bundle-id>
  asc-submit.py submit <bundle-id> <NAME+NUMBER> [--whats-new TEXT] [--replace-waiting] [--wait MINUTES]

  env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID

status lists the app's App Store versions, review submissions and newest builds; it only reads.
submit puts build NAME+NUMBER on the app's editable App Store version (renaming that version or
creating one), sets What's New where it's empty (or everywhere when --whats-new is given), and
submits it for review. --wait gives a just-uploaded build that long to
appear and finish processing. App Store Connect allows one version in flight: an older version waiting
for review or in review is pulled only with --replace-waiting (named before it covered reviews in
progress); without it, the submission stops.
Never prints keys.
"""
import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.parse
import urllib.request

_spec = importlib.util.spec_from_file_location(
    "store_check", os.path.join(os.path.dirname(os.path.abspath(__file__)), "store-check.py"))
store_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(store_check)

API = "https://api.appstoreconnect.apple.com"
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED",
            "INVALID_BINARY"}
IN_FLIGHT = {"WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"}


def token() -> str:
    b64url, now = store_check.b64url, int(time.time())
    header = b64url(json.dumps({"alg": "ES256", "kid": os.environ["ASC_KEY_ID"], "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1200,
                                "aud": "appstoreconnect-v1"}).encode())
    sig = store_check.der_ecdsa_to_raw(store_check.sign(os.environ["ASC_KEY_PATH"], f"{header}.{claims}".encode()))
    return f"{header}.{claims}.{b64url(sig)}"


class Asc:
    def __init__(self):
        self.auth = {"Authorization": f"Bearer {token()}", "Content-Type": "application/json"}

    def call(self, method: str, path: str, params: dict | None = None, body: dict | None = None) -> dict:
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        status, out = store_check.http(urllib.request.Request(url, data=data, method=method, headers=self.auth))
        if status >= 300:
            errors = "; ".join(f"{e.get('title')}: {e.get('detail')}" for e in out.get("errors", [])) or json.dumps(out)[:400]
            raise RuntimeError(f"{method} {path} returned {status}: {errors}")
        return out

    def get(self, path, **params):
        return self.call("GET", path, params)

    def patch(self, kind, ident, attributes=None, relationships=None):
        data = {"type": kind, "id": ident}
        if attributes:
            data["attributes"] = attributes
        if relationships:
            data["relationships"] = relationships
        return self.call("PATCH", f"/v1/{kind}/{ident}", body={"data": data})

    def post(self, kind, attributes=None, relationships=None):
        data = {"type": kind}
        if attributes:
            data["attributes"] = attributes
        if relationships:
            data["relationships"] = relationships
        return self.call("POST", f"/v1/{kind}", body={"data": data})["data"]


def rel(kind, ident):
    return {"data": {"type": kind, "id": ident}}


def state(version: dict) -> str:
    a = version["attributes"]
    return a.get("appVersionState") or a.get("appStoreState") or "?"


def app_id(asc: Asc, bundle_id: str) -> str:
    apps = asc.get("/v1/apps", **{"filter[bundleId]": bundle_id})["data"]
    match = [a for a in apps if a["attributes"]["bundleId"] == bundle_id]
    if not match:
        raise RuntimeError(f"no App Store Connect app has bundle id {bundle_id}")
    return match[0]["id"]


def versions(asc: Asc, app: str) -> list:
    return asc.get(f"/v1/apps/{app}/appStoreVersions", **{"filter[platform]": "IOS", "limit": "10"})["data"]


def submissions(asc: Asc, app: str) -> list:
    return asc.get("/v1/reviewSubmissions", **{"filter[app]": app, "filter[platform]": "IOS",
                                               "limit": "20"})["data"]


def submission_versions(asc: Asc, submission: str) -> list[str]:
    items = asc.get(f"/v1/reviewSubmissions/{submission}/items", include="appStoreVersion")
    return [i["relationships"]["appStoreVersion"]["data"]["id"] for i in items["data"]
            if (i.get("relationships", {}).get("appStoreVersion") or {}).get("data")]


def status(asc: Asc, app: str) -> None:
    print("App Store versions:")
    for v in versions(asc, app):
        print(f"  {v['attributes']['versionString']:<10} {state(v):<26} {v['id']}")
    print("Review submissions:")
    for s in submissions(asc, app):
        a = s["attributes"]
        print(f"  {a.get('state'):<26} submitted {a.get('submittedDate') or '-':<26} {s['id']}")
    print("Newest builds:")
    builds = asc.get("/v1/builds", **{"filter[app]": app, "sort": "-uploadedDate", "limit": "8",
                                      "include": "preReleaseVersion"})
    names = {i["id"]: i["attributes"]["version"] for i in builds.get("included", [])}
    for b in builds["data"]:
        pre = (b["relationships"].get("preReleaseVersion") or {}).get("data") or {}
        a = b["attributes"]
        print(f"  {names.get(pre.get('id'), '?')}+{a['version']:<12} {a['processingState']:<11} "
              f"expired={a.get('expired')} uploaded {a.get('uploadedDate')}")


def submit(asc: Asc, app: str, release: str, whats_new: str | None, replace_waiting: bool,
           wait_minutes: int = 0) -> None:
    name, _, number = release.partition("+")
    if not name or not number:
        raise RuntimeError(f"expected NAME+NUMBER, got {release!r}")

    deadline = time.monotonic() + wait_minutes * 60
    while True:
        builds = asc.get("/v1/builds", **{"filter[app]": app, "filter[version]": number,
                                          "filter[preReleaseVersion.version]": name})["data"]
        processing = builds[0]["attributes"]["processingState"] if builds else None
        if processing == "VALID" or processing in {"FAILED", "INVALID"} or time.monotonic() > deadline:
            break
        print(f"Build {release} is {processing or 'not in App Store Connect yet'}; waiting")
        time.sleep(60)
    if not builds:
        raise RuntimeError(f"App Store Connect has no build {release}")
    build = builds[0]
    if build["attributes"]["processingState"] != "VALID":
        raise RuntimeError(f"build {release} is {build['attributes']['processingState']}, not VALID yet")
    if build["attributes"].get("usesNonExemptEncryption") is None:
        asc.patch("builds", build["id"], {"usesNonExemptEncryption": False})
    print(f"Build {release}: {build['id']}")

    # One version in flight at a time: pull an older one, waiting or in review, when asked to.
    for s in submissions(asc, app):
        if s["attributes"]["state"] not in IN_FLIGHT:
            continue
        if not replace_waiting:
            raise RuntimeError(f"review submission {s['id']} is {s['attributes']['state']}; "
                               "pass --replace-waiting to pull it")
        print(f"Pulling review submission {s['id']} ({s['attributes']['state']})")
        asc.patch("reviewSubmissions", s["id"], {"canceled": True})
        for _ in range(30):
            if all(state(v) not in IN_FLIGHT for v in versions(asc, app)):
                break
            time.sleep(10)

    editable = [v for v in versions(asc, app) if state(v) in EDITABLE]
    if editable:
        version = editable[0]
        if version["attributes"]["versionString"] != name:
            print(f"Renaming App Store version {version['attributes']['versionString']} to {name}")
            asc.patch("appStoreVersions", version["id"], {"versionString": name})
    else:
        print(f"Creating App Store version {name}")
        version = asc.post("appStoreVersions", {"platform": "IOS", "versionString": name},
                           {"app": rel("apps", app)})
    asc.call("PATCH", f"/v1/appStoreVersions/{version['id']}/relationships/build",
             body={"data": {"type": "builds", "id": build["id"]}})
    print(f"App Store version {name} ({version['id']}) now uses build {release}")

    for loc in asc.get(f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations")["data"]:
        current = loc["attributes"].get("whatsNew")
        if whats_new and current != whats_new or not current:
            if not whats_new:
                raise RuntimeError(f"What's New is empty for {loc['attributes']['locale']}; pass --whats-new")
            asc.patch("appStoreVersionLocalizations", loc["id"], {"whatsNew": whats_new})
            print(f"Set What's New for {loc['attributes']['locale']}")

    drafts = [s for s in submissions(asc, app) if s["attributes"]["state"] == "READY_FOR_REVIEW"]
    submission = drafts[0] if drafts else asc.post("reviewSubmissions", {"platform": "IOS"},
                                                   {"app": rel("apps", app)})
    if version["id"] not in submission_versions(asc, submission["id"]):
        asc.post("reviewSubmissionItems", relationships={
            "reviewSubmission": rel("reviewSubmissions", submission["id"]),
            "appStoreVersion": rel("appStoreVersions", version["id"])})
    asc.patch("reviewSubmissions", submission["id"], {"submitted": True})
    print(f"Submitted FamChat {name} ({number}) for App Store review: review submission {submission['id']}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["status", "submit"])
    p.add_argument("bundle_id")
    p.add_argument("release", nargs="?")
    p.add_argument("--whats-new")
    p.add_argument("--replace-waiting", action="store_true")
    p.add_argument("--wait", type=int, default=0, metavar="MINUTES")
    args = p.parse_args()
    try:
        asc = Asc()
        app = app_id(asc, args.bundle_id)
        if args.command == "status":
            status(asc, app)
        else:
            if not args.release:
                p.error("submit needs NAME+NUMBER")
            submit(asc, app, args.release, args.whats_new, args.replace_waiting, args.wait)
            status(asc, app)
    except Exception as e:  # noqa: BLE001 - report any failure plainly
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
