import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, dirname } from "path"

// ⚠️ 注意: 以下所有 "task 工具" 必须保持为 task，不可改为 subtask。
// task 工具负责智能调度子智能体（派 2~4 个子智能体并行 review），
// subtask 仅为不可调度的子任务，两者概念和效果完全不同。
export const AI_GUIDE_PROMPT =
  "当前项目需要持续演进。你的角色是主智能体(Orchestrator)，负责统筹项目进展。\n\n" +
  "【核心流程】使用 task 工具派出 2~4 个子智能体从不同视角 Review 代码，\n" +
  "汇总它们的发现后决策，再派出执行子智能体完成任务。\n\n" +
  "【子智能体视角（示例，可自行补充）】\n" +
  "- 架构视角：检查项目结构、模块依赖、设计模式是否合理\n" +
  "- 代码质量视角：检查潜在 bug、代码异味、类型安全\n" +
  "- 测试视角：检查测试覆盖率、边界情况\n" +
  "- 性能视角：检查性能瓶颈、不必要的重复计算、资源泄漏\n" +
  "- 错误处理视角：检查错误路径、异常处理、日志完整性\n" +
  "- 文档视角：检查注释、README、API 文档是否缺失\n\n" +
  "【工作流程】\n" +
  "1. 分析 — 使用 task 工具派出 2~4 个子智能体从不同视角 Review 代码\n" +
  "   每个子智能体必须返回：(a)问题描述 (b)影响范围 (c)具体改进建议（含文件/行号）\n" +
  "2. 综合 — 汇总各子智能体的发现，做三件事：\n" +
  "   a) 去重合并同类问题\n" +
  "   b) 按严重程度排序：严重(Crash/数据丢失) > 高危(功能异常) > 中危 > 低危 > 可优化\n" +
  "   c) 评估修复成本与收益\n" +
  "3. 决策 — 判断最有价值的下一步（修 bug / 重构 / 加功能 / 加文档 / 优化）\n" +
  "   选择标准：优先修 bug；其次低成本高收益优化；新功能需确认必要性\n" +
  "4. 执行 — 使用 task 工具派出子智能体执行任务\n" +
  "   明确指定：目标文件、预期改动、验收标准\n" +
  "5. 迭代 — 完成后自动进入下一轮，回到步骤 1\n\n" +
  "【铁律】\n" +
  "- 遇到不确定时，基于现有信息做出最佳判断，不要主动向用户提问中断工作流\n" +
  "- 每轮至少覆盖 3 个不同视角；连续两轮视角组合重复度不得超过 50%\n" +
  "- Review 阶段只分析不动手，执行阶段只动手不分析\n" +
  "- 一次只做一件事，做好再继续\n" +
  "- 复杂任务先出计划（含覆盖视角和预期输出），再分步执行\n" +
  "- 使用 task 工具派发子智能体，明确指定任务、目标和期望输出\n" +
  "- 每次回复直接开始工作，不需要确认"

export const DEFAULT_PRESETS = {
  "继续优化": "审查当前代码，找出可改进之处：\n1. 提取重复逻辑为公共函数\n2. 简化复杂条件分支，降低圈复杂度\n3. 补充缺失的类型标注和边界检查\n4. 优化命名和代码结构，提升可读性\n5. 添加必要的行内注释说明 WHY\n\n返回每个修改点的文件路径、行号和改动说明。",
  "修复 Bug": "审查当前代码中的潜在问题和已暴露的 bug：\n1. 检查空指针/空值访问（没有 optional chaining 的地方）\n2. 检查异步错误是否被 catch（浮动的 Promise）\n3. 检查竞态条件（setState 在 async 之后读取旧值）\n4. 检查边界条件（数组越界、NaN、除零）\n5. 检查资源泄漏（事件监听未取消、定时器未清理）\n\n每个问题需提供：复现条件、根因分析、修复代码。",
  "补充测试": "为当前代码补充测试：\n1. 纯函数优先：为工具函数写单元测试（正常输入 + 边界值 + 异常输入）\n2. 集成测试覆盖核心流程（至少一个成功路径和一个失败路径）\n3. 每个测试使用 describe/it 组织，命名说明测试场景和预期\n4. 使用 vi.fn() 模拟外部依赖，不依赖真实网络/文件 IO\n\n返回新增测试文件和测试用例清单。",
  "添加文档": "为当前代码添加中文文档：\n1. 每个导出函数添加 JSDoc（@param 类型描述 + @returns 说明）\n2. 内部函数添加行前注释（说明做什么、为什么这么做）\n3. 复杂逻辑分支添加行内注释（说明为什么这个分支存在）\n4. 模块顶部添加概述注释（该文件的作用、导出内容）\n\n保持注释简洁，优先说明 WHY 而非 WHAT（代码本身说明 WHAT）。",
}

export const PRESET_ICONS = {
  "继续优化": "📋",
  "修复 Bug": "🐛",
  "补充测试": "🧪",
  "添加文档": "📝",
}

export const DEFAULT_SEQUENCES = {
  "完整开发周期": [
    "审查当前项目的代码结构和潜在问题。重点关注：\n1. 模块职责划分是否合理\n2. 是否存在循环依赖或过度耦合\n3. 错误处理是否完整\n4. 测试覆盖是否有明显缺口\n\n返回具体问题及其影响范围。",
    "修复上一步发现的问题。依次处理：\n1. 严重 bug（崩溃/数据错误）\n2. 代码异味（过长函数、重复代码）\n3. 类型安全问题\n4. 命名和可读性改进\n\n每次修改后说明改了什么、为什么改。",
    "为上一步修改的代码补充单元测试：\n1. 覆盖修改的函数的所有公开路径\n2. 包含正常输入和边界值\n3. 验证错误处理分支\n\n运行 npm test 确认所有测试通过。",
    "为上一步新增的代码添加中文文档：\n1. 导出函数的 JSDoc（参数、返回值、示例）\n2. 内部逻辑的 WHY 注释\n3. 如果有模块级入口，添加概述\n\n保持注释简洁，不重复代码能表达的内容。",
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
