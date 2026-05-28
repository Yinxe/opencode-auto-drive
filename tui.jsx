/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, dirname } from "path"

const AI_GUIDE_PROMPT =
  "基于当前项目和对话上下文，决定下一步最有价值的事。" +
  "可以改 bug、重构、加新功能、加文档——完全由你判断。先输出计划再执行。"

const DEFAULT_PRESETS = {
  "继续优化": "继续优化当前功能，添加必要的注释和类型完善",
  "修复 Bug": "检查当前代码中的潜在问题并修复",
  "补充测试": "为当前代码添加单元测试和集成测试",
  "添加文档": "为当前代码添加中文文档注释",
}

/**
 * OpenCode 自动驾驶插件
 *
 * 监听 session.idle，AI 回复结束后自动发送下一轮 prompt。
 *
 * 使用方式：
 *   Ctrl+P → auto-drive → Enter    切换开关
 *   或直接在输入框打 /auto-drive     切换开关
 *
 * 预设配置（tui.json 或 auto-drive.json）：
 *   "pluginConfig": {
 *     "auto-drive": { "mode": "继续优化", "maxTurns": 10, "customPrompt": "继续优化", "presets": { ... } }
 *   }
 */

/** 从文件读取 JSON，若不存在则返回 null */
async function readJSON(path) {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw)
  } catch (err) {
    if (err?.code === "ENOENT") return null
    console.warn(`[auto-drive] 配置文件解析失败: ${path}`, err)
    return null
  }
}

/** 读取并合并全局 + 项目配置，返回 { merged, projectPath } */
async function loadConfig(projectDir) {
  const globalPath = join(homedir(), ".config", "opencode", "auto-drive.json")
  const projectPath = join(projectDir, ".opencode", "plugins", "auto-drive.json")

  const [global, project] = await Promise.all([
    readJSON(globalPath),
    readJSON(projectPath),
  ])

  const merged = {
    mode: "stop",
    customPrompt: "",
    presets: { ...DEFAULT_PRESETS },
    ...(global ?? {}),
    ...(project ?? {}),
  }

  return { merged, projectPath }
}

/** 将配置写入项目级文件 */
async function saveProjectConfig(path, config) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8")
}

