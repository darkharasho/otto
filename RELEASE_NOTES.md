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
