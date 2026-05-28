import { vi } from "vitest"

/**
 * Create a mock OpenCode API object for integration testing.
 * Sessions stored in a mutable Map — use _addSession to populate.
 * Dispose callbacks captured in __disposeCallbacks.
 */
export function createMockApi(overrides = {}) {
  const disposeCallbacks = []
  const sessions = new Map()

  const api = {
    state: {
      path: { directory: "/tmp/test-session" },
      session: { get: vi.fn((sid) => sessions.get(sid) ?? null) },
    },
    route: {
      current: { name: "session", params: { sessionID: "test-session-1" } },
    },
    client: {
      session: { prompt: vi.fn().mockResolvedValue(undefined) },
    },
    ui: {
      toast: vi.fn(),
      DialogSelect: () => null,
      DialogPrompt: () => null,
      dialog: {
        setSize: vi.fn(),
        replace: vi.fn(),
        clear: vi.fn(),
      },
    },
    command: {
      register: vi.fn().mockReturnValue(() => {}),
    },
    event: {
      on: vi.fn().mockReturnValue(() => {}),
    },
    slots: {
      register: vi.fn(),
    },
    lifecycle: {
      onDispose: vi.fn((cb) => disposeCallbacks.push(cb)),
    },
    _addSession(sid, data = {}) {
      sessions.set(sid, { id: sid, ...data })
    },
    _cleanup() {
      disposeCallbacks.forEach((cb) => { try { cb() } catch {} })
    },
    __disposeCallbacks: disposeCallbacks,
  }

  return Object.assign(api, overrides)
}