/** @type {import('@opencode-ai/plugin/tui').TuiPlugin} */
const tui = async (api, options) => {
  const projectDir = api.state.path.directory
  const { merged: config, projectPath } = await loadConfig(projectDir)

  // Options 最高优先级覆盖
  if (options?.mode !== undefined) config.mode = options.mode
  if (options?.customPrompt !== undefined) config.customPrompt = options.customPrompt
  if (options?.presets) config.presets = { ...config.presets, ...options.presets }

  const state = {
    maxTurns: options?.maxTurns ?? 5,
    /** sessionID -> 已自动轮数 */
    turns: new Map(),
  }

  // ── Solid 信号 ──
  const [mode, setMode] = createSignal(config.mode)
  const [turnCount, setTurnCount] = createSignal(0)

  /** 获取当前模式的 prompt 文本 */
  function getPromptText(currentMode) {
    if (currentMode === "ai") return AI_GUIDE_PROMPT
    if (currentMode === "custom") return config.customPrompt
    if (config.presets[currentMode]) return config.presets[currentMode]
    return null
  }

  /** 根据 mode 判断是否活跃 */
  function isActive(currentMode) {
    return currentMode !== "stop" && !!getPromptText(currentMode)
  }

  /** 计算所有会话的累计轮数 */
  function computeTurnCount() {
    return Array.from(state.turns.values()).reduce((a, b) => a + b, 0)
  }

  /** 向会话发送下一轮提示词 */
  async function autoDrive(event) {
    const currentMode = mode()
    if (!isActive(currentMode)) return

    const { sessionID } = event.properties
    if (!sessionID) return

    const current = state.turns.get(sessionID) ?? 0
    if (current >= state.maxTurns) return

    const prompt = getPromptText(currentMode)
    if (!prompt) return

    state.turns.set(sessionID, current + 1)
    setTurnCount(computeTurnCount())

    try {
      const label = currentMode === "ai" ? "🤖" : `"${prompt.slice(0, 30)}"`
      console.warn(
        `[auto-drive] 🚀 ${current + 1}/${state.maxTurns} ${label}`,
      )
      await api.client.session.prompt({
        sessionID,
        parts: [{ type: "text", text: prompt }],
      })
    } catch (err) {
      console.error(
        "[auto-drive] ❌",
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** 构建模式选择菜单选项 */
  function buildMenuOptions() {
    return [
      {
        title: "⏸ 停止",
        value: "stop",
        description: "关闭自动驾驶",
      },
      {
        title: "✏️ 自定义",
        value: "custom",
        description: "输入自定义提示词",
      },
      {
        title: "🤖 AI 驱动",
        value: "ai",
        description: "AI 自主决定下一步方向",
      },
      ...Object.entries(config.presets).map(([name, desc]) => ({
        title: `📋 ${name}`,
        value: name,
        description: desc,
      })),
    ]
  }

  /** 显示模式选择菜单 */
  function showMenu() {
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Auto-Drive 自动驾驶"
        options={buildMenuOptions()}
        current={mode()}
        onSelect={(option) => {
          api.ui.dialog.clear()
          if (option.value === "custom") {
            showCustomPrompt()
            return
          }
          setMode(option.value)
          config.mode = option.value
          saveConfigFile()
        }}
      />
    ))
  }

  /** 自定义提示词输入弹窗 */
  function showCustomPrompt() {
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="✏️ 输入自定义提示词"
        placeholder="例如：继续优化当前功能"
        value={config.customPrompt}
        onConfirm={(value) => {
          api.ui.dialog.clear()
          if (!value.trim()) return
          config.customPrompt = value.trim()
          setMode("custom")
          config.mode = "custom"
          saveConfigFile()
        }}
        onCancel={() => {
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  /** 保存当前配置到项目级文件 */
  async function saveConfigFile() {
    const data = {
      mode: config.mode,
      customPrompt: config.customPrompt,
      presets: config.presets,
    }
    await saveProjectConfig(projectPath, data).catch((err) => {
      console.error("[auto-drive] 配置保存失败:", err)
    })
  }

  // ── 注册 Ctrl+P / /auto-drive 命令 ──
  const unregCmd = api.command.register(() => [
    {
      title: `Auto-Drive: ${mode() === "stop" ? "⏸ 已停止" : `🚀 ${mode()}`}`,
      value: "auto-drive-menu",
      description: `当前模式: ${mode()}`,
      category: "auto-drive",
      slash: { name: "auto-drive", aliases: ["ad"] },
      onSelect: showMenu,
    },
  ])

  // ── 监听会话空闲 ──
  const unsubEvent = api.event.on("session.idle", autoDrive)

  // ── 底部状态栏（app_bottom 插槽） ──
  api.slots.register({
    order: 100,
    slots: {
      app_bottom(ctx) {
        const currentMode = mode()
        const theme = ctx.theme.current

        if (!isActive(currentMode)) {
          return (
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>⏸ AD</text>
            </box>
          )
        }

        if (currentMode === "ai") {
          return (
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.primary}>🚀 AD</text>
              <text fg={theme.text}> 🤖</text>
            </box>
          )
        }

        if (currentMode === "custom") {
          return (
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.primary}>🚀 AD</text>
              <text fg={theme.textMuted}> "</text>
              <text fg={theme.text}>{config.customPrompt}</text>
              <text fg={theme.textMuted}>"</text>
            </box>
          )
        }

        return (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.primary}>🚀 AD</text>
            <text fg={theme.textMuted}> </text>
            <text fg={theme.text}>{currentMode}</text>
          </box>
        )
      },
    },
  })

  // ── 清理 ──
  api.lifecycle.onDispose(() => {
    unregCmd()
    unsubEvent()
    state.turns.clear()
  })
}

const plugin = { id: "auto-drive", tui }
export default plugin
