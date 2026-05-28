Version v0.8.6

Fixes:
- **Pasting an image duplicated the message.** The renderer's optimistic user bubble carries the pasted/dropped `image-ref` blocks alongside the text, but the dedupe heuristic for the backend's `user-message` event only matched messages with a single text block — so the backend's copy (with a different `messageId`) was appended a second time. Dedupe now compares just the text portion, ignoring attachment blocks.

Version v0.8.5

Fixes:
- **`UNIQUE constraint failed: messages.id` mid-turn.** Late stream events arriving after an assistant message was already finalized would rebuild a fresh placeholder row and trigger a second `INSERT` with the same id, surfacing the SQLite error in the conversation. The session consumer now drops events for already-finalized ids, and `Repo.appendMessage` is idempotent on duplicate ids (preserves the original `seq`, updates content in place) as defense-in-depth.

Version v0.8.4

Features:
- **Manual new conversation.** Type `/n ` (slash-n-space) in the input to drop the current conversation and collapse to a clean bar — type your fresh prompt and hit Enter to send it into a brand-new session. Same effect with `Cmd/Ctrl+Shift+N` from anywhere in the Otto window.
- **Idle-timeout new conversations.** After a configurable period with no activity from you or Otto (default 60 minutes; Settings → Behavior → New conversations), the next message you submit automatically starts a fresh conversation. Set the timeout to `0` to disable. Long-running watch/observation tools reset the timer, so monitoring sessions don't get cut off.
- **Topic-shift suggestion.** When you come back after 5+ minutes of being away and ask something unrelated to what you were discussing, Otto suggests starting a new conversation via a non-blocking chip above the input. Two clicks: "Start new conversation" (cuts cleanly to a fresh session with your message as the first prompt) or "Keep going" (sends your message to the current session). Never auto-switches. Uses local embedding similarity — no extra API calls.

Fixes (during smoke-testing):
- **Stuck "thinking" + "1 queued" after `/n`.** Two races: `user-message-queued` was emitted after `enqueue` and could lose to a fast-pump `user-message-consumed`, leaving the renderer's queueDepth stuck at 1; and `session.interrupt` left the old SDK subprocess holding resources, so a new session couldn't make progress. Both fixed (queued now emits before enqueue with predicted depth; new `session.close` IPC fully tears down the old subprocess on `/n`).
- **Old-session stragglers no longer hijack a fresh conversation.** Auto-attach used to yank `activeSession` back when late events arrived for the abandoned session. Renderer now tracks abandoned session ids and drops their events.
- **Renderer is authoritative on `session.ensureForSubmit`.** Main no longer falls back to its stale `activeSessionId` when the renderer says "no current session" — fixes messages disappearing into the abandoned session after `/n`.

Version v0.8.2

Fixes:
- **Republish of v0.8.1.** The v0.8.1 release-artifact build failed lint (two `no-useless-catch` errors in the new SDK stream code) so no installers were produced. Lint is clean again on v0.8.2; same feature set as v0.8.1.

Version v0.8.1

Features:
- **Submit messages while Otto is still responding.** The CommandBar (desktop) and the mobile chat input no longer disable while a turn is in flight. Additional submits queue and run as follow-up turns; a "N queued" chip shows when something is waiting. On desktop, **Shift+Enter while busy** interrupts the current turn and sends your new message immediately.
- **Stop button now uses soft interrupt.** Hitting Stop ends just the current turn instead of killing the whole session subprocess, so queued messages keep flowing afterwards. Available on desktop and mobile.

Under the hood:
- **One long-lived Claude Code session per Otto session.** SDK turns are no longer per-`query()` — a single streaming-input `query()` is kept open and drains an in-memory user-message queue. MCP server is rebuilt per enqueued message via `Query.setMcpServers` so each turn's tool closures still capture a fresh `messageId`.

Fixes:
- **Interrupted tool calls no longer spin forever.** When you Stop mid-tool, any in-flight tool cards now resolve to a synthetic "Interrupted by user" error result instead of staying in the running state indefinitely.
- **Thinking dots persist between tool calls.** The typing animation used to disappear after Otto produced any text and never came back; it now keeps animating during the gaps between tool calls while the model is generating its next block.

