# Auto-Drive 多模式配置实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Auto-Drive 插件从简单的 toggle on/off 升级为支持停止/自定义/AI驱动/预设四种模式的配置系统。

**Architecture:** 配置读取按 全局→项目→options 三层合并。`mode` 信号驱动状态栏响应式更新。`/auto-drive` 命令改为 DialogSelect 菜单选择模式。`session.idle` 事件处理器按当前模式分发不同 prompt。

**Tech Stack:** OpenCode TUI Plugin API, SolidJS (`solid-js`), OpenTUI (`@opentui/solid`), Node `fs/promises`

---

### Task 1: 配置加载与合并

**Files:**
- Modify: `tui.jsx` — 新增配置读取逻辑

**配置格式** (`~/.config/opencode/auto-drive.json` 或 `.opencode/plugins/auto-drive.json`)：
```json
{
  "mode": "stop",
  "customPrompt": "",
  "presets": {
    "继续优化": "继续优化当前功能，添加必要的注释和类型完善",
    "修复 Bug": "检查当前代码中的潜在问题并修复",
    "补充测试": "为当前代码添加单元测试和集成测试",
    "添加文档": "为当前代码添加中文文档注释"
  }
}
```

**mode 可选值**: `"stop"` | `"ai"` | `"custom"` | 预设的 key（如 `"继续优化"`）

- [ ] **Step 1: 添加配置读取依赖和常量**

在 `tui.jsx` 顶部添加导入：
```jsx
/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, Show } from "solid-js"
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
```

- [ ] **Step 2: 实现配置加载函数**

```jsx
/** 从文件读取 JSON，若不存在则返回 null */
async function readJSON(path) {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 返回 { global, project, merged } 三份数据 */
async function loadConfig(projectDir) {
  const globalPath = join(homedir(), ".config", "opencode", "auto-drive.json")
  const projectPath = join(projectDir, ".opencode", "plugins", "auto-drive.json")

  const [global, project] = await Promise.all([
    readJSON(globalPath),
    readJSON(projectPath),
  ])

  // 合并：先 global，后 project 逐字段覆盖
  const merged = {
    mode: "stop",
    customPrompt: "",
    presets: { ...DEFAULT_PRESETS },
    ...(global ?? {}),
    ...(project ?? {}),
  }

  return { global, project, merged, globalPath, projectPath }
}
```

- [ ] **Step 3: 实现配置保存函数**

```jsx
/** 将配置写入项目级文件 */
async function saveProjectConfig(path, config) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8")
}
```

- [ ] **Step 4: 集成到 tui 函数开头**

```jsx
const tui = async (api, options) => {
  const projectDir = api.state.path.directory
  const { global: _, project: __, merged: config, projectPath } =
    await loadConfig(projectDir)

  // Options 最高优先级覆盖
  if (options?.mode) config.mode = options.mode
  if (options?.customPrompt) config.customPrompt = options.customPrompt
  if (options?.presets) config.presets = { ...config.presets, ...options.presets }

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
    return currentMode !== "stop" && getPromptText(currentMode) !== null
  }

  // ... rest of plugin
}
```

- [ ] **Step 5: 验证 — 检查文件结构**

```bash
ls -la tui.jsx
```

Expected: `tui.jsx` exists and has the new imports and config functions.

- [ ] **Step 6: Commit**

```bash
git add tui.jsx
git commit -m "feat: 配置加载与合并逻辑"
```

---

### Task 2: 模式选择菜单

**Files:**
- Modify: `tui.jsx` — 替换 toggle 命令为 DialogSelect 菜单

- [ ] **Step 1: 构建菜单选项函数**

```jsx
/** 构建模式选择菜单选项 */
function buildMenuOptions(presets) {
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
    ...Object.entries(presets).map(([name, desc]) => ({
      title: `📋 ${name}`,
      value: name,
      description: desc,
    })),
  ]
}
```

- [ ] **Step 2: 替换 toggle 为 showMenu**

```jsx
/** 显示模式选择菜单 */
function showMenu() {
  const DialogSelect = api.ui.DialogSelect
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Auto-Drive 自动驾驶"
      options={buildMenuOptions(config.presets)}
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
```

Wait — `DialogSelect` returns `option` where `option` is `TuiDialogSelectOption`. Looking at the type:

```ts
export type TuiDialogSelectOption<Value = unknown> = {
  title: string
  value: Value
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  onSelect?: () => void
}
```

And the `onSelect` callback for `DialogSelect` props is:
```ts
onSelect?: (option: TuiDialogSelectOption<Value>) => void
```

