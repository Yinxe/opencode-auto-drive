import { PRESET_ICONS } from "./loadConfig.js"

/** 获取当前轮实际发送的 prompt（序列模式取当前步进） */
export function getCurrentPrompt(modeMeta, currentMode, sessionID, seqIndex) {
  const meta = modeMeta[currentMode]
  if (!meta) return null
  if (meta.type === "sequence") {
    if (!sessionID || meta.sequence.length === 0) return meta.getPrompt()
    const idx = seqIndex.get(sessionID) ?? 0
    return meta.sequence[idx % meta.sequence.length]
  }
  return meta.getPrompt()
}

/** 根据 mode 判断是否活跃 */
export function isActive(modeMeta, currentMode) {
  const meta = modeMeta[currentMode]
  return !!meta && meta.type !== "stop" && !!meta.getPrompt?.()
}

/** 获取当前模式的可读任务标签 */
export function getTaskLabel(modeMeta, customPrompt, currentMode, sessionID, seqIndex) {
  const meta = modeMeta[currentMode]
  if (!meta) return currentMode
  if (meta.type === "custom") return (customPrompt ?? "").slice(0, 20)
  if (meta.type === "sequence") {
    const idx = sessionID ? (seqIndex.get(sessionID) ?? 0) : 0
    return `${currentMode} 第${idx + 1}/${meta.sequence.length}步`
  }
  return meta.label
}

/** 构建模式选择菜单选项 */
export function buildMenuOptions(presets, sequences) {
  return [
    { title: "⏸ 停止", value: "stop", description: "关闭自动驾驶" },
    { title: "✏️ 自定义", value: "custom", description: "输入自定义提示词" },
    { title: "🤖 AI 驱动", value: "ai", description: "AI 自主决定下一步方向" },
    { title: "─".repeat(20), value: "__sep__", disabled: true, description: "" },
    ...Object.entries(presets ?? {}).map(([name, desc]) => ({
      title: `${PRESET_ICONS[name] ?? "📋"} ${name}`,
      value: name,
      description: desc,
    })),
    ...(sequences && Object.keys(sequences).length > 0
      ? [
          { title: "─".repeat(20), value: "__seq_sep__", disabled: true, description: "" },
          ...Object.entries(sequences)
            .filter(([, seq]) => seq.length > 0)
            .map(([name, seq]) => ({
              title: `🔄 ${name}`,
              value: name,
              description: `${seq.length} 步循环`,
            })),
        ]
      : []),
    { title: "─".repeat(20), value: "__cfg_sep__", disabled: true, description: "" },
    { title: "📋 查看配置", value: "__config__", description: "显示当前合并后的配置信息" },
  ]
}
