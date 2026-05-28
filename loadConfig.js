import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, dirname } from "path"

import { DEFAULT_PRESETS, DEFAULT_SEQUENCES } from "./prompts.js"

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

/** 从文件读取 JSON，若不存在则返回 null */
export { readJSON }

/** 读取并合并全局 + 项目配置
 *  @returns {Promise<{ merged: object, projectPath: string }>} merged=合并后配置, projectPath=项目级配置文件路径 */
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
    maxTurns: 5,
    ...(global ?? {}),
    ...(project ?? {}),
  }

  // 深合并 presets（避免 project 配置浅覆盖整个预设集合）
  merged.presets = {
    ...DEFAULT_PRESETS,
    ...(global?.presets ?? {}),
    ...(project?.presets ?? {}),
  }

  // 深合并 sequences
  merged.sequences = {
    ...DEFAULT_SEQUENCES,
    ...(global?.sequences ?? {}),
    ...(project?.sequences ?? {}),
  }

  return { merged, projectPath }
}

/** 将配置写入项目级文件 */
export async function saveProjectConfig(path, config) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8")
}
