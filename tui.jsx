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
  if (options?.sequences) config.sequences = { ...config.sequences, ...options.sequences }

  const maxTurnsDefault = options?.maxTurns ?? config.maxTurns ?? 5

  const state = {
    /** sessionID -> 已自动轮数 */
    turns: new Map(),
    /** sessionID -> 序列当前步进 */
    seqIndex: new Map(),
  }

  // ── Solid 信号 ──
  const [mode, setMode] = createSignal(config.mode)
  const [lastMode, setLastMode] = createSignal(
    config.mode !== "stop" ? config.mode : null,
  )
  const [maxTurns, setMaxTurns] = createSignal(maxTurnsDefault)
  const [sessionID, setSessionID] = createSignal(
    api.route.current.name === "session"
      ? api.route.current.params.sessionID
      : null,
  )
  const [turnRev, bumpTurnRev] = createSignal(0) // 强制状态栏重渲染

  // 轮询检测路由变更，更新 sessionID 信号
  const routePoll = setInterval(() => {
    const route = api.route.current
    if (route.name === "session" && route.params.sessionID !== sessionID()) {
      setSessionID(route.params.sessionID)
    }
    if (route.name !== "session" && sessionID() !== null) {
      setSessionID(null)
    }
  }, 2000)

  /** 获取当前 session 的轮次（用于状态栏响应式显示） */
  function getSessionTurns() {
    turnRev() // 每次 autoDrive 递增，强制重渲染
    const sid = sessionID()
    if (!sid) return 0
    return state.turns.get(sid) ?? 0
  }

  /** 获取当前模式的 prompt 文本（用于判断是否活跃） */
  function getPromptText(currentMode) {
    if (currentMode === "ai") return AI_GUIDE_PROMPT
    if (currentMode === "custom") return config.customPrompt
    if (config.presets[currentMode]) return config.presets[currentMode]
    if (config.sequences?.[currentMode]) return config.sequences[currentMode][0]
    return null
  }

  /** 获取当前轮实际发送的 prompt（序列模式取当前步进） */
  function getCurrentPrompt(currentMode) {
    if (config.sequences?.[currentMode]) {
      const sid = sessionID()
      if (!sid) return getPromptText(currentMode)
      const idx = state.seqIndex.get(sid) ?? 0
      const seq = config.sequences[currentMode]
      return seq[idx % seq.length]
    }
    return getPromptText(currentMode)
  }

  /** 根据 mode 判断是否活跃 */
  function isActive(currentMode) {
    return currentMode !== "stop" && !!getPromptText(currentMode)
  }

  /** 获取当前模式的可读任务标签 */
  function getTaskLabel(currentMode) {
    if (currentMode === "ai") return "AI 驱动"
    if (currentMode === "custom") return config.customPrompt.slice(0, 20)
    if (config.sequences?.[currentMode]) {
      const sid = sessionID()
      const idx = sid ? (state.seqIndex.get(sid) ?? 0) : 0
      return `${currentMode} 第${idx + 1}/${config.sequences[currentMode].length}步`
    }
    return currentMode
  }

  /** 向会话发送下一轮提示词 */
  async function autoDrive(event) {
    const currentMode = mode()
    if (!isActive(currentMode)) return

    const { sessionID: sid } = event.properties
    if (!sid) return
    setSessionID(sid)

    const limit = maxTurns()
    const current = state.turns.get(sid) ?? 0

    // 刚完成一轮对话 → toast 通知
    if (current > 0) {
      const limitLabel = limit > 0 ? limit : "∞"
      api.ui.toast({
        message: `🚀 第${current}轮完成 (${current}/${limitLabel}) | ${getTaskLabel(currentMode)}`,
        variant: "info",
      })
    }

    if (limit > 0 && current >= limit) return

    const prompt = getCurrentPrompt(currentMode)
    if (!prompt) return

    try {
      const label = currentMode === "ai" ? "🤖" : `"${prompt.slice(0, 30)}"`
      const limitLabel = limit > 0 ? limit : "∞"
      console.warn(
        `[auto-drive] 🚀 ${current + 1}/${limitLabel} ${label}`,
      )
      await api.client.session.prompt({
        sessionID: sid,
        parts: [{ type: "text", text: prompt }],
      })

      // 发送成功后才计轮次和序列步进
      state.turns.set(sid, current + 1)
      if (config.sequences?.[currentMode]) {
        state.seqIndex.set(sid, (state.seqIndex.get(sid) ?? 0) + 1)
      }
      bumpTurnRev()
    } catch (err) {
      console.error(
        "[auto-drive] ❌",
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** 对当前会话立即执行一次自动驾驶（走 autoDrive 统一逻辑） */
  async function fireImmediate() {
    const route = api.route.current
    if (route.name !== "session") return
    const sessionID = route.params.sessionID
    if (!sessionID) return
    try {
      await autoDrive({ properties: { sessionID } })
    } catch {
      // autoDrive 内部已 try/catch，此处仅防同步异常
    }
  }

  /** 保存当前配置到项目级文件 */
  async function saveConfigFile() {
    const data = {
      mode: config.mode,
      maxTurns: maxTurns(),
      customPrompt: config.customPrompt,
      presets: config.presets,
    }
    if (config.sequences && Object.keys(config.sequences).length > 0) {
      data.sequences = config.sequences
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
      ...(config.sequences && Object.keys(config.sequences).length > 0
        ? [
            {
              title: "─".repeat(20),
              value: "__seq_sep__",
              disabled: true,
              description: "",
            },
            ...Object.entries(config.sequences).map(([name, seq]) => ({
              title: `🔄 ${name}`,
              value: name,
              description: `${seq.length} 步循环`,
            })),
          ]
        : []),
    ]
  }

  /** 显示轮次选择器 */
  function showTurnLimitSelector(chosenMode) {
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.setSize("medium")
    const currentLimit = maxTurns()
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="执行轮次"
        options={[
          { title: "♾️ 无限", value: 0, description: "不限制轮次，持续执行" },
          { title: "1 次", value: 1 },
          { title: "3 次", value: 3 },
          { title: "5 次", value: 5 },
          { title: "10 次", value: 10 },
          { title: "20 次", value: 20 },
          { title: "✏️ 自定义...", value: -1, description: "输入自定义轮次数" },
        ]}
        current={currentLimit}
        onSelect={(option) => {
          api.ui.dialog.clear()
          if (option.value === -1) {
            showCustomTurnLimit(chosenMode)
            return
          }
          setMaxTurns(option.value)
          setMode(chosenMode)
          config.mode = chosenMode
          if (chosenMode !== "stop") setLastMode(chosenMode)
          saveConfigFile()
          fireImmediate()
        }}
      />
    ))
  }

  /** 自定义轮次数输入 */
  function showCustomTurnLimit(chosenMode) {
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="输入轮次数（0 = 无限）"
        placeholder="例如：20"
        value={String(maxTurns())}
        onConfirm={(value) => {
          if (!value.trim()) return
          api.ui.dialog.clear()
          const n = parseInt(value.trim(), 10)
          if (isNaN(n) || n < 0) return
          setMaxTurns(n)
          setMode(chosenMode)
          config.mode = chosenMode
          if (chosenMode !== "stop") setLastMode(chosenMode)
          saveConfigFile()
          fireImmediate()
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
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
          if (option.value === "__sep__" || option.value === "__seq_sep__") {
            api.ui.dialog.clear()
            return
          }
          if (option.value === "stop") {
            api.ui.dialog.clear()
            setMode("stop")
            config.mode = "stop"
            saveConfigFile()
            return
          }
          if (option.value === "custom") {
            api.ui.dialog.clear()
            showCustomPrompt()
            return
          }
          api.ui.dialog.clear()
          showTurnLimitSelector(option.value)
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
          setLastMode("custom")
          saveConfigFile()
          showTurnLimitSelector("custom")
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
        const limit = maxTurns()
        const limitLabel = limit > 0 ? limit : "∞"
        const isSeq = config.sequences?.[currentMode]
        const seqIdx = isSeq ? (sessionID() ? (state.seqIndex.get(sessionID()) ?? 0) : 0) : 0
        const seqLen = isSeq ? config.sequences[currentMode].length : 0

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
                <text fg={theme.text}> 🤖 {getTaskLabel(currentMode)}</text>
              </Show>
              <Show when={currentMode === "custom"}>
                <text fg={theme.textMuted}> "</text>
                <text fg={theme.text}>{config.customPrompt.slice(0, 20)}</text>
                <text fg={theme.textMuted}>"</text>
              </Show>
              <Show when={currentMode !== "ai" && currentMode !== "custom"}>
                <text fg={theme.textMuted}> </text>
                <text fg={theme.text}>{currentMode}</text>
              </Show>

              <Show when={isSeq}>
                <text fg={theme.textMuted}> 第{seqIdx + 1}/{seqLen}步</text>
              </Show>
              <text fg={theme.textMuted}> {sessionTurns}/{limitLabel}</text>
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
    clearInterval(routePoll)
    state.turns.clear()
    state.seqIndex.clear()
  })
}

const plugin = { id: "auto-drive", tui }
export default plugin
