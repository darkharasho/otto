#!/usr/bin/env bash
# Prints the version the App Store has live for <bundle-id> (e.g. 1.0.17), from Apple's public
# iTunes lookup; prints nothing (exit 0) when the app isn't live. No credentials needed.
#
# Usage: store-live-version.sh <bundle-id> [country]   (country default: us)
set -euo pipefail
bundle="${1:?bundle id}" country="${2:-us}"
curl -fsS "https://itunes.apple.com/lookup?bundleId=$bundle&country=$country" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print(r[0]["version"] if r else "")'
