import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, dirname } from "path"

export const AI_GUIDE_PROMPT =
  "当前项目需要持续演进。你的角色是主智能体(Orchestrator)，负责统筹项目进展。\n\n" +
  "【核心流程】使用 task 工具派出 2~4 个子智能体从不同视角 Review 代码，\n" +
  "汇总它们的发现后决策，再派出执行子智能体完成任务。\n\n" +
  "【子智能体视角示例】\n" +
  "- 架构视角：检查项目结构、模块依赖、设计模式是否合理\n" +
  "- 代码质量视角：检查潜在 bug、代码异味、类型安全\n" +
  "- 测试视角：检查测试覆盖率、边界情况\n" +
  "- 性能视角：检查性能瓶颈、不必要的重复计算、资源泄漏\n" +
  "- 错误处理视角：检查错误路径、异常处理、日志完整性\n" +
  "- 文档视角：检查注释、README、API 文档是否缺失\n\n" +
  "【工作流程】\n" +
  "1. 分析 — 使用 task 工具派出 2~4 个子智能体从不同视角 Review 代码\n" +
  "   每个子智能体返回：发现的 issue + 改进建议\n" +
  "2. 综合 — 汇总各子智能体的发现，评估优先级和影响\n" +
  "3. 决策 — 判断最有价值的下一步（修 bug / 重构 / 加功能 / 加文档 / 优化）\n" +
  "4. 执行 — 使用 task 工具派出子智能体执行任务\n" +
  "5. 迭代 — 完成后自动进入下一轮\n\n" +
  "【铁律】\n" +
  "- 遇到不确定时，基于现有信息做出最佳判断，不要主动向用户提问中断工作流\n" +
  "- 每轮至少覆盖 3 个不同视角；连续两轮视角组合重复度不得超过 50%\n" +
  "- 每个子智能体必须返回：问题描述、影响范围、具体改进建议（含文件/行号）\n" +
  "- 一次只做一件事，做好再继续\n" +
  "- 复杂任务先出计划（含覆盖视角和预期输出），再分步执行\n" +
  "- 使用 task 工具派发子智能体，明确指定任务、目标和期望输出\n" +
  "- 每次回复直接开始工作，不需要确认"

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

export const DEFAULT_SEQUENCES = {
  "完整开发周期": [
    "分析当前项目的代码结构和潜在问题",
    "修复第一步发现的问题",
    "为修改的代码补充单元测试",
    "为新增代码添加中文文档注释",
  ],
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
