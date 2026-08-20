# review-gate

一个将代码评审变成**硬门禁**的 **DeepSeek Harness (dsh) bundle（插件）**。
与只读的评审/差异查看器不同，review-gate 真正闭环：生成分级评审项、以确定性规则
放行或拦截合并、要求团队审批达到法定人数、并留存可审计的合规报备记录——同时接入
`ctx.tools` 与独立的 CLI（供 CI/hook 使用）。

它填补的空白：生态中现有评审插件只能查看差异并添加批注，缺少**把评审作为门禁**的
能力。review-gate 让评审成为合并/PR 之前必须通过的检查点。

```
  git diff ──► run ──► 评审项(severe/warning/suggestion)
                        │  确定性规则 (不依赖模型)
                        ▼
                     gate ──► blocked / passed
                        │
                        ▼
                 团队审批法定人数 ──► approved ⇢ 解锁合并
                        │
                        ▼
            合规报备(时间 / 人 / 结论 / 规则版本)
```

---

## 功能

1. **评审会话** — 审查工作区、暂存区、单个提交或任意 `base..head` 范围。评审项按
   `severe` / `warning` / `suggestion` 分级，逐文件/hunk 产出，来源包括：
   - **确定性静态规则**（对新增行做正则匹配，绝不依赖模型），以及
   - **LLM 辅助评审项**（可选）。模型只会*新增评审项*，永远不能绕过任何阈值。
2. **门禁规则** — 可配置阈值（`severe = 0`、`warning ≤ N`、suggestion 不限、
   人工确认清单）。通过/拦截的判定由**确定性规则**基于已固化轮次
   （评审项 + 确认 + 投票）计算——完全可复现，绝非模型判断。自动门禁不过，任何
   审批都无法解锁合并。
3. **团队审批流** — `approve` / `request_changes` / `reject`，可配置法定人数
   （N 个不同的审批）。按评审人后写覆盖；重新评审（新轮次）会使旧的审批**与旧的
   确认（acknowledgement）**一并失效。
4. **合规报备** — 每次评审、投票、确认、导出都追加到不可变的审计日志（时间、操作者、
   结论、规则版本），并可导出为 JSON 或 Markdown 报告。
5. **与 CI 协作** — 每个工具与 CLI 命令都输出机器可读 JSON 与正确的退出码
   （`gate-check` 在未通过前以非零退出），可直接接入 GitHub Action / hook / 分支保护。
6. **教训库** — 可选：失败经验可沉淀为可复用静态规则（见“配置”）。
7. **工具链** — dsh 工具 `review_run`、`review_status`、`review_approve`、
   `review_request_changes`、`review_reject`、`review_acknowledge`、`gate_check`、
   `review_export`；以及独立 `review-gate` CLI。

---

## 工作原理（简述）

- **会话** 由（稳定的仓库标识, 差异范围）确定，因此提交的记录在任何检出/CI 机器上
  都保持同一标识。基于差异 + 规则 + 策略的确定性 **指纹** 标识被评审内容；内容未变时
  复用该轮（幂等），绝不重复写入审计。
- 评审项具有**基于内容生成的稳定 id**，因此确认（acknowledge）与人工确认清单可在
  内容完全相同的重复评审之间保持一致。*新轮次*（内容或策略变化）需要重新确认。
- **门禁** 综合自动规则与审批状态得出唯一状态：

  | 状态 | 含义 |
  | --- | --- |
  | `open` | 已创建，尚未评审（无轮次） |
  | `blocked` | 自动门禁未通过，或存在 `request_changes`/`reject` |
  | `passed` | 自动门禁通过，等待审批 |
  | `approved` | 自动门禁通过 **且** 达到法定人数、无拦截 —— 解锁合并 |

- **持久化** 为 JSON 文件存储：按会话做原子化读-改-写（进程内互斥 +
  临时写/fsync/重命名）、跨进程锁文件、以及只追加的 `audit.jsonl`。

---

## 目录结构

```
review-gate/
├── package.json            # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml        # 挂载插件行的补丁
├── tsconfig[.test].json
├── src/
│   ├── types.ts            # 核心领域类型
│   ├── config.ts           # 配置、默认值、校验、规则
│   ├── git/diff.ts         # unified diff 解析（纯函数）
│   ├── git/runner.ts       # git 交互（可注入执行器）
│   ├── analyzers/static.ts # 确定性正则分析器
│   ├── analyzers/llm.ts    # 可选 LLM 评审器（惰性解析 ctx.llm）
│   ├── gate/engine.ts      # 确定性自动门禁
│   ├── approval/flow.ts    # 投票、法定人数、后写覆盖
│   ├── service/evaluate.ts # 门禁+审批综合判定
│   ├── service/reviewGate.ts # 门面 / 公开 API
│   ├── store/              # 持久化 + 内存存储、文件锁
│   ├── audit/report.ts     # 合规报告渲染
│   ├── dsh/                # dsh 适配器（工具、LLM 网关、入口）
│   ├── cli.ts              # 独立 CLI
│   └── index.ts            # 编程式 API 导出
├── test/                   # node:test 测试套件（61 项）
├── examples/
│   ├── review-gate.config.json   # 完整带注释配置
│   └── github-action.yml         # CI 门禁工作流
├── README.md / README.zh.md
└── LICENSE
```

