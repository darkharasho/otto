Unreleased

New features:
- **iPhone remote.** Pair an iPhone via QR code over Tailscale. The phone becomes a second client to the same Otto session — full chat with streaming events, first-resolver-wins approvals, screenshot thumbs, and reconnect with history backfill. Remote-originated turns can be clamped to a stricter autonomy mode than the desktop is running. Bridge binds only to the tailnet IP; no public exposure.

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
