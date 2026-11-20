#!/usr/bin/env python3
"""Check that the store listing a release uploads to exists, without third-party packages.

  store-check.py appstore <bundle-id>   env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID
  store-check.py play <package-name>    env: PLAY_SERVICE_ACCOUNT_JSON (the key file's text)

Prints "exists" or "missing: <reason>" and exits 0 either way; exits 1 when the check itself
fails (bad credentials, network). Signs the JWTs with the openssl CLI. Never prints keys.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign(key_pem_path: str, message: bytes) -> bytes:
    return subprocess.run(["openssl", "dgst", "-sha256", "-sign", key_pem_path],
                          input=message, capture_output=True, check=True).stdout


def der_ecdsa_to_raw(der: bytes) -> bytes:
    """ES256 JWTs carry r||s (32 bytes each); openssl emits an ASN.1 DER sequence."""
    i = 3 if der[1] & 0x80 else 2
    out = b""
    for _ in range(2):
        assert der[i] == 0x02
        n = der[i + 1]
        out += der[i + 2:i + 2 + n].lstrip(b"\0").rjust(32, b"\0")
        i += 2 + n
    return out


def http(req: urllib.request.Request) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, {"raw": body.decode(errors="replace")[:300]}


def appstore(bundle_id: str) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "ES256", "kid": os.environ["ASC_KEY_ID"], "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 600,
                                "aud": "appstoreconnect-v1"}).encode())
    sig = der_ecdsa_to_raw(sign(os.environ["ASC_KEY_PATH"], f"{header}.{claims}".encode()))
    query = urllib.parse.urlencode({"filter[bundleId]": bundle_id, "fields[apps]": "bundleId"})
    status, body = http(urllib.request.Request(
        f"https://api.appstoreconnect.apple.com/v1/apps?{query}",
        headers={"Authorization": f"Bearer {header}.{claims}.{b64url(sig)}"}))
    if status != 200:
        raise RuntimeError(f"App Store Connect API returned {status}: {json.dumps(body)[:300]}")
    if any(app["attributes"]["bundleId"] == bundle_id for app in body.get("data", [])):
        return "exists"
    return f"missing: no App Store Connect app has bundle id {bundle_id}"


def play(package: str) -> str:
    account = json.loads(os.environ["PLAY_SERVICE_ACCOUNT_JSON"])
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": account["client_email"], "iat": now, "exp": now + 600,
                                "scope": "https://www.googleapis.com/auth/androidpublisher",
                                "aud": "https://oauth2.googleapis.com/token"}).encode())
    with tempfile.NamedTemporaryFile("w", suffix=".pem") as key:
        os.chmod(key.name, 0o600)
        key.write(account["private_key"])
        key.flush()
        sig = sign(key.name, f"{header}.{claims}".encode())
    status, token = http(urllib.request.Request(
        "https://oauth2.googleapis.com/token", method="POST",
        data=urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                     "assertion": f"{header}.{claims}.{b64url(sig)}"}).encode()))
    if status != 200:
        raise RuntimeError(f"Google token exchange returned {status}")
    auth = {"Authorization": f"Bearer {token['access_token']}"}
    base = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/edits"
    status, edit = http(urllib.request.Request(base, method="POST", headers=auth))
    if status == 200:
        http(urllib.request.Request(f"{base}/{edit['id']}", method="DELETE", headers=auth))
        return "exists"
    message = edit.get("error", {}).get("message", "")
    if status in (403, 404):
        # Play answers "Package not found" both before the first bundle is uploaded by hand in
        # Play Console and when the service account hasn't been given access to the app.
        return f"missing: {message}"
    raise RuntimeError(f"Play API returned {status}: {message}")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("appstore", "play"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(appstore(sys.argv[2]) if sys.argv[1] == "appstore" else play(sys.argv[2]))
    except Exception as e:  # noqa: BLE001 - report any failure as a failed check
        print(f"check failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