---

## 快速开始

> 独立 CLI 与编程式 API 需要 Node.js ≥ 18；作为 dsh bundle 运行时，harness 本身
> 要求 `^22.19.0 || >=24.0.0`（以 harness 安装文档为准）。`git` 须在 `PATH` 中且
> 目标目录为 git 工作区。

### 使用 CLI

```sh
# 在某个 git 仓库内
review-gate run --json                 # 评审工作区相对 HEAD 的差异
review-gate status --json
review-gate gate-check --mode merge    # 仅当可合并时退出码为 0
```

本地构建与测试：

```sh
npm install
npm run build          # → dist/
npm test               # 构建 dist-test/ 并运行 node --test
node dist/cli.js run   # 或：npm run cli -- run
```

### 作为 dsh bundle 接入

`review-gate` 遵循 dsh bundle 规范：

```js
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 向 profile 层插入 `review-gate` 一行；部署时可覆盖其 `config`
（补丁按整行替换，需写全所有字段）。像其他 bundle 一样安装：

```sh
dsh plugin --profile <name> add ./review-gate
dsh --profile <name> --patch ./review-gate/cordis.patch.yml
```

插件导出 `name` / `inject` / `apply(ctx, config)`，并在 `ctx.tools` 上注册工具
（见“dsh 工具”）。LLM 辅助评审在 `config.llm.enabled` 开启后，于调用时惰性解析
`ctx.llm`，可自动发现后挂载的模型层；模型层不可用时写入 `llm.warn` 审计事件并继续——
静态规则的评审项仍然主导门禁。

### 配置

在 `<repo>/.review-gate.config.json`（CLI 读取）和/或插件行 `config` 中放置：

```json
{
  "cwd": "/绝对/路径/仓库",
  "store": { "root": ".review-gate", "repoId": "github.com/acme/repo" },
  "gate": {
    "severe": 0,
    "warning": 0,
    "suggestion": -1,
    "requiredAcknowledge": []
  },
  "approvals": { "required": 2 },
  "llm": { "enabled": false },
  "onEmptyDiff": "pass",
  "maxFindings": 500,
  "rules": { /* 自定义静态规则，叠加在内置规则之上 */ }
}
```

运行 `review-gate init` 可生成示例文件。详见 `examples/review-gate.config.json`。

`store.repoId` 固定用于键控会话的稳定标识，使已提交的记录在每个检出与 CI 上都可读。
未设置时按 `remote.origin.url`、git toplevel、工作目录依次推导——见“与 CI 协作”。

**LLM 辅助评审**默认关闭。开启需设 `llm.enabled`，并在部署未路由默认 provider/model
时设置 `llm.provider` 与 `llm.model`。LLM 评审项同样由确定性阈值计数；模型不可用时
运行照常完成。

**门禁阈值**（`-1` = 不限）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `gate.severe` | `0` | 允许的最大未确认 severe 评审项数 |
| `gate.warning` | `0` | 允许的最大未确认 warning 数 |
| `gate.suggestion` | `-1` | 默认不拦截 suggestion |
| `gate.requiredAcknowledge` | `[]` | 必须显式确认的评审项 id；标记 `"severe"` 表示“所有 severe 都必须确认” |

**确认（acknowledge）评审项** 会将其移出失败集合，且始终留痕：
`review-gate acknowledge <id> --reason "已登记 CR-77"`。

**内置规则**（`src/config.ts::defaultRules`）：`todo`、`debugger`、`console-log`、
`hardcoded-secret`、`long-line`、`merge-markers`。每条含 `pattern`、`severity`、
`message`、可选的 `files` 路径正则与 `suggestion`。在 `rules` 下新增/覆盖即可把
历史失败沉淀为规则——匹配数量由 `maxFindings` 封顶。

**空差异** — “空”指 git 完全没有报告任何变更。纯二进制、纯重命名或仅改模式的变化
属于真实差异：不产生逐行评审项，但仍需审批达到法定人数。`onEmptyDiff: "pass"`
（默认）放行真正空差异；`"fail"` 则要求显式评审：会插入一个必须确认的 `severe`
评审项，以此表达“没有改动仍需签核”的策略。

---

## dsh 工具

| 工具 | 用途 |
| --- | --- |
| `review_run` | 评审当前差异 / 提交 / 范围 |
| `review_status` | 当前评审项、状态、审批进度 |
| `review_approve` | 为法定人数 +1（自动门禁不过时无效） |
| `review_request_changes` | 拦截直至重新评审 |
| `review_reject` | 拦截直至重新评审 |
| `review_acknowledge` | 带原因确认某个评审项（留痕） |
| `gate_check` | 确定性判定，机器可读 JSON，`gate`/`merge` 两种模式 |
| `review_export` | 导出合规报告（JSON / Markdown） |

每个工具都返回 JSON 值（CI 可消费）并为模型渲染可读摘要。也可用编程式 API：

```ts
import { ReviewGate, JsonFileStore, GitRunner, resolveConfig } from 'review-gate/core'

