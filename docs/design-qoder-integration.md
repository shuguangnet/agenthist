# 设计：接入 Qoder 作为第五个 Agent（claude 家族泛化）

> 调研结论（2026-09，官方文档 docs.qoder.com）：
> - Qoder CLI 的会话按项目隔离存放在用户配置目录（默认 `~/.qoder`，可用 `QODER_CONFIG_DIR` 迁移）；
> - 会话正文是 Transcript JSONL：每行一个 JSON 对象（`session_meta` / `user` / `assistant` / `progress` 等），
>   `message.content` 为字符串或 `text`/`tool_use`/`tool_result` 数组——与 Claude Code 的 Transcript 同构；
> - 主 Transcript 位于 `projects/<encoded-project>/transcript/<session-id>.jsonl`（Claude 是
>   `projects/<encoded>/<session-id>.jsonl`），会话目录内有 `state.json` 等附属文件；
> - 恢复会话命令为 `qoder --resume <session-id>`（与 claude 参数一致）。
> - IDE 桌面端的聊天索引在 VS Code 式 `globalStorage/state.vscdb`，不在本设计范围（遵循 AGENTS.md：
>   不为未发布的形态写兼容代码，先支持文档化的 CLI 布局）。

## 方案：claude 家族（claude-family）泛化

Qoder 与 Claude Code 共用 Transcript 格式，按 AGENTS.md“真正共通才进共享层”的原则，
把 `src/agents/claude` 泛化为按家族 profile 参数化的实现，`src/agents/qoder` 仅做绑定：

1. `src/agents/claude/family.ts`（新）：
   - `ClaudeFamilyAgent = "claude" | "qoder"`；
   - profile：默认根目录（`~/.claude` / `~/.qoder`）、配置目录环境变量
     （`CLAUDE_CONFIG_DIR` / `QODER_CONFIG_DIR`）、resume 命令（`claude` / `qoder`）、显示名；
   - `isClaudeFamilyAgent()` 守卫。
2. 参数化点（家族内 agent id 全部由 profile/入参决定，不再写死 "claude"）：
   - `source.ts`：根目录解析按 profile（环境变量、默认目录）；
   - `identity.ts`：`claudeSessionRef(..., agent)`，摘要域含 agent，生成 `ahsr1_qoder_ck1_*`；
   - `carrier.ts`：`discoverClaudeCarriers(root, profile)`，qoder 识别
     `projects/<p>/transcript/<uuid>.jsonl` 为主 Transcript，其余附属文件归 sidecar/auxiliary；
   - `scan.ts`：快照/会话/增量键/错误文案使用家族 agent；
   - `launcher.ts`：`command = profile.command`；
   - `migration/archive|restore|transaction`、`conversion/portable|portable-projector`：
     校验放宽为家族守卫；会话/快照 agent 取自入参（`entry.agent` / `source.agent` / `snapshot.agent`）；
     qoder 目标写入 `projects/<p>/transcript/<id>.jsonl`；
   - 内部快照载具布局前缀 `claude/...` 保留为家族内部标签（AgentHist 私有存储，非原生路径）。
3. `src/agents/qoder/{adapter,index}.ts`：绑定 qoder profile 的家族适配器；registry 注册第五项。
4. CLI/文档：`--qoder-config-dir` 全局选项；skill 安装路径（`~/.qoder/AGENTS.md`、skills 目录）；
   help/README/AGENTS 支持列表加 Qoder。
5. 测试：更新 agent/registry/skill 期望；新增 qoder 集成测试（合成 `~/.qoder` fixture：
   detect → scan → list/search → export → import 到 claude → resume 启动参数）。

## 数据安全

- 扫描/库操作零写入 `~/.qoder`；导入经事务、dry-run、回滚（复用 claude 家族事务机制）；
- 不触碰 Qoder 连接设置与凭据。
