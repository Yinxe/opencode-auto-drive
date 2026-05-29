import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import plugin from "../tui.jsx"
import { AI_GUIDE_PROMPT } from "../prompts.js"
import { createMockApi } from "./helpers/mock-api.js"

// ── Solid.js mock (host-provided, not in node_modules) ──
vi.mock("solid-js", () => {
  const stores = new Map()
  let uid = 0
  return {
    createSignal: (initial) => {
      const id = uid++
      stores.set(id, initial)
      return [
        () => stores.get(id),
        (next) => {
          stores.set(id, typeof next === "function" ? next(stores.get(id)) : next)
        },
      ]
    },
    Show: ({ when, fallback, children }) => (when ? children : fallback ?? null),
  }
})

// ── Config helper: create a mockApi + call tui with given config overrides ──

async function setupWithConfig(configOverrides = {}) {
  const api = createMockApi()
  await plugin.tui(api, configOverrides)
  return api
}

function makeEvent(sessionID = "test-session-1") {
  return { properties: { sessionID } }
}

// ── Tests ──

describe("autoDrive", () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    // Cleanup any intervals set up by tui()
    if (globalThis.__lastApi) {
      for (const cb of globalThis.__lastApi.__disposeCallbacks) cb()
    }
  })

  // ── 1. Normal flow ──
  it("sends prompt and increments turn counter for active mode", async () => {
    const api = await setupWithConfig({ mode: "ai", maxTurns: 5 })
    globalThis.__lastApi = api

    const result = await plugin.autoDrive(makeEvent())

    expect(result).toBe(true)
    expect(api.client.session.prompt).toHaveBeenCalledWith({
      sessionID: "test-session-1",
      parts: [{ type: "text", text: AI_GUIDE_PROMPT }],
    })
    // Turn counter incremented
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("1/5"),
    )
  })

  // ── 2. Stop mode ──
  it("returns null in stop mode without sending prompt", async () => {
    const api = await setupWithConfig({ mode: "stop" })
    globalThis.__lastApi = api

    const result = await plugin.autoDrive(makeEvent())

    expect(result).toBeNull()
    expect(api.client.session.prompt).not.toHaveBeenCalled()
  })

  // ── 3. Subtask session skip ──
  it("skips sessions that have a parentID (subtask)", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    globalThis.__lastApi = api
    api.state.session.get.mockReturnValue({
      parentID: "parent-xyz",
    })

    const result = await plugin.autoDrive(makeEvent("subtask-session"))

    expect(result).toBeNull()
    expect(api.client.session.prompt).not.toHaveBeenCalled()
  })

  // ── 4. Max turns reached ──
  it("stops after maxTurns is reached", async () => {
    const api = await setupWithConfig({ mode: "ai", maxTurns: 1 })
    globalThis.__lastApi = api

    const first = await plugin.autoDrive(makeEvent())
    expect(first).toBe(true)

    const second = await plugin.autoDrive(makeEvent())
    expect(second).toBeNull()
    // prompt should only have been called once
    expect(api.client.session.prompt).toHaveBeenCalledTimes(1)
  })

  // ── 6. Concurrent call protection ──
  it("rejects concurrent calls for the same session (pendingLocks)", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    globalThis.__lastApi = api

    let resolvePrompt
    api.client.session.prompt.mockReturnValue(
      new Promise((r) => { resolvePrompt = r }),
    )

    // Start first call (don't await)
    const firstPromise = plugin.autoDrive(makeEvent())

    // Second call with same sessionID should be blocked
    const secondResult = await plugin.autoDrive(makeEvent())
    expect(secondResult).toBeNull()

    // Resolve first call
    resolvePrompt()
    await firstPromise
  })

  // ── 7. API failure ──
  it("returns false when session.prompt rejects", async () => {
    vi.useRealTimers()
    const api = await setupWithConfig({ mode: "ai" })
    globalThis.__lastApi = api
    api.client.session.prompt.mockRejectedValue(
      new Error("API rate limit exceeded"),
    )

    const result = await plugin.autoDrive(makeEvent())

    expect(result).toBe(false)
    expect(console.error).toHaveBeenCalledWith(
      "[auto-drive] ❌",
      expect.stringContaining("API rate limit exceeded"),
    )
  })

  it("retries on transient error and succeeds on second attempt", async () => {
    vi.useRealTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    const api = await setupWithConfig({ mode: "ai" })
    globalThis.__lastApi = api
    // First call fails, second succeeds (inner retry handles this)
    api.client.session.prompt
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(undefined)

    const result = await plugin.autoDrive(makeEvent())

    expect(result).toBe(true)
    expect(api.client.session.prompt).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("⏳ prompt 重试 1/2"),
    )
  })

  // ── 8. Toast after successful prompt (2nd turn onward) ──
  it("fires toast from the second turn", async () => {
    const api = await setupWithConfig({ mode: "ai", maxTurns: 3 })
    globalThis.__lastApi = api

    // First call: no toast (current === 0)
    await plugin.autoDrive(makeEvent())
    expect(api.ui.toast).not.toHaveBeenCalled()

    // Second call: toast should fire (current === 1)
    await plugin.autoDrive(makeEvent())
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("第2轮"),
        variant: "info",
      }),
    )
  })

  // ── 10. Export verification (the mechanism works) ──
  it("exposes internal functions on plugin after tui() call", async () => {
    const api = createMockApi()
    await plugin.tui(api, {})

    expect(typeof plugin.autoDrive).toBe("function")
    expect(typeof plugin.quickToggle).toBe("function")
    expect(typeof plugin.fireImmediate).toBe("function")
    expect(typeof plugin.commitMode).toBe("function")
    // saveConfigFile was removed — not exported
    expect(plugin.saveConfigFile).toBeUndefined()
  })
})

