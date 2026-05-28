import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  AI_GUIDE_PROMPT,
  DEFAULT_PRESETS,
  PRESET_ICONS,
  DEFAULT_SEQUENCES,
} from "../prompts.js"
import { loadConfig, saveProjectConfig, readJSON } from "../loadConfig.js"
import { mkdir, writeFile, unlink, rmdir, readdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

// ── Constants ──

describe("constants", () => {
  it("AI_GUIDE_PROMPT is a non-empty string", () => {
    expect(typeof AI_GUIDE_PROMPT).toBe("string")
    expect(AI_GUIDE_PROMPT.length).toBeGreaterThan(100)
  })

  it("DEFAULT_PRESETS has 6 entries", () => {
    expect(Object.keys(DEFAULT_PRESETS)).toHaveLength(6)
    expect(DEFAULT_PRESETS["继续优化"]).toBeTruthy()
    expect(DEFAULT_PRESETS["修复 Bug"]).toBeTruthy()
    expect(DEFAULT_PRESETS["补充测试"]).toBeTruthy()
    expect(DEFAULT_PRESETS["添加文档"]).toBeTruthy()
  })

  it("PRESET_ICONS has icons for all presets", () => {
    for (const name of Object.keys(DEFAULT_PRESETS)) {
      expect(PRESET_ICONS[name]).toBeTruthy()
    }
  })

  it("DEFAULT_SEQUENCES has 完整开发周期", () => {
    expect(DEFAULT_SEQUENCES["完整开发周期"]).toBeInstanceOf(Array)
    expect(DEFAULT_SEQUENCES["完整开发周期"]).toHaveLength(4)
  })
})

// ── loadConfig ──

describe("loadConfig", () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `auto-drive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    // Create .opencode/plugins/ directory
    await mkdir(join(tmpDir, ".opencode", "plugins"), { recursive: true })
  })

  afterEach(async () => {
    await unlink(join(tmpDir, ".opencode", "plugins", "auto-drive.json")).catch(() => {})
    await rmdir(join(tmpDir, ".opencode", "plugins")).catch(() => {})
    await rmdir(join(tmpDir, ".opencode")).catch(() => {})
    await rmdir(tmpDir).catch(() => {})
  })

  it("returns defaults when no config files exist", async () => {
    // Prevent reading global config by setting HOME to tmpDir
    const origHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      const { merged } = await loadConfig(tmpDir)
      expect(merged.mode).toBe("stop")
      expect(merged.customPrompt).toBe("")
      expect(merged.presets).toEqual(DEFAULT_PRESETS)
      expect(merged.sequences).toEqual(DEFAULT_SEQUENCES)
    } finally {
      process.env.HOME = origHome
    }
  })

  it("merges project config over global config", async () => {
    const origHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      // Write global config
      const globalDir = join(tmpDir, ".config", "opencode")
      await mkdir(globalDir, { recursive: true })
      await writeFile(
        join(globalDir, "auto-drive.json"),
        JSON.stringify({ mode: "ai", maxTurns: 10, presets: { "全局预设": "全局" } }),
      )

      // Write project config
      await writeFile(
        join(tmpDir, ".opencode", "plugins", "auto-drive.json"),
        JSON.stringify({
          mode: "custom",
          customPrompt: "项目特定提示词",
          presets: { "项目预设": "项目" },
        }),
      )

      const { merged } = await loadConfig(tmpDir)
      // project mode overrides global
      expect(merged.mode).toBe("custom")
      expect(merged.customPrompt).toBe("项目特定提示词")
      // presets should be deep-merged: defaults + global + project
      expect(merged.presets["继续优化"]).toBeTruthy() // from defaults
      expect(merged.presets["全局预设"]).toBe("全局") // from global
      expect(merged.presets["项目预设"]).toBe("项目") // from project
      // maxTurns from global still applies (project doesn't override)
      expect(merged.maxTurns).toBe(10)
    } finally {
      process.env.HOME = origHome
      // Cleanup global config
      await unlink(join(tmpDir, ".config", "opencode", "auto-drive.json")).catch(() => {})
      await rmdir(join(tmpDir, ".config", "opencode")).catch(() => {})
      await rmdir(join(tmpDir, ".config")).catch(() => {})
    }
  })

  it("handles missing global config (ENOENT)", async () => {
    const origHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      const { merged } = await loadConfig(tmpDir)
      expect(merged.mode).toBe("stop")
      expect(merged.presets).toEqual(DEFAULT_PRESETS)
    } finally {
      process.env.HOME = origHome
    }
  })
})

// ── saveProjectConfig ──

describe("saveProjectConfig", () => {
  let tmpDir, testPath

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `auto-drive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    testPath = join(tmpDir, "config.json")
  })

  afterEach(async () => {
    await unlink(testPath).catch(() => {})
    await rmdir(tmpDir).catch(() => {})
  })

  it("writes config to file as formatted JSON", async () => {
    await saveProjectConfig(testPath, { mode: "ai", maxTurns: 5 })
    const { readFile } = await import("fs/promises")
    const content = await readFile(testPath, "utf-8")
    expect(content).toBe(JSON.stringify({ mode: "ai", maxTurns: 5 }, null, 2) + "\n")
  })

  it("creates intermediate directories", async () => {
    const deepPath = join(tmpDir, "a", "b", "c", "deep.json")
    await saveProjectConfig(deepPath, { test: true })
    const { readFile } = await import("fs/promises")
    const content = await readFile(deepPath, "utf-8")
    expect(JSON.parse(content)).toEqual({ test: true })
    // Cleanup
    await unlink(deepPath).catch(() => {})
    await rmdir(join(tmpDir, "a", "b", "c")).catch(() => {})
    await rmdir(join(tmpDir, "a", "b")).catch(() => {})
    await rmdir(join(tmpDir, "a")).catch(() => {})
  })
})

// ── readJSON ──

describe("readJSON", () => {
  let tmpDir, testPath

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `auto-drive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(tmpDir, { recursive: true })
    testPath = join(tmpDir, "test.json")
  })

  afterEach(async () => {
    const { rm } = await import("fs/promises")
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("returns parsed object for valid JSON", async () => {
    await writeFile(testPath, JSON.stringify({ mode: "ai", maxTurns: 10 }))
    const result = await readJSON(testPath)
    expect(result).toEqual({ mode: "ai", maxTurns: 10 })
  })

  it("returns null for non-existent file (ENOENT)", async () => {
    const result = await readJSON("/tmp/nonexistent-" + Date.now() + ".json")
    expect(result).toBeNull()
  })

  it("returns null and logs warning for malformed JSON", async () => {
    await writeFile(testPath, "{ mode: ai }") // invalid JSON (unquoted keys)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await readJSON(testPath)
    expect(result).toBeNull()
    // Should log a warning about parse failure
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("returns null for empty file", async () => {
    await writeFile(testPath, "")
    const result = await readJSON(testPath)
    expect(result).toBeNull()
  })
})
