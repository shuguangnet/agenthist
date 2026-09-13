# 设计：轻量化运行、零垃圾缓存与可验收标准

> 状态：草案（Draft）｜ 适用版本：agenthist 0.2.x
> 目标读者：本仓库维护者，以及使用 Qoder 等 AI IDE 按"验收标准"驱动实现的开发者/Agent。

## 1. 背景与问题

当前实现存在三类用户可感知的问题：

1. **卡（响应慢）**。`loadSnapshot`（`src/infrastructure/history-store.ts:130`）每次把整个 `index.json` 读入并逐条重建 library 覆盖表；`index.json` 中携带每个会话的 `searchText` 数组，会话数增长后单文件体积线性膨胀，浏览/搜索/scan 前置检查全部为它买单。CLI 冷启动为整树 import，无懒加载。
2. **缓存与垃圾文件多**。扫描时每 agent 产生 `.prepare-<uuid>/` 快照工作区，事务回滚/崩溃后会残留 `.prepare-*` 目录与 `.agenthist-*-managed-resource.tmp` 临时文件（`src/infrastructure/managed-resources.ts:358`）；`pruneHistorySnapshots` 失败时仅记录警告并跳过（`history-store.ts:126`），垃圾会随时间累积。快照 raw 文件虽用硬链接复用，但 `index.json` 是全量重写。
3. **缺少可执行的验收口径**。优化"卡不卡、垃圾多不多"没有量化标准，导致实现与验收脱节。

## 2. 设计目标与非目标

**目标**

- G1 轻便：冷启动快、常驻内存小、不引入守护进程等后台负担。
- G2 缓存收敛：状态目录只保留"必需数据 + 一份可重建索引"，索引必须可随时删除重建。
- G3 零垃圾：任何崩溃/回滚路径都不留下永久残留；提供显式回收入口。
- G4 可验收：每项优化都有量化验收标准（第 6 节），可被测试与 AI IDE 直接校验。

**非目标**

- 不改变 `.agenthist` 归档格式与事务协议语义。
- 不迁移/修改 Agent 连接设置与凭据（仓库红线）。
- 不为未发布的 Agent 版本写兼容代码（遵循 AGENTS.md）。

## 3. 方案总览

分四个工作流，互相独立，可按顺序落地：

| # | 工作流 | 主要触点 | 解决 |
| --- | --- | --- | --- |
| W1 | 索引分片 + SQLite FTS | `history-store`、`library-store`、`history-catalog` | 卡 |
| W2 | CLI 冷启动瘦身 | `cli/program.ts`、各 command | 卡 |
| W3 | 扫描增量化 + 垃圾回收 | `incremental-scan`、`history-store`、`managed-resources`、新 `gc` | 缓存/垃圾 |
| W4 | 状态目录配额与自愈 | `state.ts`、`maintenance` 子命令 | 缓存/垃圾 |

## 4. 详细设计

### W1 索引分片与搜索下推（核心，解"卡"）

现状：`index.json` 是单一大 JSON，包含 `sessions[]`（含 `searchText`），且 library overlay 在每次 `loadSnapshot` 时全量合并。

改为三层结构（均在 state 目录内，schema 版本升为 `agenthist.history-snapshot/v3`）：

```
state/history/<agent>/
  head.json                      # 不变
  snapshots/<id>/
    manifest.json                # 仅会话元数据：sessionRef、agent、workspace、时间、library 摘要；不含 searchText
    raw/…                        # 原始文件（硬链接复用，保持不变）
  search/
    index.sqlite                 # node:sqlite（零依赖，已有 src/infrastructure/sqlite.ts 基础）
                                 # 表 sessions(sessionRef PK, agent, snapshotId)
                                 # 表 search(sessionRef, line) + FTS5 虚表；内容取自 searchText
```

规则：

- **manifest 只在内存中按需展开**。`history` 列表页只读 manifest（体量约为现在的 1/10）；只有打开/导出/转换具体会话才读 raw。
- **搜索下推到 SQLite**。`history search` 走 FTS5 `MATCH`，不再在 JS 中全量扫描 `searchText`。FTS 索引属于**纯派生数据**：删除 `search/` 目录后必须能由 manifest+raw 完整重建（G2 的硬性要求）。
- **library overlay 合并下沉到读取层单个会话粒度**：列表页只取 overlay 中被用户改名/打标/归档/删除的条目（overlay 本身本来就只存用户改动的 diff），不再为每个会话做 `Map.get`。
- **增量更新 FTS**：scan 只对变化会话（见 W3）执行 DELETE+INSERT，避免全量重建。

### W2 CLI 冷启动瘦身

- `cli/program.ts` 顶层不再 import 全部 command 模块；改为命令名 → `() => import("./x-command.js")` 的懒加载表。`--help`、`-v` 路径上不加载任何 command 实现与 wizard。
- 首次交互前的准备工作（终端能力探测、style、node-warnings）合并为一次探测并缓存于内存；不做磁盘缓存。
- 保持零新增依赖：懒加载用原生 `import()`，不用动态 require。

### W3 扫描增量化与垃圾回收（解"缓存/垃圾"）

扫描侧：

