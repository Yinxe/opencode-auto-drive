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
  "继续优化": "持续审查代码，每次找出一到两个最值得改进的点。\n优先关注：\n1. 上轮引入的代码质量问题（新代码更容易有坏味道）\n2. 仍存在的重复逻辑或过长函数\n3. 可简化的条件分支或类型不安全的地方\n4. 缺少边界检查或错误处理的路径\n\n每次只改一个小点，改动量不超过 30 行。说明改了什么、为什么这样改更优。",
  "修复 Bug": "审查当前代码中的潜在问题，每次聚焦一类问题：\n交替检查以下维度（按顺序轮换）：\n1. 空值安全：optional chaining、默认值、null 判断\n2. 异步安全：浮动的 Promise、catch 缺失、竞态条件\n3. 边界条件：数组越界、NaN 传播、除零、无限循环\n4. 资源管理：事件监听取消、定时器清理、缓存失效\n\n每轮最多修复 2 个问题，提供根因分析和修复代码。",
  "补充测试": "查看当前测试覆盖缺口，每次补充 2~3 个测试。\n优先覆盖：\n1. 最近修改的代码（确保新逻辑有测试保护）\n2. 上轮未覆盖的边界分支（if/else、try/catch、switch）\n3. 错误处理路径（异常输入、API 失败、超时场景）\n\n每个测试包含：正常输入 + 一个边界值。运行 npm test 确认通过。",
  "添加文档": "检查当前代码的文档缺口，每次补充一个模块的注释。\n按优先级：\n1. 最近新增或修改的导出函数（补齐 JSDoc）\n2. 缺少 WHY 注释的复杂逻辑块\n3. 缺少概述注释的模块顶部\n\n保持简洁，不重复代码已表达的内容。一轮只改一个文件。",
  "新增功能": "当前项目需要扩展功能。每次增量开发一个功能点。\n\n上一轮可能已经实现了一些功能，本轮基于当前状态继续。\n\n工作方式：\n1. 先 review 当前代码结构，确认下一个功能点是什么\n2. 设计方案：确定接口签名、数据结构、模块归属\n3. 实现代码：从接口/模型层开始，逐步到 UI/API 层\n4. 顺带为新增代码补充测试和注释\n\n每轮专注于一个完整的功能增量（可独立交付的一小块）。\n如果项目已有待办列表或已知需求，优先实现它们。",
  "智能迭代": "每轮迭代 autonomously 完成以下循环：\n\n【分析】派出多 Agent 从不同视角审查当前代码：\n- 架构：模块划分、依赖关系、设计模式\n- 代码质量：潜在 bug、重复代码、命名、类型安全\n- 测试覆盖：缺口、边界情况\n- 文档完整性：JSDoc、注释、README\n- 性能/安全性：瓶颈、泄漏、注入风险\n\n【决策】基于审查结果自主判断本轮最有价值的工作：\n优先级：\n1. 严重 bug（崩溃/数据错误）→ 立即修复\n2. 高危问题（功能异常）→ 修复\n3. 低成本高收益优化 → 执行\n4. 新功能开发 → 如有必要\n\n【执行】使用 task 工具派出执行子智能体：\n- 明确目标文件、改动内容、验收标准\n- 顺带为新增代码补测试和注释\n- 改动量适中，一轮聚焦一个点\n\n【铁律】\n- 角色是 Orchestrator（主智能体），负责统筹项目进展\n- 每次回复直接开始工作，不需要确认\n- Review 阶段只分析不动手，执行阶段只动手不分析\n- 遇到不确定时基于现有信息做最佳判断\n- 完成后自动进入下一轮迭代",
}

export const PRESET_ICONS = {
  "继续优化": "📋",
  "修复 Bug": "🐛",
  "补充测试": "🧪",
  "添加文档": "📝",
  "新增功能": "✨",
  "智能迭代": "🧠",
}

export const DEFAULT_SEQUENCES = {
  "完整开发周期": [
    "审查当前代码，找出本轮最值得改进的 2~3 个问题。\n重点关注：\n1. 上轮引入的代码（新代码尚未经过充分审查）\n2. 仍存在的架构或设计问题（耦合、职责不清）\n3. 测试或文档缺口\n\n列出每个问题的影响范围和修复建议。",
    "修复上一步发现的问题。按优先级处理：\n1. 功能正确性问题优先\n2. 代码可维护性问题次之\n3. 风格/命名问题最后\n\n每次修改控制在 30 行以内，说明改了什么、为什么改。",
    "为上一步修改的代码补充测试：\n1. 覆盖修改过的函数的所有公开路径\n2. 验证正常路径+一个边界值\n3. 运行 npm test 确认所有测试通过\n\n如果上一步没有代码修改，则补其他未覆盖的测试缺口。",
    "为上一步新增或修改的代码添加文档注释：\n1. 导出函数的 JSDoc（参数、返回值）\n2. 复杂逻辑的 WHY 注释\n\n如果没有新增代码，则找一个缺少注释的现有函数补充。",
  ],
  "功能开发周期": [
    "分析当前项目，确定下一个要开发的功能点。\n审查现有代码结构，找出：\n1. 最自然的扩展点（接口、模型、工厂）\n2. 可复用的现有组件或工具函数\n3. 需要新建的模块和文件\n\n输出：功能描述、涉及文件清单、大致工作量评估。",
    "为上一步确定的功能编写实现代码。\n从稳定的底层开始：\n1. 数据结构和接口定义\n2. 核心逻辑函数（纯函数优先，方便测试）\n3. 上层编排和 UI/API 绑定\n\n保持单次改动聚焦，必要时分多轮完成。\n为新代码添加基本的行内注释。",
    "为上一步编写的代码补充测试：\n1. 核心逻辑函数写单元测试（正常路径 + 边界值）\n2. 集成测试覆盖主流程\n3. 运行 npm test 确认全部通过\n\n如果上一步改动较大，可以只测核心路径，余下轮补充。",
    "为上一步新增的代码撰写文档：\n1. 导出函数的 JSDoc（参数、返回值、示例）\n2. 模块的概述注释（该模块职责、使用方式）\n3. 如有对外接口，补充使用说明\n\n同时检查上一步的注释是否够用，补齐缺失的 WHY 注释。",
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
