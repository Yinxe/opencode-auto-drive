# Changelog

## 1.0.0 (2026-05-28)

Initial stable release.

### Features
- 5 modes: 停止 / 自定义 / AI 驱动 / 预设 / 序列
- 3-tier config merge: 全局 → 项目 → 插件选项
- Auto-drive after each AI response (`session.idle`)
- Per-session turn limit tracking
- Sequence mode (multi-prompt loop with modulo wrap)
- Status bar display with mode, turn, and step info
- Toast notifications for progress, errors, and warnings
- `/auto-drive` menu, `/auto-drive-config` viewer, `Ctrl+Alt+A` toggle
- Config validation on load with error toasts

### Bug Fixes
- Session ID signal hijacking fix (status bar flickering)
- Stale cleanup race condition fix
- Turn counter bump signal fix (SolidJS reactivity)
- Inner retry loop for transient network errors
- Toast ordering (after prompt send, not before)
- Save config patch-merge (preserves unknown fields)
- Mode name collision guard
- Progress bar step numbering off-by-one

### Testing
- 78 tests across 4 test files
- Unit tests for pure functions
- Integration tests for autoDrive, quickToggle, commitMode, fireImmediate
- Config validation tests (maxTurns, name collisions, readJSON)
- Shared mock API infrastructure for integration tests
