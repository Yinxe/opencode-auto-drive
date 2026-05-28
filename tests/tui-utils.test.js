import { describe, it, expect } from "vitest"
import {
  getCurrentPrompt,
  isActive,
  getTaskLabel,
  buildMenuOptions,
} from "../tui-utils.js"
import { AI_GUIDE_PROMPT } from "../loadConfig.js"

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
  meta.ai = { type: "ai", getPrompt: () => AI_GUIDE_PROMPT, label: "AI 驱动" }
  meta["继续优化"] = {
    type: "preset",
    label: "继续优化",
    getPrompt: () => "继续优化当前功能",
  }
  meta["完整开发周期"] = {
    type: "sequence",
    label: "完整开发周期",
    getPrompt: () => "分析当前项目的代码结构",
    sequence: ["分析代码", "修复问题", "补充测试", "添加文档"],
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
    expect(isActive(meta, "继续优化")).toBe(true)
  })

  it("returns true for sequence mode", () => {
    expect(isActive(meta, "完整开发周期")).toBe(true)
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
    expect(getCurrentPrompt(meta, "继续优化", "s1", new Map())).toBe(
      "继续优化当前功能",
    )
  })

  it("returns sequence step by current index", () => {
    const meta = createModeMeta()
    const seqIdx = new Map([["s1", 2]])
    expect(getCurrentPrompt(meta, "完整开发周期", "s1", seqIdx)).toBe("补充测试")
  })

  it("wraps sequence index with modulo for looping", () => {
    const meta = createModeMeta()
    const seqIdx = new Map([["s1", 5]]) // beyond length, should wrap to index 1
    expect(getCurrentPrompt(meta, "完整开发周期", "s1", seqIdx)).toBe("修复问题")
  })

  it("returns getPrompt result when no sessionID given (sequence)", () => {
    const meta = createModeMeta()
    // When sessionID is null, getCurrentPrompt returns meta.getPrompt()
    expect(getCurrentPrompt(meta, "完整开发周期", null, new Map())).toBe(
      "分析当前项目的代码结构",
    )
  })

  it("returns null for unknown mode", () => {
    const meta = createModeMeta()
    expect(getCurrentPrompt(meta, "不存在", "s1", new Map())).toBeNull()
  })

  it("starts sequence at index 0 when session has no seqIndex entry", () => {
    const meta = createModeMeta()
    expect(
      getCurrentPrompt(meta, "完整开发周期", "new-session", new Map()),
    ).toBe("分析代码")
  })

  it("returns base prompt for empty sequence array (no crash)", () => {
    const meta = createModeMeta()
    meta["空序列"] = {
      type: "sequence",
      label: "空序列",
      getPrompt: () => "基础提示",
      sequence: [],
    }
    expect(getCurrentPrompt(meta, "空序列", "s1", new Map())).toBe("基础提示")
  })
})

// ── getTaskLabel ──

describe("getTaskLabel", () => {
  it('returns "AI 驱动" for ai mode', () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "ai", null, new Map())).toBe("AI 驱动")
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

  it("returns sequence step label for sequence mode", () => {
    const meta = createModeMeta()
    const seqIdx = new Map([["s1", 1]])
    expect(
      getTaskLabel(meta, null, "完整开发周期", "s1", seqIdx),
    ).toBe("完整开发周期 第2/4步")
  })

  it("returns currentMode for unknown mode", () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "未知模式", null, new Map())).toBe("未知模式")
  })

  it("returns mode label for preset mode", () => {
    const meta = createModeMeta()
    expect(getTaskLabel(meta, null, "继续优化", null, new Map())).toBe("继续优化")
  })
})

// ── buildMenuOptions ──

describe("buildMenuOptions", () => {
  const presets = {
    "继续优化": "继续优化当前功能",
    "修复 Bug": "检查潜在问题",
  }
  const sequences = { "完整开发周期": ["分析", "修复", "测试", "文档"] }

  it("returns array with stop/custom/ai entries first", () => {
    const opts = buildMenuOptions(presets, sequences)
    expect(opts[0].value).toBe("stop")
    expect(opts[1].value).toBe("custom")
    expect(opts[2].value).toBe("ai")
  })

  it("includes separator after built-in modes", () => {
    const opts = buildMenuOptions(presets, sequences)
    expect(opts[3].disabled).toBe(true)
    expect(opts[3].value).toBe("__sep__")
  })

  it("includes preset entries after separator", () => {
    const opts = buildMenuOptions(presets, {})
    const presetEntries = opts.filter(
      (o) => o.value === "继续优化" || o.value === "修复 Bug",
    )
    expect(presetEntries).toHaveLength(2)
  })

  it("includes sequence entries with separator", () => {
    const opts = buildMenuOptions({}, sequences)
    const seqSep = opts.find((o) => o.value === "__seq_sep__")
    expect(seqSep?.disabled).toBe(true)
    const seqEntry = opts.find((o) => o.value === "完整开发周期")
    expect(seqEntry).toBeTruthy()
    expect(seqEntry.description).toBe("4 步循环")
  })

  it("omits sequence separator when no sequences", () => {
    const opts = buildMenuOptions(presets, {})
    const seqSep = opts.find((o) => o.value === "__seq_sep__")
    expect(seqSep).toBeUndefined()
  })

  it("uses default icon for presets without custom icon", () => {
    const opts = buildMenuOptions({ "自定义预设": "desc" }, {})
    const entry = opts.find((o) => o.value === "自定义预设")
    expect(entry.title).toMatch(/📋/)
  })

  it("skips sequences with empty arrays", () => {
    const opts = buildMenuOptions({}, { "空序列": [] })
    const entry = opts.find((o) => o.value === "空序列")
    expect(entry).toBeUndefined()
  })

  it("includes config separator and entry at end", () => {
    const opts = buildMenuOptions({}, {})
    const last1 = opts[opts.length - 2]
    const last2 = opts[opts.length - 1]
    expect(last1.value).toBe("__cfg_sep__")
    expect(last1.disabled).toBe(true)
    expect(last2.value).toBe("__config__")
    expect(last2.title).toContain("查看配置")
  })
})