Version v0.8.0

Features:
- **Attach images to your messages.** Paste, drag-and-drop, or click the paperclip on desktop to attach PNG/JPEG/WebP/GIF; on mobile, tap the paperclip to pick from camera or library, or paste from the clipboard. Multiple images per message; chips appear inline next to the input with a one-click remove. Image-only messages (no text) are allowed.
- **Mobile attachments survive reconnect.** A new bridge `GET /user-upload` endpoint serves user-attached images over the same auth as `/history`, so previously-sent images on the phone render after a refresh or reconnect instead of vanishing.

Fixes:
- **~20 GB RAM leak in long screenshot sessions.** Screenshots are now referenced by id everywhere except at the API boundary, instead of being inlined as base64 in every layer (renderer store, SessionBus ring, and persisted messages all carried duplicate copies). A vitest memory probe verifies that 50 screenshot tool results now add < 1 MB of retained renderer memory (was +227 MB pre-fix).
- **Process registry no longer holds onto exited processes forever.** Entries are evicted 5 minutes after exit instead of accumulating up to 4 MB of stdout buffer each for the lifetime of the app.
- **SessionBus ring caps by bytes** (8 MB per session) in addition to event count, so a burst of large events can't pin memory.
- **Tile-aware screenshot rendering.** Screenshots wider than 1920 px are tiled for the API; the renderer now correctly resolves the on-disk file for all tiles instead of showing a broken image.
- **Startup orphan sweep** deletes per-session screenshot and user-upload directories that no longer correspond to a live session, and "Reset all sessions" wipes both roots.
- **Bridge attachment staging gets a 10-minute TTL sweep** to prevent in-memory leak when a phone uploads but never sends a prompt.

Version v0.7.1

Features:
- **Pick which display Otto opens on.** New Settings → General → Window option: *Follow cursor* (default, current behavior) or *Primary display*. If you summon Otto with the hotkey and it lands on the wrong monitor, set this to "Primary display" to pin it.
- **Cycle Otto between monitors with `Ctrl+Shift+←`/`Ctrl+Shift+→`.** Runtime override while Otto is open — useful when you want to move it without changing the persistent setting.

Fixes:
- **Native darwin_shortcut addon now bundles in prod builds** so the macOS global hotkey works in packaged builds, not just dev.
- **Stream drain timeout in the shell executor** prevents the test suite from hanging on CI.
- **Lint cleanup in the darwin platform files.**

Version v0.7.0

Features:
- **macOS support.** Otto now runs natively on macOS with a full platform adapter — screenshots via `screencapture`, input via CoreGraphics/AppleScript, window geometry via System Events, and shell via zsh. Works on macOS 26 Tahoe.
- **Native global hotkey on macOS.** A custom Obj-C++ Node addon uses CGEvent taps for reliable global hotkey registration, bypassing Electron's broken Carbon-based `globalShortcut` on macOS 26. Prod: `Ctrl+Shift+Space`. Dev: `Ctrl+Shift+Cmd+Space`. Requires Accessibility + Input Monitoring permissions.
- **Smarter reflection.** The learning system now errs on the side of saving rather than skipping. Platform mismatches, tool corrections, and course changes are explicitly flagged as high-value learnings. Long back-and-forth sessions now trigger mid-conversation reflection instead of waiting for idle timeout.

Fixes:
- **Shell executor race condition.** On macOS, `child.exited` resolves before stdout data events fire. Now waits for stream `end` events before returning output.
- **Frameless window shadow artifacts on macOS.** Disabled native shadow on transparent frameless windows to prevent dark border rendering.
- **Tray icon too large on macOS.** Resized to 16×16 pt to match macOS menu bar expectations.
- **Linux-only Ozone/Wayland switches no longer applied on macOS.**

Version v0.6.0