// ── quickToggle ──

describe("quickToggle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("stops when currently active", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    plugin.quickToggle()
    // mode should now be "stop" — next autoDrive returns null
    const result = await plugin.autoDrive(makeEvent())
    expect(result).toBeNull()
  })

  it("restores lastMode when toggled back, firing immediate", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    plugin.quickToggle() // stop
    const result1 = await plugin.autoDrive(makeEvent())
    expect(result1).toBeNull()

    api.client.session.prompt.mockClear()
    plugin.quickToggle() // restore to ai — fires prompt via fireImmediate
    await vi.waitFor(() => {
      expect(api.client.session.prompt).toHaveBeenCalled()
    })
  })

  it("uses first preset when no lastMode exists", async () => {
    const api = await setupWithConfig({ mode: "stop", presets: { "继续优化": "优化" } })
    api.client.session.prompt.mockClear()
    plugin.quickToggle() // activates first preset + fires prompt
    await vi.waitFor(() => {
      expect(api.client.session.prompt).toHaveBeenCalled()
    })
  })

  it("does not crash when no lastMode and no presets", async () => {
    const api = await setupWithConfig({ mode: "stop", presets: {} })
    expect(() => plugin.quickToggle()).not.toThrow()
  })
})

// ── commitMode ──

describe("commitMode", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("sets mode and maxTurns, fires immediate", async () => {
    const api = await setupWithConfig({ mode: "stop" })
    api.client.session.prompt.mockClear()
    plugin.commitMode("ai", 10)
    await vi.waitFor(() => {
      expect(api.client.session.prompt).toHaveBeenCalled()
    })
  })

  it("shows warning toast for inactive mode (empty customPrompt)", async () => {
    const api = await setupWithConfig({ mode: "stop", customPrompt: "" })
    plugin.commitMode("custom", 3)
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" })
    )
  })
})

// ── fireImmediate ──

describe("fireImmediate", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("sends prompt for current route session", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    await plugin.fireImmediate()
    expect(api.client.session.prompt).toHaveBeenCalled()
  })

  it("does nothing when not on a session route", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    api.route.current = { name: "chat" }
    await plugin.fireImmediate()
    expect(api.client.session.prompt).not.toHaveBeenCalled()
  })
})

// ── showConfig ──

describe("showConfig", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("registers auto-drive-config command with slash alias", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    const cmds = api.command.register.mock.calls[0][0]()
    const configCmd = cmds.find((c) => c.value === "auto-drive-config")
    expect(configCmd).toBeTruthy()
    expect(configCmd.slash.name).toBe("auto-drive-config")
    expect(configCmd.slash.aliases).toContain("adc")
  })

  it("opens dialog with mode and turn info when selected", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    const cmds = api.command.register.mock.calls[0][0]()
    const configCmd = cmds.find((c) => c.value === "auto-drive-config")
    configCmd.onSelect()
    expect(api.ui.dialog.setSize).toHaveBeenCalledWith("large")
    expect(api.ui.dialog.replace).toHaveBeenCalled()

    const renderFn = api.ui.dialog.replace.mock.calls[0][0]
    const dialogJsx = renderFn()
    expect(dialogJsx.props.title).toBe("Auto-Drive 配置")
    expect(dialogJsx.props.options[0].title).toContain("🚀")
    expect(dialogJsx.props.options[0].title).toContain("ai")
    expect(dialogJsx.props.options[1].value).toBe("close")
  })

  it("shows stop mode in config dialog", async () => {
    const api = await setupWithConfig({ mode: "stop" })
    const cmds = api.command.register.mock.calls[0][0]()
    const configCmd = cmds.find((c) => c.value === "auto-drive-config")
    configCmd.onSelect()
    const renderFn = api.ui.dialog.replace.mock.calls[0][0]
    const dialogJsx = renderFn()
    expect(dialogJsx.props.options[0].title).toContain("⏸")
    expect(dialogJsx.props.options[0].title).toContain("stop")
  })

  it("close option clears dialog", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    const cmds = api.command.register.mock.calls[0][0]()
    const configCmd = cmds.find((c) => c.value === "auto-drive-config")
    configCmd.onSelect()
    const renderFn = api.ui.dialog.replace.mock.calls[0][0]
    const dialogJsx = renderFn()
    dialogJsx.props.onSelect({ value: "close" })
    expect(api.ui.dialog.clear).toHaveBeenCalled()
  })
})
