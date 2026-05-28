/**
 * OpenCode 自动驾驶插件
 *
 * 监听 session.idle，AI 回复结束后自动发送下一轮 prompt。
 *
 * 使用方式：
 *   Ctrl+P → auto-drive → Enter    切换开关
 *   或直接在输入框打 /auto-drive     切换开关
 *
 * 预设配置（tui.json）：
 *   "pluginConfig": {
 *     "auto-drive": { "enabled": true, "maxTurns": 10, "prompt": "继续优化" }
 *   }
 */

/** @type {import('@opencode-ai/plugin/tui').TuiPlugin} */
const tui = async (api, options) => {
  const state = {
    enabled: options?.enabled ?? false,
    maxTurns: options?.maxTurns ?? 5,
    prompt: options?.prompt ?? "继续",
    /** sessionID -> 已自动轮数 */
    turns: new Map(),
  }

  /** 向会话发送下一轮提示词 */
  async function autoDrive(event) {
    if (!state.enabled) return

    const { sessionID } = event.properties
    if (!sessionID) return

    const current = state.turns.get(sessionID) ?? 0
    if (current >= state.maxTurns) return

    state.turns.set(sessionID, current + 1)

    try {
      console.warn(
        `[auto-drive] 🚀 ${current + 1}/${state.maxTurns} "${state.prompt}"`,
      )
      await api.client.session.prompt({
        sessionID,
        parts: [{ type: "text", text: state.prompt }],
      })
    } catch (err) {
      console.error(
        "[auto-drive] ❌",
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** 切换开关 */
  function toggle() {
    state.enabled = !state.enabled
    if (!state.enabled) state.turns.clear()
    api.ui.toast({
      message: state.enabled
        ? "🚀 自动驾驶已启用"
        : "⏸️ 自动驾驶已禁用",
      variant: state.enabled ? "success" : "warning",
    })
  }

  // ── 注册 Ctrl+P / /auto-drive 命令 ──
  const unregCmd = api.command.register(() => [
    {
      title: `自动驾驶: ${state.enabled ? "⏸️ 禁用" : "🚀 启用"}`,
      value: "auto-drive-toggle",
      description: state.enabled
        ? `已启用 · ${state.maxTurns} 轮 · "${state.prompt}"`
        : "点击启用，AI 回复后自动继续",
      category: "auto-drive",
      slash: { name: "auto-drive", aliases: ["ad"] },
      onSelect: toggle,
    },
  ])

  // ── 监听会话空闲 ──
  const unsubEvent = api.event.on("session.idle", autoDrive)

  // ── 清理 ──
  api.lifecycle.onDispose(() => {
    unregCmd()
    unsubEvent()
    state.turns.clear()
  })
}

const plugin = { id: "auto-drive", tui }
export default plugin