Features:
- **Otto can inline images in its responses.** When a visual genuinely helps — a screenshot from a game wiki, an in-game map, a diagram pulled from a guide — Otto can now emit `![alt](url)` in its prose and the image renders inline on desktop chat and the mobile remote. The system prompt nudges Otto to use this only when it materially helps (never decorative) and only with URLs that came from a real `WebSearch`/`WebFetch` result, not invented ones.
- **Local image cache with privacy + SSRF guards.** Every image is downloaded once in the main process, validated (image content-type, ≤5 MB, no SVG, no loopback / RFC1918 / link-local / CGNAT hosts), and cached under `userData/image-cache/`. The renderer points at the cache via a new `otto-img://` Electron scheme on desktop and a token-authed `/image` endpoint on the bridge for the mobile PWA. Third-party hosts never see your IP; cache hits are instant on subsequent renders.
- **Overlay feed renders image alt text only.** The two-line ticker would have its layout blown out by an inline image, so it falls back to a muted `[alt text]` placeholder so you can still tell Otto cited a visual.

Version v0.5.7

UI polish:
- **Mobile remote: home-screen icon now has proper safe-area padding.** The PWA / apple-touch-icon was a 256×256 PNG with the Otto mark touching every edge and a transparent background, so iOS slammed it against its rounded mask with no breathing room. Regenerated at 512×512 with the mark inset ~12% on Otto's `#0d0d0e` surface — matches Apple HIG safe-area guidance and renders crisply on retina home screens. Re-add to home screen to pick up the new icon.
- **Icon pipeline extended.** `scripts/generate-app-icons.mjs` now emits the padded PWA icon alongside the existing app/README outputs, so future regenerations stay in sync.

Version v0.5.6

(Withdrawn — the "padding" tweak in this release targeted the wrong icon. See v0.5.7 for the actual home-screen icon fix.)

Version v0.5.5

Memory:
- **`mark_task_complete` no longer surfaces in the chat.** That tool just kicks off a background reflection pass — its "noted" reply was misleading, suggesting memory had been written even when the reflector skipped the session. It's now hidden from the renderer entirely.
- **Reflection saves show up as a "Memory updated" tool card.** When the reflector actually writes facts/playbooks/anti-patterns/heuristics, you get a brain-icon card with a one-line count summary ("2 playbooks, 1 fact"); expand it for the full breakdown. No card means nothing was saved — matching reality.
- **Reflector prompt broadened so it stops skipping real lessons.** Named-context facts about apps/games/services the user uses ("user plays Librarian: Tidy Up") are now valid priors, and playbooks explicitly cover any reusable recipe — apps, games, external services — anchored with a narrow, well-tagged example so the bar stays specific.

Version v0.5.4

Bug fixes:
- **Mobile remote: thinking indicator anchors to the bottom during tool calls.** Previously the typing dots stayed glued to the assistant text bubble *above* the tool card, so once Otto started running tools the animation looked stuck mid-transcript. Now the in-flight text bubble closes when a tool starts and a bottom-anchored indicator takes over until the next text-delta arrives.

Version v0.5.3

Bug fixes:
- **Mobile remote: home-screen icon is now the Otto purple mark.** iOS Add-to-Home-Screen and Android PWA installs were falling back to a page screenshot because no `apple-touch-icon` or manifest `icons` entry was set. Both are wired up now.

Version v0.5.2

UI polish:
- **Tool call cards are friendlier on every surface.** MCP names like `mcp__github__create_pull_request` now render as "GitHub · Create Pull Request" with an icon and a one-line param summary; results render as inline images (including base64 data URLs from MCP screenshot tools), terminal-style stdout with exit code, key/value tables, markdown, or red error boxes — replacing the raw JSON blobs everywhere. The same humanization flows through the desktop chat, the mobile remote, and the unfocused overlay feed.
- **Overlay feed renders markdown.** Streaming assistant text in the unfocused HUD now respects bold, italic, inline code, and links instead of showing literal markdown syntax. Each row still clamps to two lines.
- **Mobile remote: emoji render as line-icon SVGs.** Same shim the desktop renderer already uses — Lucide for the common ones (✅ 💡 🔧 🚀), Fluent Emoji High Contrast for everything else, all painted in the accent color so they read as one coherent set.

