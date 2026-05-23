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
