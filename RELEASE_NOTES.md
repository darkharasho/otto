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
