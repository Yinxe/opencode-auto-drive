/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import {
  AI_GUIDE_PROMPT,
  loadConfig,
  saveProjectConfig,
  readJSON,
} from "./loadConfig.js"
import {
  getCurrentPrompt,
  isActive,
  getTaskLabel,
  buildMenuOptions,
} from "./tui-utils.js"

/**
 * OpenCode 自动驾驶插件
 *
 * 监听 session.idle，AI 回复结束后自动发送下一轮 prompt。
 * 支持停止 / 自定义 / AI 驱动 / 预设 / 序列五种模式。
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

  let maxTurnsDefault = options?.maxTurns ?? config.maxTurns ?? 5
  // 校验 maxTurns：必须是 >=0 的数字
  if (typeof maxTurnsDefault !== "number" || maxTurnsDefault < 0 || !Number.isFinite(maxTurnsDefault)) {
    console.warn(`[auto-drive] maxTurns 配置无效 (${maxTurnsDefault}), 回退到 5`)
    try { api.ui.toast({ message: `⚠️ maxTurns 配置无效，已回退到 5`, variant: "warning" }) } catch {}
    maxTurnsDefault = 5
  }

  /** 并发锁：防止同一 session 在上一轮完成前触发下一轮 */
  const pendingLocks = new Set()

  /** 失败重试配置 */
  const RETRY_BASE_DELAY_MS = 500

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
    api.route?.current?.name === "session"
      ? api.route.current?.params?.sessionID ?? null
      : null,
  )
  const [turnRev, bumpTurnRev] = createSignal(0) // state.turns 是普通 Map，SolidJS 不追踪变异，bump 此信号强制状态栏重渲染

  // ── 模式注册表 ──
  /** 集中管理各种模式的元数据和行为 */
  const modeMeta = {}
  function registerMode(name, meta) { modeMeta[name] = meta }

  registerMode("stop", { type: "stop", getPrompt: () => null, label: "停止" })
  registerMode("custom", {
    type: "custom",
    getPrompt: () => config.customPrompt,
    label: "自定义",
  })
  registerMode("ai", {
    type: "ai",
    getPrompt: () => AI_GUIDE_PROMPT,
    label: "AI 驱动",
  })

  for (const [name, prompt] of Object.entries(config.presets ?? {})) {
    if (modeMeta[name]) {
      console.warn(`[auto-drive] 预设名称 "${name}" 与内置模式冲突，已忽略`)
      try { api.ui.toast({ message: `⚠️ 预设 "${name}" 与内置模式冲突，已忽略`, variant: "warning" }) } catch {}
      continue
    }
    registerMode(name, { type: "preset", label: name, getPrompt: () => prompt })
  }
  for (const [name, seq] of Object.entries(config.sequences ?? {})) {
    if (modeMeta[name]) {
      console.warn(`[auto-drive] 序列名称 "${name}" 与内置模式冲突，已忽略`)
      try { api.ui.toast({ message: `⚠️ 序列 "${name}" 与内置模式冲突，已忽略`, variant: "warning" }) } catch {}
      continue
    }
    registerMode(name, {
      type: "sequence",
      label: name,
      getPrompt: () => seq[0],
      sequence: seq,
    })
  }

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

  // 定期清理已关闭 session 的残留数据（防止内存泄漏）
  const staleCleanup = setInterval(() => {
    for (const sid of state.turns.keys()) {
      if (!api.state.session.get(sid)) {
        state.turns.delete(sid)
        state.seqIndex.delete(sid)
      }
    }
  }, 60000)

  /** 获取当前 session 的轮次（用于状态栏响应式显示） */
  function getSessionTurns() {
    turnRev() // 每次 autoDrive 递增，强制重渲染
    const sid = sessionID()
    if (!sid) return 0
    return state.turns.get(sid) ?? 0
  }

  /** 向会话发送下一轮提示词。返回 true=成功 false=失败 null=跳过 */
  async function autoDrive(event) {
    const sid = event?.properties?.sessionID
    if (!sid || pendingLocks.has(sid)) return null

    // 跳过子智能体（subtask）会话，只驱动主会话
    const session = api.state.session.get(sid)
    if (session?.parentID) return null

    pendingLocks.add(sid)

    try {
      const currentMode = mode()
      if (!isActive(modeMeta, currentMode)) return null

      // 只在用户当前就在该会话中时才更新 sessionID，避免状态栏闪烁
      if (api.route?.current?.params?.sessionID === sid) setSessionID(sid)

      const limit = maxTurns()
      const current = state.turns.get(sid) ?? 0

      if (limit > 0 && current >= limit) return null

      const prompt = getCurrentPrompt(modeMeta, currentMode, sessionID(), state.seqIndex)
      if (!prompt) return null

      const label = modeMeta[currentMode]?.type === "ai" ? "🤖" : `"${prompt.slice(0, 30)}"`
      const limitLabel = limit > 0 ? limit : "∞"
      console.log(`[auto-drive] 🚀 ${current + 1}/${limitLabel} ${label}`)
      // 内层重试：处理瞬时网络错误，session.idle 和 fireImmediate 两条路径都受益
      const INNER_MAX_ATTEMPTS = 3 // 首次 + 最多 2 次重试
      let promptErr
      for (let attempt = 0; attempt < INNER_MAX_ATTEMPTS; attempt++) {
        try {
          await api.client.session.prompt({
            sessionID: sid,
            parts: [{ type: "text", text: prompt }],
          })
          promptErr = null
          break
        } catch (err) {
          promptErr = err
          if (attempt < INNER_MAX_ATTEMPTS - 1) {
            const delay = RETRY_BASE_DELAY_MS * (attempt + 1)
            console.log(`[auto-drive] ⏳ prompt 重试 ${attempt + 1}/${INNER_MAX_ATTEMPTS - 1} (${delay}ms)`)
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      }
      if (promptErr) throw promptErr

      // 发送成功后才计轮次和序列步进
      state.turns.set(sid, current + 1)
      if (modeMeta[currentMode]?.type === "sequence") {
        const prevIdx = state.seqIndex.get(sid) ?? 0
        state.seqIndex.set(sid, prevIdx + 1)
        // toast 使用步进前的索引（已完成的那一步）
        if (current > 0) {
          const seq = modeMeta[currentMode].sequence
          api.ui.toast({
            message: `🚀 第${current + 1}轮完成 (${current + 1}/${limitLabel}) | ${currentMode} 第${prevIdx + 1}/${seq.length}步`,
            variant: "info",
          })
        }
      } else if (current > 0) {
        api.ui.toast({
          message: `🚀 第${current + 1}轮完成 (${current + 1}/${limitLabel}) | ${getTaskLabel(modeMeta, config.customPrompt, currentMode, sessionID(), state.seqIndex)}`,
          variant: "info",
        })
      }
      bumpTurnRev(prev => prev + 1)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : err
      console.error("[auto-drive] ❌", msg)
      try { api.ui.toast({ message: `😵 自动驱动发送失败: ${msg}`, variant: "error" }) } catch {}
      return false
    } finally {
      pendingLocks.delete(sid)
    }
  }

  /** 对当前会话立即执行一次自动驾驶（走 autoDrive 统一逻辑） */
  async function fireImmediate() {
    const route = api.route.current
    if (route.name !== "session") {
      console.log(`[auto-drive] fireImmediate: 不在会话中, route=${route.name}`)
      return
    }
    const sid = route.params.sessionID
    if (!sid) {
      console.log("[auto-drive] fireImmediate: 无 sessionID")
      return
    }
    console.log(`[auto-drive] fireImmediate: session=${sid} mode=${mode()}`)
    // autoDrive 已有内层重试处理网络错误，外层直接调用即可
    await autoDrive({ properties: { sessionID: sid } })
  }

  /** 保存当前配置到项目级文件（保持未知字段不丢失） */
  async function saveConfigFile() {
    // 读取已有配置，保留未知字段（补丁合并）
    const existing = (await readJSON(projectPath)) ?? {}
    const data = {
      ...existing,
      mode: mode(),
      maxTurns: maxTurns(),
      customPrompt: config.customPrompt,
      presets: config.presets,
    }
    if (config.sequences && Object.keys(config.sequences).length > 0) {
      data.sequences = config.sequences
    }
    // 写回时自动删除 undefined 字段
    for (const k of Object.keys(data)) {
      if (data[k] === undefined) delete data[k]
    }
    await saveProjectConfig(projectPath, data).catch((err) => {
      console.error("[auto-drive] 配置保存失败:", err)
      try { api.ui.toast({ message: `配置保存失败: ${err.message}`, variant: "error" }) } catch {}
    })
  }

  /** 统一提交模式切换：设置轮次、模式、保存并触发 */
  function commitMode(modeName, turnLimit) {
    setMaxTurns(turnLimit)
    setMode(modeName)
    if (modeName !== "stop") setLastMode(modeName)
    saveConfigFile()
    // 如果选择的模式无有效提示词，提醒用户
    if (!isActive(modeMeta, modeName)) {
      try { api.ui.toast({ message: `⚠️ 模式 "${modeName}" 无有效提示词，自动驾驶不会触发`, variant: "warning" }) } catch {}
    }
    fireImmediate()
  }

  /** 快速切换：活跃→停止 / 停止→恢复上次模式 */
  function quickToggle() {
    if (mode() !== "stop") {
      setLastMode(mode())
      setMode("stop")
    } else if (lastMode()) {
      const previous = lastMode()
      setMode(previous)
      saveConfigFile()
      fireImmediate()
      return
    } else {
      // 从未启用过，默认用第一个预设
      const first = Object.keys(config.presets)[0]
      if (first) {
        setMode(first)
        setLastMode(first)
        saveConfigFile()
        fireImmediate()
        return
      }
    }
    saveConfigFile()
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
          commitMode(chosenMode, option.value)
        }}
        onCancel={() => api.ui.dialog.clear()}
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
          commitMode(chosenMode, n)
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
        options={buildMenuOptions(config.presets, config.sequences)}
        current={mode()}
        onSelect={(option) => {
          if (option.disabled) {
            api.ui.dialog.clear()
            return
          }
          if (option.value === "stop") {
            api.ui.dialog.clear()
            setMode("stop")
            saveConfigFile()
            return
          }
          if (option.value === "custom") {
            api.ui.dialog.clear()
            showCustomPrompt()
            return
          }
          if (option.value === "__config__") {
            api.ui.dialog.clear()
            showConfig()
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
          showTurnLimitSelector("custom")
        }}
        onCancel={() => {
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  /** 显示当前合并后的配置信息 */
  function showConfig() {
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.setSize("large")
    const limit = maxTurns()
    const limitLabel = limit > 0 ? limit : "∞"
    const lines = [
      `模式: ${mode() === "stop" ? "⏸" : "🚀"} ${mode()}`,
      `轮次: ${getSessionTurns()}/${limitLabel}`,
      `自定义提示词: ${(config.customPrompt || "(未设置)").slice(0, 80)}`,
      ``,
      `预设 (${Object.keys(config.presets ?? {}).length}):`,
      ...Object.entries(config.presets ?? {}).map(
        ([k, v]) => `  ${k}: "${String(v).slice(0, 60)}"`,
      ),
      ``,
      `序列 (${Object.keys(config.sequences ?? {}).length}):`,
      ...Object.entries(config.sequences ?? {}).map(
        ([k, v]) => `  ${k}: ${Array.isArray(v) ? `${v.length} 步循环` : "?"}`,
      ),
      ``,
      `配置优先级: 全局 → 项目 → 插件选项`,
    ].join("\n")

    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Auto-Drive 配置"
        options={[
          { title: lines, value: "info", disabled: true },
          { title: "关闭", value: "close" },
        ]}
        onSelect={(opt) => opt.value === "close" && api.ui.dialog.clear()}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  // ── 注册命令 ──
  let unregCmd = () => {}
  unregCmd = api.command.register(() => [
    {
      title: `Auto-Drive: ${mode() === "stop" ? "⏸ 已停止" : `🚀 ${mode()}`}`,
      value: "auto-drive-menu",
      description: `当前模式: ${mode()}`,
      category: "auto-drive",
      slash: { name: "auto-drive", aliases: ["ad"] },
      onSelect: showMenu,
    },
    {
      title: "Auto-Drive: 查看配置",
      value: "auto-drive-config",
      description: "显示当前合并后的配置（全局+项目+插件选项）",
      category: "auto-drive",
      slash: { name: "auto-drive-config", aliases: ["adc"] },
      onSelect: showConfig,
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
  let unsubEvent = () => {}
  unsubEvent = api.event.on("session.idle", autoDrive)

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
        return (
          <box flexDirection="row" paddingLeft={1} paddingRight={1}>
            <Show
              when={isActive(modeMeta, currentMode)}
              fallback={
                <text fg={theme.textMuted}>
                  ⏸ AD{lastMode() ? ` [${lastMode()}]` : ""}
                </text>
              }
            >
              <text fg={theme.primary}>🚀 AD</text>
              <text fg={theme.textMuted}> </text>
              <text fg={theme.text}>{getTaskLabel(modeMeta, config.customPrompt, currentMode, sessionID(), state.seqIndex)}</text>
              <text fg={theme.textMuted}> {sessionTurns}/{limitLabel}</text>
            </Show>
          </box>
        )
      },
    },
  })

  // ── 启动通知（测试环境下不显示避免干扰断言） ──
  if (typeof process === "undefined" || process.env?.NODE_ENV !== "test") {
    try {
      api.ui.toast({ message: `🚀 Auto-Drive 已就绪 (${mode() === "stop" ? "⏸ 已停止" : `🚀 ${mode()}`}) — /auto-drive 打开菜单`, variant: "info" })
    } catch {}
  }

  // ── 清理 ──
  api.lifecycle.onDispose(() => {
    unregCmd?.()
    unsubEvent?.()
    clearInterval(routePoll)
    clearInterval(staleCleanup)
    state.turns.clear()
    state.seqIndex.clear()
    pendingLocks.clear()
  })

  // 测试用导出：在测试环境中将内部函数绑定到 plugin 对象
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
    Object.assign(plugin, { autoDrive, saveConfigFile, quickToggle, fireImmediate, commitMode })
  }
}

const plugin = { id: "auto-drive", tui }
export default plugin
