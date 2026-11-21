#!/usr/bin/env bash
# Checks that nothing native changed in the Expo app since a native release, so an EAS Update
# (JS and assets only) is safe to send to it. An update can't add or change native code: that
# needs a native release (a v* tag).
#
# Usage: expo-native-check.sh <ios|android> <NAME+NUMBER> [--app-dir otto-mobile] [--tag-prefix native]
#
# Compares HEAD with the native release's tag <prefix>/<platform>/<NAME+NUMBER>:
#   - native packages, by locked version in package-lock.json: expo, expo-*, react-native,
#     react-native-*, @react-native-*/* (direct and transitive);
#   - the app config's plugins and the platform's section (app.json: expo.plugins, expo.<platform>);
#   - files: <app-dir>/plugins/ (local config plugins), <app-dir>/app.config.js and
#     <app-dir>/<platform>/ (if the native project is ever committed).
# Run from anywhere in the repo; needs the tag locally or on origin.
set -euo pipefail
platform="" release="" app=otto-mobile prefix=native
while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) app="$2"; shift 2 ;;
    --tag-prefix) prefix="$2"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$platform" ]; then platform="$1"; else release="$1"; fi; shift ;;
  esac
done
[[ "$platform" =~ ^(ios|android)$ ]] || { echo "platform must be ios or android" >&2; exit 2; }
[[ "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$ ]] || { echo "release must be NAME+NUMBER" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"
tag="$prefix/$platform/$release"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null \
  || git fetch -q origin "refs/tags/$tag:refs/tags/$tag" 2>/dev/null \
  || { echo "::error::No tag $tag: $release isn't a shipped native release." >&2; exit 1; }

# Native packages with their locked versions.
packages() {
  python3 -c '
import json, re, sys
lock = json.load(sys.stdin)
pat = re.compile(r"^(expo|expo-.+|react-native|react-native-.+|@react-native-[^/]+/.+)$")
out = {}
for path, info in lock.get("packages", {}).items():
    if path.startswith("node_modules/") and "/node_modules/" not in path:
        name = path[len("node_modules/"):]
        if pat.match(name):
            out[name] = info.get("version")
print(json.dumps(dict(sorted(out.items())), indent=1))'
}
# The app config's plugins and native sections.
config() {
  python3 -c '
import json, sys
expo = json.load(sys.stdin).get("expo", {})
print(json.dumps({k: expo.get(k) for k in ("plugins", sys.argv[1])}, indent=1, sort_keys=True))' "$platform"
}

failed=false
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if ! diff -u <(git show "$tag:$app/package-lock.json" | packages) <(packages < "$app/package-lock.json") \
    > "$tmp/packages.diff"; then
  echo "::error::Native packages changed since $tag; ship a native release instead." >&2
  cat "$tmp/packages.diff" >&2; failed=true
fi
if ! diff -u <(git show "$tag:$app/app.json" | config) <(config < "$app/app.json") > "$tmp/config.diff"; then
  echo "::error::App config plugins or the $platform section changed since $tag; ship a native release instead." >&2
  cat "$tmp/config.diff" >&2; failed=true
fi
paths=("$app/plugins" "$app/app.config.js" "$app/$platform")
if ! git diff --quiet "$tag" HEAD -- "${paths[@]}"; then
  echo "::error::Native files changed since $tag (${paths[*]}); ship a native release instead." >&2
  git diff --stat "$tag" HEAD -- "${paths[@]}" >&2; failed=true
fi
$failed && exit 1
echo "No native changes since $tag."
