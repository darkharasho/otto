# iPhone Remote — Manual Smoke Checklist

Run before each release that includes iPhone remote changes.

## Prerequisites
- [ ] Tailscale installed and running on both the desktop and the iPhone.
- [ ] Both devices on the same tailnet.

## Desktop setup
- [ ] Open Settings → General → iPhone remote.
- [ ] Toggle "Enable Remote access" ON.
- [ ] Status row shows `Listening on http://100.x.y.z:NNNN` within ~2s.
- [ ] If Tailscale is stopped, status updates within ~60s to "Tailscale not detected".

## Pairing
- [ ] Click "Pair new device" → QR code modal appears with countdown.
- [ ] Scan QR with iPhone camera → Safari opens the PWA URL with `?code=...`.
- [ ] Tap "Pair this device" → device appears in the paired list within 3s.
- [ ] Tap "Add to Home Screen" in Safari share sheet → icon appears on home screen.
- [ ] Force-quit Safari and re-open from home-screen icon → lands directly on chat, no re-pair.

## Chat
- [ ] Send a prompt from the phone → user bubble appears immediately.
- [ ] Assistant response streams in (text appears character-by-character or word-by-word).
- [ ] Tool calls render as cards with input + result.
- [ ] If Otto captures a screenshot, a thumb appears inline.
- [ ] Tap a screenshot thumb → full-size modal opens.
- [ ] Send a prompt from the DESKTOP while phone is connected → phone receives the same streamed events.

## Approvals
- [ ] Configure desktop autonomy mode = `strict`, send a prompt that triggers a `reversible` tool call.
- [ ] Approval card appears on BOTH desktop and phone simultaneously.
- [ ] Tap "Approve" on phone → card dismisses on both within ~1s.
- [ ] Repeat with "Deny" from desktop → phone's card dismisses with "(denied on desktop)" hint.

## Remote-ceiling clamp
- [ ] Set desktop autonomy = `full-allow`, remote ceiling = `Force strict`.
- [ ] Send a prompt from the PHONE that triggers a `reversible` call → approval card appears (would not have under `full-allow` if origin were desktop).
- [ ] Send the same prompt from DESKTOP → no approval card (full-allow allows reversible).

## Reconnect
- [ ] Mid-conversation, put phone in airplane mode for 30s → exit airplane mode.
- [ ] PWA reconnects automatically; transcript backfills with events missed during the disconnect.
- [ ] If the disconnect is long (> ring buffer of 200 events), the PWA shows "Earlier events not available, scroll desktop transcript for full history".

## Revoke
- [ ] In Settings → iPhone remote, click Revoke on the paired device.
- [ ] Within ~1s, the phone's PWA fails its next ping and shows an error.
- [ ] Phone cannot re-connect without re-pairing.

## Network isolation
- [ ] Turn Wi-Fi off on the phone, use only cellular → PWA still connects via tailnet relay.
- [ ] Try connecting to the bridge URL from a non-tailnet device on the same LAN → connection refused (bridge bound to tailnet IP only).

## Known gaps (v1)
- Screenshot URLs are single-use; refreshing the modal re-fetches via the same URL through a cached object URL (works but limited).
- The bus does not yet auto-publish `screenshot-captured` events from the screenshot tool — screenshot thumbs only appear if the agent explicitly emits them. Tracked separately.
- No push notifications for backgrounded PWA — bring the PWA back to foreground to see new approval cards.
