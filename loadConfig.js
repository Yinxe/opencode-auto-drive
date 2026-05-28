import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, dirname } from "path"

export const AI_GUIDE_PROMPT =
  "基于当前项目和对话上下文，决定下一步最有价值的事。" +
  "可以改 bug、重构、加新功能、加文档——完全由你判断。先输出计划再执行。"

export const DEFAULT_PRESETS = {
  "继续优化": "继续优化当前功能，添加必要的注释和类型完善",
  "修复 Bug": "检查当前代码中的潜在问题并修复",
  "补充测试": "为当前代码添加单元测试和集成测试",
  "添加文档": "为当前代码添加中文文档注释",
}

export const PRESET_ICONS = {
  "继续优化": "📋",
  "修复 Bug": "🐛",
  "补充测试": "🧪",
  "添加文档": "📝",
}

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

/** 读取并合并全局 + 项目配置 */
export async function loadConfig(projectDir) {
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

  // 深合并 presets（避免 project 配置浅覆盖整个预设集合）
  merged.presets = {
    ...DEFAULT_PRESETS,
    ...(global?.presets ?? {}),
    ...(project?.presets ?? {}),
  }

  return { merged, projectPath }
}

/** 将配置写入项目级文件 */
export async function saveProjectConfig(path, config) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8")
}