Bug fixes:
- **Mobile remote: iOS PWA chrome respects safe-area insets.** The status bar no longer collides with the header in black-translucent mode, and the input no longer sits on a tall grey strip above the home indicator.
- **Mobile remote: surface a banner when the bridge can't be reached.** After ~7s of failed WebSocket reconnects, the chat screen shows an amber notice naming the host being attempted and a one-line hint about Tailscale / re-pairing — instead of silently looping forever.

Version v0.5.1

Bug fixes:
- **Mobile remote: Add-to-Home-Screen no longer un-pairs the device.** iOS gives home-screen PWAs an isolated storage container, so Safari's localStorage didn't carry over. The bearer token now rides in the URL after pairing, so the launch URL captured by Add-to-Home-Screen hydrates the PWA's own storage on first launch. A small dismissible banner nudges iOS users to install before relying on persistence.

Version v0.5.0

New features:
- **iPhone remote.** Pair an iPhone via QR code over Tailscale. The phone becomes a second client to the same Otto session — full chat with streaming events, first-resolver-wins approvals, screenshot thumbs, markdown rendering, collapsible tool cards, session history drawer, and reconnect with history backfill. Remote-originated turns can be clamped to a stricter autonomy mode than the desktop is running. Bridge binds only to the tailnet IP; no public exposure. Settings → General → "iPhone remote" to enable + pair.

Version v0.3.0

