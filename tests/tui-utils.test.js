import { describe, it, expect } from "vitest"
import {
  getCurrentPrompt,
  isActive,
  getTaskLabel,
  buildMenuOptions,
} from "../tui-utils.js"
import { AI_GUIDE_PROMPT } from "../prompts.js"

// ── Shared test fixtures ──

function createModeMeta(overrides = {}) {
  const config = { customPrompt: "测试提示词", ...overrides }
  const meta = {}

  meta.stop = { type: "stop", getPrompt: () => null, label: "停止" }
  meta.custom = {
    type: "custom",
    getPrompt: () => config.customPrompt,
    label: "自定义",
  }
  meta.ai = { type: "ai", getPrompt: () => AI_GUIDE_PROMPT, label: "AI + 多Agent" }
  meta["智能迭代"] = {
    type: "preset",
    label: "智能迭代",
    getPrompt: () => "多Agent 自主决策",
  }

  return meta
}

// ── isActive ──

describe("isActive", () => {
  const meta = createModeMeta()

  it("returns false for stop mode", () => {
    expect(isActive(meta, "stop")).toBe(false)
  })

  it("returns true for ai mode", () => {
    expect(isActive(meta, "ai")).toBe(true)
  })

  it("returns true for custom mode with prompt", () => {
    expect(isActive(meta, "custom")).toBe(true)
  })

  it("returns true for preset mode", () => {
    expect(isActive(meta, "智能迭代")).toBe(true)
  })

  it("returns false for unknown mode", () => {
    expect(isActive(meta, "不存在的模式")).toBe(false)
  })

  it("returns false when non-stop mode lacks getPrompt property", () => {
    const m = { custom: { type: "custom" } }
    expect(isActive(m, "custom")).toBe(false)
  })
})

// ── getCurrentPrompt ──

describe("getCurrentPrompt", () => {
  it("returns null for stop mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "stop", "s1", new Map())).toBeNull()
  })

  it("returns AI_GUIDE_PROMPT for ai mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "ai", "s1", new Map())).toBe(AI_GUIDE_PROMPT)
  })

  it("returns customPrompt for custom mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "custom", "s1", new Map())).toBe("测试提示词")
  })

  it("returns preset prompt for preset mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "智能迭代", "s1", new Map())).toBe(
      "多Agent 自主决策",
    )
  })

  it("returns null for unknown mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "不存在", "s1", new Map())).toBeNull()
  })
})

// ── getTaskLabel ──

describe("getTaskLabel", () => {
  it('returns "AI + 多Agent" for ai mode', () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "ai", null, new Map())).toBe("AI + 多Agent")
  })

  it("returns truncated custom prompt for custom mode", () => {
    const meta = createModeMeta()
    const longPrompt = "这是一段很长的自定义提示词，需要被截断到20个字符"
    expect(getTaskLabel(meta, longPrompt, "custom", null, new Map())).toBe(
      longPrompt.slice(0, 20),
    )
  })

  it("returns empty string for custom mode when prompt is null", () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "custom", null, new Map())).toBe("")
  })

  it("returns currentMode for unknown mode", () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "未知模式", null, new Map())).toBe("未知模式")
  })

  it("returns mode label for preset mode", () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "智能迭代", null, new Map())).toBe("智能迭代")
  })
})

// ── buildMenuOptions ──

describe("buildMenuOptions", () => {
  const presets = {
    "智能迭代": "prompt text",
    "功能优先": "prompt text",
  }

  it("returns array with stop/custom/ai entries first", () => {
    const opts = buildMenuOptions(presets)
    expect(opts[0].value).toBe("stop")
    expect(opts[1].value).toBe("custom")
    expect(opts[2].value).toBe("ai")
  })

  it("includes separator after built-in modes", () => {
    const opts = buildMenuOptions(presets)
    expect(opts[3].disabled).toBe(true)
    expect(opts[3].value).toBe("__sep__")
  })

  it("includes preset entries after separator", () => {
    const opts = buildMenuOptions(presets)
    const presetEntries = opts.filter(
      (o) => o.value === "智能迭代" || o.value === "功能优先",
    )
    expect(presetEntries).toHaveLength(2)
  })

  it("uses PRESET_DESC for built-in preset descriptions", () => {
    const opts = buildMenuOptions(presets)
    const entry = opts.find((o) => o.value === "智能迭代")
    expect(entry.description).toBe("多Agent 自主决策：修 bug / 优化 / 新功能")
  })

  it("uses default icon for presets without custom icon", () => {
    const opts = buildMenuOptions({ "自定义预设": "desc" })
    const entry = opts.find((o) => o.value === "自定义预设")
    expect(entry.title).toMatch(/📋/)
  })

  it("truncates long descriptions for unknown presets", () => {
    const opts = buildMenuOptions({ "长预设": "a".repeat(100) })
    const entry = opts.find((o) => o.value === "长预设")
    expect(entry.description.length).toBeLessThanOrEqual(65)
  })

  it("includes config separator and entry at end", () => {
    const opts = buildMenuOptions({})
    const last1 = opts[opts.length - 2]
    const last2 = opts[opts.length - 1]
    expect(last1.value).toBe("__cfg_sep__")
    expect(last1.disabled).toBe(true)
    expect(last2.value).toBe("__config__")
    expect(last2.title).toContain("查看配置")
  })
})