So `option.value` gives the value. Good.

```jsx
  // 替换原有的 toggle 命令 ↓
  // ── 注册 /auto-drive 菜单命令 ──
  const unregCmd = api.command.register(() => [
    {
      title: `自动驾驶: ${mode() === "stop" ? "已停止" : `运行中 [${mode()}]`}`,
      value: "auto-drive-menu",
      description: "选择自动驾驶模式",
      category: "auto-drive",
      slash: { name: "auto-drive", aliases: ["ad"] },
      onSelect: showMenu,
    },
  ])
```

- [ ] **Step 3: 实现自定义提示词输入弹窗**

```jsx
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
```

- [ ] **Step 4: 实现 saveConfigFile 辅助函数**

```jsx
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
```

- [ ] **Step 5: Commit**

```bash
git add tui.jsx
git commit -m "feat: 模式选择菜单与自定义输入"
```

---

### Task 3: 自动驾驶分发逻辑

**Files:**
- Modify: `tui.jsx` — 按 mode 分发 autoDrive 行为

- [ ] **Step 1: 重写 autoDrive 函数**

```jsx
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
```

- [ ] **Step 2: 更新状态初始化**

原来的 `state.enabled` 和 `state.prompt` 不再需要。用 `config` 对象替代。同时保留 `maxTurns` 和 `turns`：

```jsx
const state = {
  maxTurns: options?.maxTurns ?? 5,
  turns: new Map(),
}
```

- [ ] **Step 3: 更新 computeTurnCount 函数（保持不变，已独立）**

```jsx
/** 计算所有会话的累计轮数 */
function computeTurnCount() {
  return Array.from(state.turns.values()).reduce((a, b) => a + b, 0)
}
```

- [ ] **Step 4: Commit**

```bash
git add tui.jsx
git commit -m "feat: 按 mode 分发 autoDrive 行为"
```

---

### Task 4: 状态栏响应式更新

**Files:**
- Modify: `tui.jsx` — app_bottom 插槽显示当前模式

- [ ] **Step 1: 重写 app_bottom 插槽**

```jsx
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

      // AI 驱动模式
      if (currentMode === "ai") {
        return (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.primary}>🚀 AD</text>
            <text fg={theme.text}> 🤖</text>
          </box>
        )
      }

      // 自定义模式
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

      // 预设模式 — currentMode 是预设 key
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
```

- [ ] **Step 2: Commit**

```bash
git add tui.jsx
git commit -m "feat: 状态栏按模式显示"
```

---

### Task 5: 清理旧代码与最终验证

**Files:**
- Modify: `tui.jsx` — 移除废弃的 `enabled` 信号和 `toggle` 函数

- [ ] **Step 1: 移除废弃代码**

从 `tui.jsx` 中移除：
- `const [enabled, setEnabled] = createSignal(state.enabled)`（已替换为 `mode` 信号）
- `function toggle()`（已替换为 `showMenu`）
- `state.enabled`（已替换为 `config.mode`）
- `state.prompt`（已替换为动态 `getPromptText()`）

- [ ] **Step 2: 更新更新命令描述中的变量引用**

命令标题从 `state.enabled` 改为：
```jsx
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
```

- [ ] **Step 3: 验证完整文件**

读取最终 `tui.jsx` 检查：
- 配置加载正常
- 菜单可以选择模式
- AI 驱动正确发送引导 prompt
- 自定义模式正确弹输入框
- 状态栏随 mode 信号更新

```bash
cat tui.jsx | wc -l
```

预期约 220-250 行。

- [ ] **Step 4: 最终提交**

```bash
git add tui.jsx
git commit -m "refactor: 清理废弃的 toggle 逻辑"
```

---

### 完整文件概览

最终 `tui.jsx` 结构：
```
导入 (solid-js, fs/promises, os, path)
常量 (AI_GUIDE_PROMPT, DEFAULT_PRESETS)
辅助函数 (readJSON, loadConfig, saveProjectConfig)

tui 函数:
  配置加载 (loadConfig → 合并到 config)
  信号创建 (mode, turnCount)
  辅助函数 (getPromptText, isActive, computeTurnCount)
  buildMenuOptions
  showMenu / showCustomPrompt
  saveConfigFile
  autoDrive (按 mode 分发)
  命令注册 (/auto-drive → showMenu)
  事件监听 (session.idle → autoDrive)
  插槽注册 (app_bottom → 状态栏)
  生命周期清理
```

