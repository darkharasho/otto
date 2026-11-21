#!/usr/bin/env bash
# Prints, one per line, the native releases an over-the-air update should reach on <platform>:
# the newest one that reached TestFlight / Play and, on iOS when <bundle-id> is given and older,
# the newest build of the version the App Store has live. So App Store installs keep getting
# updates while a newer version waits for review.
#
# Native releases are tags <prefix>/<platform>/<NAME+NUMBER>, pushed by the release workflow once
# a build reaches the store (never for dry runs or failed uploads). NUMBER only grows.
#
# Usage: native-release-targets.sh <ios|android> [bundle-id] [tag-prefix]  (prefix default: native)
# Needs a git remote named origin.
set -euo pipefail
platform="${1:?ios|android}" bundle="${2:-}" prefix="${3:-native}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tags="$(git ls-remote --tags origin "refs/tags/$prefix/$platform/*" \
  | sed -nE "s#^.*refs/tags/$prefix/$platform/([0-9]+\.[0-9]+\.[0-9]+\+[0-9]+)\$#\1#p" | sort -t+ -k2,2n)"
[ -n "$tags" ] || { echo "::error::No $prefix/$platform/* tag: no native $platform release has shipped." >&2; exit 1; }
newest="$(tail -1 <<<"$tags")"
echo "$newest"
if [ "$platform" = ios ] && [ -n "$bundle" ]; then
  live="$("$here/store-live-version.sh" "$bundle" || true)"
  if [ -z "$live" ]; then
    echo "::notice::The App Store has no live version of $bundle." >&2
  else
    store="$(grep -E "^${live//./\\.}\+" <<<"$tags" | tail -1 || true)"
    if [ -z "$store" ]; then echo "::warning::No $prefix/ios tag for App Store version $live." >&2
    elif [ "$store" != "$newest" ]; then echo "$store"; fi
  fi
fi