New features:
- **Memory & learning loop.** When a task finishes, Otto silently reflects on the transcript and saves what it learned for future sessions. Four kinds of artifact: short facts in the existing per-machine `knowledge.md`, plus *playbooks* (named procedures), *anti-patterns* (failure modes to avoid), and *heuristics* (meta-rules about Otto's own tools) in a new SQLite FTS5 store. A new `recall` tool lets Otto search past learnings at the start of a task. Reflection runs ~90s after the last assistant turn or when Otto calls `mark_task_complete`. A subtle one-line note in the conversation announces what was saved (e.g., `2 playbooks, 1 fact created/updated`).
- **Memory browser in Settings.** New Memory tab lists facts, playbooks, anti-patterns, and heuristics with full-text search, edit modal, archive, and delete. The knowledge file is editable from the same panel.
- **Wayland-native mouse + keyboard input via the XDG Desktop Portal.** Otto can now control native Wayland windows for the first time — clicks, drags, scrolls, typing, and key combos all flow through `org.freedesktop.portal.RemoteDesktop`. One KDE permission dialog on first use; the grant persists across launches. xdotool (which only worked on XWayland surfaces) is no longer used for input.
- **Screenshot tiling for wide monitors.** Captures larger than the Anthropic 2000-pixel per-edge cap split into a row-major grid of native-resolution tiles, each carrying its virtual-desktop offset so click coords stay accurate. 3440×1440 and dual-monitor setups no longer lose detail to downscaling.
- **Cursor visible in screenshots.** Spectacle now captures the pointer (`-p`), so Otto can see where its previous click landed and self-correct on the next attempt.

UI refresh:
- **Settings window redesigned.** Wider (780px), top tabs (General · Behavior · Memory · About), left sidebar of subsections within each tab, real heading-style page header per subsection. Stacked toggles get subtle row dividers. Type sizes bumped to give the heading hierarchy actual hierarchy.

Behind the scenes:
- **Platform adapter is now a singleton** so per-instance state (like the portal session and tracked cursor position) survives across the many call sites that ask for an adapter.
- **Reflector logs its raw output on schema failures** to help iterate on the prompt.

Version v0.2.4

Bug fixes:
- **Reopening Otto after a finished turn no longer briefly replays the "working" state.** Chromium throttles renderers in hidden windows, so session events queued up and flushed on show — replaying the streaming state for a beat before settling on the final response. The main window now keeps its renderer ticking at full speed even while hidden.

Version v0.2.3

New:
- **Tray badge for finished turns.** When a turn finishes while the Otto window is hidden, the tray icon gains a small amber dot so you can see at a glance that something's waiting. The badge clears the moment you show Otto again. Dev builds use a red dot (the dev icon is already amber).

Version v0.2.2

Bug fixes:
- **Live activity overlay header no longer clips off the top.** The overlay's outer flexbox was bottom-aligned, so when the step list grew taller than the window the whole card slid upward and the "Otto is working" header was pushed offscreen. The card now fills the window from top to bottom.

Version v0.2.1

Bug fixes:
- **`otto toggle` no longer spawns duplicate processes from packaged builds.** In packaged Electron, `process.argv` has no script path, so the `toggle` positional arg was being dropped and Otto fell through to launching a new instance for every keypress.
- **Single-instance lock**: double-clicking the AppImage / .desktop entry now focuses the existing Otto via a toggle instead of spawning a second copy. Dev and prod instances stay independent.

Version v0.2.0

New features:
- **Live activity overlay** — when Otto is autonomously controlling your computer with the main window hidden, a small frameless overlay appears in the bottom-right showing a live feed of Otto's reasoning and each tool call (clicks, typing, screenshots, shell commands). Click-through, theme-matched, and auto-hides when the main window comes back.
- **Per-window screenshots** — Otto can now capture just a single window (resolved via kdotool) instead of the full multi-monitor desktop, making iteration on a known target much faster.
- **Persistent knowledge file** — Otto now keeps a per-machine markdown file (`knowledge.md`) of durable facts and preferences it has learned (e.g., "browser of choice is Zen"). It's read into the system prompt at the start of every turn, so memory carries across sessions.

Input + screen fixes:
- **Switched from ydotool to xdotool** on Linux. KDE Plasma 6 Wayland filters synthetic keyboard events from uinput devices, so ydotool's keystrokes silently dropped. xdotool drives input through XWayland's XTEST extension, which works for any app running under XWayland (the vast majority). One-time KDE permission prompt on first use.
- **Otto's own window is excluded from captures** so screenshots no longer leak the chat panel back to the model.

Notification fix:
- The turn-complete notification preview no longer shows Otto's opening "I'll help you…" monologue. The text accumulator now resets on each tool call, so the preview reflects the final summary.

Dev / desktop polish:
- Dev builds now have a distinct amber icon and a "DEV" pill, and use a separate userData directory so the dev build can't clobber the installed prod build's settings/sessions.
- Dev and prod use separate global hotkey chords by default so they don't fight on X11.
- Linux autostart now writes a proper XDG `.desktop` file.
- External links in the chat open in your default browser instead of inside Otto.
- New **Keyboard shortcut** settings page surfaces the recommended chord and links to your DE's keyboard settings.

Version v0.1.3

New settings:
- **Hide when clicked away** — new toggle under Window settings. Off by default (matches today's pinned behavior). When on, clicking outside Otto hides it like a popover.

Version v0.1.2

UI polish:
- Assistant messages now show an "Otto" heading with the brand mark, breaking up consecutive responses and giving the AI's voice an explicit identity.
- Hotkey is now a strict show/hide toggle — each press inverts visibility regardless of focus state, fixing the "needed to press twice" feel.
- The entrance animation no longer replays when Otto regains focus from a click-out; it only fires when the window is actually shown (hotkey, tray, toggle).

Version v0.1.1

Bug fixes:
- Packaged app now correctly spawns the Claude Agent SDK from the asar-unpacked cli.js using Electron-as-Node, fixing "Claude Code exited with code 1" on AppImage/dmg/nsis builds.
- Settings window now surfaces IPC errors instead of hanging on a perpetual "Loading…" state.
- macOS build matrix now produces both Intel (x64) and Apple Silicon (arm64) artifacts (v0.1.0 shipped arm64 only).

Version v0.1.0

First public release of Otto.

Highlights:
- Global-hotkey command bar with computer-use, shell, and web tools
- Three autonomy modes with per-tool action classes (read / reversible / destructive / irreversible)
- Plan-step confirmations + hard denylist for catastrophic commands
- Per-machine markdown knowledge file that accumulates learned quirks across sessions
- Cross-platform builds (Linux AppImage + deb, Windows NSIS, macOS DMG + ZIP signed and notarized)
- System notifications for approvals and turn-complete
- In-app auto-update via GitHub Releases