- 在 manifest 中为每个会话记录源文件指纹（`size + mtimeMs + inode`）。`incremental-scan` 先 stat 后读：指纹未变的会话直接复用 manifest 条目，不读文件、不重抄 raw、不重写 searchText。
- `.prepare-<uuid>` 工作区沿用，但**scan 结束/失败路径都必须调用 `discardSnapshot`**（含 catch 分支），当前仅成功路径明确清理。
- 快照发布只 `rename` 变化部分所在子树；`index.json` 改名为 `manifest.json` 并按上述瘦身。

垃圾回收（新增 `agenthist gc` 命令，同时挂到 `maintenance` 下）：

1. 收集仍被引用的资源：各 agent 当前 `head.json` 指向的快照、事务存储中未完成事务保留的快照 id（复用 `retainedHistorySnapshotIds`）、库 overlay 引用。
2. 删除：孤儿 `.prepare-*` 目录（启动时间早于进程启动即视为孤儿）、过期 `.agenthist-*-managed-resource.tmp`、`search/index.sqlite` 可选 `--rebuild` 时重建、无人引用的旧快照。
3. 输出回收清单与释放字节数；`--dry-run` 只报告。
- `gc` 幂等、只删 state 目录内内容、永不触碰 Agent 原生目录（数据安全红线）。

### W4 状态目录配额与自愈

- `state.ts` 维护一个 `quota.json`：记录 state 目录各部分预算（快照、search 索引、事务存储）。scan 完成后若超出预算（默认 512 MiB，可配），自动触发 gc 的孤儿清理部分。
- 自愈：启动时若 `manifest.json` 校验失败（schema/哈希），自动降级为"重建模式"——从 raw 重算该 agent 的 manifest 与 FTS，而不是直接报错终止。索引永远可重建是本设计的兜底原则。

## 5. 兼容与迁移

- v2 快照首次被新版读到时：一次性迁移为 v3（manifest 分片 + FTS），迁移在事务内、可回滚；迁移完成后删除 v2 `index.json`。失败则保留 v2 并提示 `agenthist gc --rebuild`。
- `.agenthist` 导出格式不变，导出时由 v3 数据投影生成，老版本导入不受影响。

## 6. 验收标准（Acceptance Criteria）

以下标准均可写成自动化测试；标 [M] 的需测量，标 [T] 的需测试用例。可直接作为 Qoder 等 AI IDE 的 Quest/验收清单逐条勾选。

### A. 性能（轻便）

- [A1][M] CLI 冷启动（`agenthist --help`，无扫描库）：p50 ≤ 150 ms，p95 ≤ 300 ms。
- [A2][M] `agenthist history list`（1 万会话库）：p50 ≤ 200 ms，且峰值 RSS ≤ 150 MB。
- [A3][M] `agenthist history search <关键词>`（1 万会话）：p95 ≤ 300 ms。
- [A4][M] 增量 scan（无变化，1 万会话）：≤ 1 s，且不产生任何新文件写入（仅 stat 与 head.json 比对）。
- [A5][T] W2 懒加载：`--help` 路径上不 import 任何 `*-command.ts` 实现模块（可用模块加载计数或编译期约束测试验证）。

### B. 缓存与垃圾

- [B1][T] 杀死 scan 子进程模拟崩溃后，再次运行 `agenthist gc` 必须清除全部 `.prepare-*` 与 `*.tmp` 残留；gc 退出码 0 且输出回收清单。
- [B2][T] 删除 `state/history/*/search/` 后运行任意 `history` 命令，功能正常且 FTS 在首次搜索时自动重建（自愈），重建不阻塞列表查询。
- [B3][M] 连续 50 次增量为零的 scan，state 目录字节数增长为 0。
- [B4][T] state 目录超出配额时 scan 收尾自动清理孤儿资源，最终体积回落到配额内。
- [B5][T] gc 只删除 state 目录内路径；对 Agent 原生历史目录、连接设置与凭据文件零写入（断言前后内容哈希不变）。

### C. 行为保持

- [C1][T] 现有全部单测/集成测试通过，无语义变化。
- [C2][T] v2 快照迁移：迁移后老数据可读、事务可回滚、迁移中断后可恢复或回退到 v2。
- [C3][T] 导出的 `.agenthist` 可被 v2 版本 inspect/import（格式兼容）。

### D. 工程约束

- [D1] 不新增运行时依赖（`node:sqlite` 之外不引入 SQLite 驱动、向量库等）。
- [D2] 所有新测试使用合成 fixture，无网络/凭据依赖（AGENTS.md 要求）。
- [D3] 完成后 `npm run verify` 全绿；涉及打包再跑 `npm run smoke:package`。

### 测量方法约定

性能项用 `node --expose-gc` + `perf_hooks` 在 `tests/benchmarks/` 中固化为基准脚本（沿用现有 `benchmark:history` 模式），固定合成 1 万会话库，输出 p50/p95/RSS；CI 中仅作记录不作门禁，本地验收以脚本输出为准。

## 7. 落地顺序建议

1. W3 的 gc 命令 + 失败路径清理（风险最低，立即止住垃圾累积）。
2. W1 manifest 分片（迁移先行，解最大性能瓶颈）。
3. W3 扫描指纹复用 + W2 懒加载。
4. W4 配额与自愈。

每步完成后跑第 6 节对应验收项，全部落地后整体回归 A1–D3。
