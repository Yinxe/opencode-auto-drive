import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

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

// ── Mock loadConfig so we can override config per test ──
vi.mock("../loadConfig.js", async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    loadConfig: vi.fn().mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: 5,
        presets: {},
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    }),
    saveProjectConfig: vi.fn().mockResolvedValue(),
    readJSON: vi.fn().mockResolvedValue(null),
  }
})

import plugin from "../tui.jsx"
import { createMockApi } from "./helpers/mock-api.js"

describe("test exports", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (globalThis.__lastApi) {
      globalThis.__lastApi._cleanup()
    }
  })

  it("exports internal functions when NODE_ENV=test", async () => {
    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api
    expect(typeof plugin.autoDrive).toBe("function")
    expect(typeof plugin.saveConfigFile).toBe("function")
    expect(typeof plugin.quickToggle).toBe("function")
    expect(typeof plugin.fireImmediate).toBe("function")
    expect(typeof plugin.commitMode).toBe("function")
  })

  it("warns and falls back to 5 for non-numeric maxTurns", async () => {
    // Mock loadConfig to return a non-numeric maxTurns
    const { loadConfig } = await import("../loadConfig.js")
    vi.mocked(loadConfig).mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: "invalid",
        presets: {},
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    })

    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api

    expect(console.warn).toHaveBeenCalledWith(
      "[auto-drive] maxTurns 配置无效 (invalid), 回退到 5",
    )
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    )
  })

  it("warns and falls back to 5 for negative maxTurns", async () => {
    const { loadConfig } = await import("../loadConfig.js")
    vi.mocked(loadConfig).mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: -3,
        presets: {},
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    })

    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api

    expect(console.warn).toHaveBeenCalledWith(
      "[auto-drive] maxTurns 配置无效 (-3), 回退到 5",
    )
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    )
  })

  it("warns and falls back to 5 for Infinity maxTurns", async () => {
    const { loadConfig } = await import("../loadConfig.js")
    vi.mocked(loadConfig).mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: Infinity,
        presets: {},
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    })

    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api

    expect(console.warn).toHaveBeenCalledWith(
      "[auto-drive] maxTurns 配置无效 (Infinity), 回退到 5",
    )
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    )
  })

  it("warns and skips preset whose name conflicts with built-in mode", async () => {
    const { loadConfig } = await import("../loadConfig.js")
    vi.mocked(loadConfig).mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: 5,
        presets: { stop: "should be ignored" },
        sequences: {},
      },
      projectPath: "/tmp/test-auto-drive.json",
    })

    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api

    expect(console.warn).toHaveBeenCalledWith(
      '[auto-drive] 预设名称 "stop" 与内置模式冲突，已忽略',
    )
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    )
  })

  it("warns and skips sequence whose name conflicts with built-in mode", async () => {
    const { loadConfig } = await import("../loadConfig.js")
    vi.mocked(loadConfig).mockResolvedValue({
      merged: {
        mode: "stop",
        customPrompt: "",
        maxTurns: 5,
        presets: {},
        sequences: { ai: ["step1"] },
      },
      projectPath: "/tmp/test-auto-drive.json",
    })

    const api = createMockApi()
    await plugin.tui(api, {})
    globalThis.__lastApi = api

    expect(console.warn).toHaveBeenCalledWith(
      '[auto-drive] 序列名称 "ai" 与内置模式冲突，已忽略',
    )
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    )
  })

  it("shows startup toast in non-test environment", async () => {
    const origEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    try {
      const api = createMockApi()
      await plugin.tui(api, {})
      expect(api.ui.toast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Auto-Drive 已就绪") }),
      )
      api._cleanup()
    } finally {
      process.env.NODE_ENV = origEnv
    }
  })
})
