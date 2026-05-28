import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import plugin from "../tui.jsx"
import { AI_GUIDE_PROMPT } from "../loadConfig.js"
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

// ── Mock loadConfig so autoDrive tests don't touch disk ──
vi.mock("../loadConfig.js", async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    loadConfig: vi.fn().mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: 5,
        presets: { "继续优化": "继续优化当前功能" },
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    }),
    saveProjectConfig: vi.fn().mockResolvedValue(),
    readJSON: vi.fn().mockResolvedValue(null),
  }
})

// ── Config helper: create a mockApi + call tui with given mode config ──

async function setupWithConfig(configOverrides = {}) {
  const { loadConfig } = await import("../loadConfig.js")
  loadConfig.mockResolvedValue({
    merged: {
      mode: "stop",
      customPrompt: "",
      maxTurns: 5,
      presets: { "继续优化": "继续优化当前功能" },
      sequences: {},
      ...configOverrides,
    },
    projectPath: "/tmp/test-auto-drive.json",
  })

  const api = createMockApi()
  await plugin.tui(api, {})
  return api
}

function makeEvent(sessionID = "test-session-1") {
  return { properties: { sessionID } }
}

// ── Tests ──

describe("autoDrive", () => {
  /** @type {import("../loadConfig.js").loadConfig} */
  let loadConfigMock

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    loadConfigMock = (await import("../loadConfig.js")).loadConfig
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

  // ── 5. Sequence mode ──
  it("cycles through sequence steps and wraps with modulo", async () => {
    const api = await setupWithConfig({
      mode: "序列测试",
      sequences: {
        "序列测试": ["step-0", "step-1", "step-2"],
      },
    })
    globalThis.__lastApi = api

    // Call 3 times
    const r1 = await plugin.autoDrive(makeEvent())
    const r2 = await plugin.autoDrive(makeEvent())
    const r3 = await plugin.autoDrive(makeEvent())

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(r3).toBe(true)
    expect(api.client.session.prompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      parts: [{ type: "text", text: "step-0" }],
    }))
    expect(api.client.session.prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      parts: [{ type: "text", text: "step-1" }],
    }))
    expect(api.client.session.prompt).toHaveBeenNthCalledWith(3, expect.objectContaining({
      parts: [{ type: "text", text: "step-2" }],
    }))

    // 4th call wraps to index 0
    const r4 = await plugin.autoDrive(makeEvent())
    expect(r4).toBe(true)
    expect(api.client.session.prompt).toHaveBeenNthCalledWith(4, expect.objectContaining({
      parts: [{ type: "text", text: "step-0" }],
    }))
  })

  // ── 6. Concurrent call protection ──
  it("rejects concurrent calls for the same session (pendingLocks)", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    globalThis.__lastApi = api

    // Manually add a lock to simulate in-flight
    // We need access to pendingLocks, which is internal.
    // Instead, make the first call slow by delaying prompt resolution.
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

  it("toast shows correct step number for sequence mode", async () => {
    const api = await setupWithConfig({
      mode: "完整开发周期",
      maxTurns: 5,
      presets: {},
      sequences: { "完整开发周期": ["分析", "修复", "测试", "文档"] },
    })
    globalThis.__lastApi = api
    api.ui.toast.mockClear()

    // First turn: no toast (current===0)
    await plugin.autoDrive(makeEvent())
    expect(api.ui.toast).not.toHaveBeenCalled()

    // Second turn: toast shows step just completed → prevIdx+1 = 1 → "第2/4步"
    await plugin.autoDrive(makeEvent())
    const t1 = api.ui.toast.mock.calls[0][0].message
    expect(t1).toContain("第2/4步")
    expect(t1).toContain("完整开发周期")

    // Third turn: prevIdx now 2 → "第3/4步"
    api.ui.toast.mockClear()
    await plugin.autoDrive(makeEvent())
    expect(api.ui.toast.mock.calls[0][0].message).toContain("第3/4步")
  })

  // ── 9. No sessionID → null ──
  it("returns null when event has no sessionID", async () => {
    await setupWithConfig({ mode: "ai" })

    const result = await plugin.autoDrive({ properties: {} })
    expect(result).toBeNull()
  })

  // ── 10. Export verification (the mechanism works) ──
  it("exposes autoDrive on plugin after tui() call", async () => {
    // Reset plugin state by calling tui again
    const api = createMockApi()
    await plugin.tui(api, {})

    expect(typeof plugin.autoDrive).toBe("function")
    expect(typeof plugin.saveConfigFile).toBe("function")
    expect(typeof plugin.quickToggle).toBe("function")
    expect(typeof plugin.fireImmediate).toBe("function")
    expect(typeof plugin.commitMode).toBe("function")
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
    // fireImmediate is async but fire-and-forget; drain microtask queue
    await vi.waitFor(() => {
      expect(api.client.session.prompt).toHaveBeenCalled()
    })
  })

  it("uses first preset when no lastMode exists", async () => {
    const api = await setupWithConfig({ mode: "stop", presets: { "继续优化": "优化" } })
    api.client.session.prompt.mockClear()
    plugin.quickToggle() // activates preset + fires prompt via fireImmediate
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

  it("sets mode and maxTurns, saves config, fires immediate", async () => {
    const api = await setupWithConfig({ mode: "stop" })
    api.client.session.prompt.mockClear()
    plugin.commitMode("ai", 10)
    // commitMode calls saveConfigFile + fireImmediate (prompt via fire-and-forget)
    const { saveProjectConfig } = await import("../loadConfig.js")
    expect(saveProjectConfig).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(api.client.session.prompt).toHaveBeenCalled()
    })
  })

  it("shows warning toast for inactive mode (empty customPrompt)", async () => {
    const api = await setupWithConfig({ mode: "stop", customPrompt: "" })
    plugin.commitMode("custom", 3)
    // Warning toast about inactive mode
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
    // Override route to non-session
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

    // Call the render function to inspect dialog content
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
    // Simulate selecting the close option
    dialogJsx.props.onSelect({ value: "close" })
    expect(api.ui.dialog.clear).toHaveBeenCalled()
  })
})

// ── saveConfigFile ──

describe("saveConfigFile", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("calls saveProjectConfig with mode, maxTurns, customPrompt, presets", async () => {
    const api = await setupWithConfig({ mode: "ai", maxTurns: 10, customPrompt: "test" })
    const { saveProjectConfig } = await import("../loadConfig.js")
    saveProjectConfig.mockClear()
    await plugin.saveConfigFile()
    expect(saveProjectConfig).toHaveBeenCalledTimes(1)
    const [path, data] = saveProjectConfig.mock.calls[0]
    expect(data.mode).toBe("ai")
    expect(data.maxTurns).toBe(10)
    expect(data.customPrompt).toBe("test")
    expect(data.presets).toBeTruthy()
  })

  it("shows error toast when save fails", async () => {
    const api = await setupWithConfig()
    const { saveProjectConfig } = await import("../loadConfig.js")
    saveProjectConfig.mockRejectedValueOnce(new Error("disk full"))
    await plugin.saveConfigFile()
    // Error toast should be shown
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error" }),
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

  it("delegates to autoDrive for current session", async () => {
    vi.useRealTimers()
    const api = await setupWithConfig({ mode: "ai" })
    await plugin.fireImmediate()
    expect(api.client.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("does nothing when not on a session route", async () => {
    const api = await setupWithConfig({ mode: "ai" })
    api.route.current = { name: "chat" }
    await plugin.fireImmediate()
    expect(api.client.session.prompt).not.toHaveBeenCalled()
  })
})

