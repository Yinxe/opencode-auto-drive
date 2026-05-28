/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import {
  AI_GUIDE_PROMPT,
  PRESET_ICONS,
  loadConfig,
  saveProjectConfig,
} from "./loadConfig.js"

/**
 * OpenCode 自动驾驶插件
 *
 * 监听 session.idle，AI 回复结束后自动发送下一轮 prompt。
 * 支持停止 / 自定义 / AI 驱动 / 预设四种模式。
 *
 * 使用方式：
 *   /auto-drive 或 Ctrl+P → auto-drive → Enter    打开模式菜单
 *   ├─ ⏸ 停止
 *   ├─ ✏️ 自定义（弹窗输入提示词）
 *   ├─ 🤖 AI 驱动
 *   └─ 预设（"继续优化"、"修复 Bug"等）
 *
 *   Ctrl+Alt+A    快速切换启用/停止
 *
 * 预设配置（tui.json 或 auto-drive.json）：
 *   "pluginConfig": {
 *     "auto-drive": { "mode": "继续优化", "maxTurns": 10 }
 *   }
 */

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
  const [lastMode, setLastMode] = createSignal(
    config.mode !== "stop" ? config.mode : null,
  )
  const [sessionID, setSessionID] = createSignal(
    api.route.current.name === "session"
      ? api.route.current.params.sessionID
      : null,
  )

  /** 获取当前 session 的轮次（用于状态栏响应式显示） */
  function getSessionTurns() {
    const sid = sessionID()
    if (!sid) return 0
    return state.turns.get(sid) ?? 0
  }

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

  /** 向会话发送下一轮提示词 */
  async function autoDrive(event) {
    const currentMode = mode()
    if (!isActive(currentMode)) return

    const { sessionID: sid } = event.properties
    if (!sid) return
    setSessionID(sid)

    const current = state.turns.get(sid) ?? 0
    if (current >= state.maxTurns) return

    const prompt = getPromptText(currentMode)
    if (!prompt) return

    state.turns.set(sid, current + 1)

    try {
      const label = currentMode === "ai" ? "🤖" : `"${prompt.slice(0, 30)}"`
      console.warn(
        `[auto-drive] 🚀 ${current + 1}/${state.maxTurns} ${label}`,
      )
      await api.client.session.prompt({
        sessionID: sid,
        parts: [{ type: "text", text: prompt }],
      })
    } catch (err) {
      console.error(
        "[auto-drive] ❌",
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** 对当前会话立即执行一次自动驾驶（走 autoDrive 统一逻辑） */
  function fireImmediate() {
    const route = api.route.current
    if (route.name !== "session") return
    const sessionID = route.params.sessionID
    if (!sessionID) return
    autoDrive({ properties: { sessionID } })
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

  /** 快速切换：活跃→停止 / 停止→恢复上次模式 */
  function quickToggle() {
    if (mode() !== "stop") {
      setLastMode(mode())
      setMode("stop")
      config.mode = "stop"
    } else if (lastMode()) {
      const previous = lastMode()
      setMode(previous)
      config.mode = previous
      saveConfigFile()
      fireImmediate()
      return
    } else {
      // 从未启用过，默认用第一个预设
      const first = Object.keys(config.presets)[0]
      if (first) {
        setMode(first)
        config.mode = first
        setLastMode(first)
        saveConfigFile()
        fireImmediate()
        return
      }
    }
    saveConfigFile()
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
      {
        title: "─".repeat(20),
        value: "__sep__",
        disabled: true,
        description: "",
      },
      ...Object.entries(config.presets).map(([name, desc]) => ({
        title: `${PRESET_ICONS[name] ?? "📋"} ${name}`,
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
          if (option.value === "__sep__") return
          if (option.value === "custom") {
            showCustomPrompt()
            return
          }
          setMode(option.value)
          config.mode = option.value
          if (option.value !== "stop") setLastMode(option.value)
          saveConfigFile()
          fireImmediate()
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
          if (!value.trim()) return
          api.ui.dialog.clear()
          config.customPrompt = value.trim()
          setMode("custom")
          config.mode = "custom"
          setLastMode("custom")
          saveConfigFile()
          fireImmediate()
        }}
        onCancel={() => {
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  // ── 注册命令 ──
  const unregCmd = api.command.register(() => [
    {
      title: `Auto-Drive: ${mode() === "stop" ? "⏸ 已停止" : `🚀 ${mode()}`}`,
      value: "auto-drive-menu",
      description: `当前模式: ${mode()}`,
      category: "auto-drive",
      slash: { name: "auto-drive", aliases: ["ad"] },
      onSelect: showMenu,
    },
    {
      title: "Auto-Drive: 切换",
      value: "auto-drive-toggle",
      description: `快速切换启用/停止`,
      keybind: "ctrl+alt+a",
      category: "auto-drive",
      onSelect: quickToggle,
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
        const sessionTurns = getSessionTurns()

        return (
          <box flexDirection="row" paddingLeft={1} paddingRight={1}>
            <Show
              when={isActive(currentMode)}
              fallback={
                <text fg={theme.textMuted}>
                  ⏸ AD{lastMode() ? ` [${lastMode()}]` : ""}
                </text>
              }
            >
              <text fg={theme.primary}>🚀 AD</text>

              <Show when={currentMode === "ai"}>
                <text fg={theme.text}> 🤖</text>
              </Show>
              <Show when={currentMode === "custom"}>
                <text fg={theme.textMuted}> "</text>
                <text fg={theme.text}>{config.customPrompt.slice(0, 30)}</text>
                <text fg={theme.textMuted}>"</text>
              </Show>
              <Show when={currentMode !== "ai" && currentMode !== "custom"}>
                <text fg={theme.textMuted}> </text>
                <text fg={theme.text}>{currentMode}</text>
              </Show>

              <text fg={theme.textMuted}> {sessionTurns}/{state.maxTurns}</text>
            </Show>
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