const config = resolveConfig({ cwd: '/path/to/repo' })
const gate = new ReviewGate({
  config,
  store: new JsonFileStore({ root: config.store.root }),
  git: new GitRunner({ cwd: config.cwd }),
})
const { verdict } = await gate.run({ scope: { kind: 'range', base: 'main', head: 'feature' } })
const check = await gate.gateCheck({ mode: 'merge' })
```

---

## CLI 参考

```
review-gate <command> [scope] [options]

  run | status | approve | reject | request-changes | acknowledge
  gate-check | export | audit | init | version

Scope: working | staged | commit:<ref> | range:<base>..<head>   （默认 working）

  --dir <path>      要评审的仓库                 --config <file>
  --force           内容未变也强制新一轮         --mode gate|merge
  --reviewer <r>    --comment <text>            --reason <text>
  --format json|markdown（export）              --out <file>
  --actor <label>   --json
```

`gate-check` 即 CI hook：输出 JSON，`--mode gate` 下当状态为 `passed`/`approved`
时退出 `0`；`--mode merge` 下仅当 `approved` 时退出 `0`。其余命令成功退出 `0`、
操作被拒绝退出 `1`、用法/配置错误退出 `2`。

---

## 与 CI 协作

门禁状态与审计记录存放在 `<repo>/.review-gate/`。由于会话以**稳定仓库标识**为键
（`store.repoId`，或由远程 URL 推导），在一个检出里记录的内容，可以在同一仓库的
任何其他检出（含 CI）中读取。

两种部署模型：

- **提交记录（推荐用于拦合并）** — 评审人在其检出中创建并更新评审状态与审批，然后
  **提交 `.review-gate/`** 到仓库。CI 只需检出并校验：
  `review-gate gate-check --mode merge` 仅在自动阈值 *与* 审批法定人数都满足时
  退出 `0`。`examples/github-action.yml` 给出了这种分支保护任务的示例。
- **流水线自管** — 由 harness / CLI 作为评审方，直接在与合并门禁相同的环境中写状态。

重要：同一门禁在处处都使用**一致的 scope**——评审人审批所用的差异范围，必须与 CI
校验的是同一个（默认 `working`）。`gate-check` 本身从不改动状态，可安全地从 hook
反复调用。

---

## 设计说明 / 取舍

- **确定性门禁**：通过/拦截的判定是“轮次内已存评审项 + 确认 + 投票”的纯函数。
  模型输出只能贡献评审项——永远不能绕过阈值——且轮次一旦持久化，任何重读都会得到
  完全一致的结论。
- **幂等**：内容未变时重复 `review_run` 复用轮次；相同投票/确认是空操作；
  `gate_check` 从不改动状态。
- **并发**：按会话键串行（进程内互斥 + 带陈旧锁打破与归属令牌的跨进程锁文件）；
  写入采用临时文件+fsync+原子重命名，崩溃不损坏文档；审计只追加。
- **范围边界**：组合（`--cc`）合并差异不做逐行评审（记录为占位文件）。空差异由
  `onEmptyDiff` 决定。评审项数量由 `maxFindings` 封顶。
- **教训库** 刻意做成配置驱动（加一条规则），而非自动变更的子系统——确定性、可审计。

## 安全

- 门禁只读仓库（`git diff` / `git show`），绝不修改工作区。
- 评审项中的敏感信息：`hardcoded-secret` 规则会把匹配行写入评审项/报告；请限制
  记录文件的读取范围，高安全仓库应使用更严格规则。
- 这是评审/合规辅助，不是授权边界。只要能写存储就能改审批；请保护好
  `.review-gate/`。

## 测试

`npm test` 运行 `node:test` 套件：`git/diff` 解析器、静态分析器、门禁引擎、
审批流、JSON 存储（并发 + 持久化 + 锁）、评审运行器 E2E（含空差异 + LLM 兜底 +
轮次作用域 + 稳定标识）、幂等性、报告、配置校验、dsh 工具注册表，以及针对真实临时
git 仓库的完整 CLI 往返。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
