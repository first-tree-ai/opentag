# Context Tree 集成

[English](../design/context-tree-integration.md)

状态：已实现。同步日期：2026-09-21。

## 具名连接

每个 Agent 的运行配置保存 `contextTrees: { alias: string; repository: string }[]`。
空列表禁用记忆。整个列表存于一个 JSONB 列，不引入连接表或独立连接 ID。
API 和有效运行快照共用 Zod schema。别名遵循上游 CLI 的安全单段名称规则：
1–100 个字符，以字母或数字开头，不能以 `.git` 结尾。别名区分大小写，仓库身份不区分。
不允许重复别名或重复仓库。

配置哈希按别名排序并规范化仓库身份，列表顺序不代表优先级。
Agent 可连接多个仓库；连接同一仓库的 Agent 共享该仓库已发布的知识。

**Agent 设置 → Context Tree** 显示别名和仓库，每行有独立断开按钮。
连接或创建需提供别名和 `OWNER/REPO`。相同连接幂等，已占用别名不能静默切换仓库。
重命名或替换通过先断开、再连接完成。Local 支持创建和发布私有仓库；Cloud 只连接已授权仓库。
OpenTag 不会隐式创建记忆。

## 设置操作与并发

现有操作携带别名、操作 ID、预期 Agent revision 和运行配置 revision。
Server 在派发前及校验后的行锁事务内复查，旧响应不能覆盖并发修改。
修改任何非空配置都要求暂停，包括添加连接。相同连接和已不存在的断开是无操作。
断开不要求 Computer 在线，只移除指定别名。

Local 使用绑定 Computer；CLI 修改与运行准备共用串行队列。
创建、连接、发布使用隔离项目和固定显式 `settings` 别名；清理使用 `disconnect --all`，保留副本。
操作指纹包含请求别名，发布去重仍按规范化仓库身份进行。持久化发布意图防止响应丢失导致重复发布；
不确定的发布必须先解决，不能自动重试。

Cloud 精确选择请求仓库当前的 `context_tree` binding，校验准入、分支和真实 Tree head，
完成后复查同一 binding 及授权和凭证版本。允许多个 Tree 授权，但每个 Agent/仓库/角色授权仍须唯一，
包括跨连接情形。现有分支和发布策略保持权威。

## Local 准备

`ContextTreeManager` 按完整连接集合和 provider 准备 Agent 工作目录。
通过 CLI 发现连接、断开过时别名，再运行：

```text
connect OWNER/REPO --as ALIAS --project-path WORKSPACE --json
```

协调只修改连接关系，不删除副本和未发布工作。不支持的连接存储格式会明确报错并保留。

上游连接存储没有跨进程锁，因此 CLI 修改串行执行，同一准备任务由并发 Session 共用。
五秒启动预算包含排队和初始化。超时保留已完成结果，未完成别名标记 `PREPARING`，后台继续。
健康结果缓存保留，失败别名遵守一分钟重试冷却。provider 或完整连接集合变化使缓存失效。
受管执行在使用缓存前仍检查当前仓库授权。

每次准备只安装一次 provider skills，不按树重复。Claude 使用项目 skills，Codex 使用账户 HOME
下的 `.agents/skills`，与自定义 `CODEX_HOME` 无关；Pi 显式接收 `--skill` 路径。
Codex 获得所有 ready 树的可写路径。生成的命令固定使用打包 CLI 和 OpenTag 的 Node。

Claude 项目设置和指令仍属于现有可信 Agent 工作目录边界。Local Pi 和 Claude 不因此获得额外文件隔离。
`members/<agent-slug>/` 是共享记忆约定，不是操作系统保密边界。

## Cloud 准备

Session 的副本和上游版本 2 连接记录位于 `.opentag/context-tree/home`，准备中的写入位于
`.opentag/context-tree/tmp`，随工作目录保存恢复。凭证只来自当前执行；恢复目录不会恢复授权或旧配置。

每轮在暴露 CLI 前按当前配置和授权协调连接。本地 CLI 操作断开已移除或撤权的别名，
因此未限定别名的 `sync` 无法重新访问它们。未授权仓库不会获得网络准备，副本和草稿仍保留。

按别名连接和同步，解析版本 2 响应，包括非零退出码下的逐项失败。
结果携带别名、仓库、状态、路径及可用的分支/SHA。一棵树失败不隐藏其他健康结果。
总预算三十秒；超时保留已完成结果，未完成条目标记超时，共享初始化失败应用于全部受影响条目。

连接失败时，只能从版本 2 存储恢复工作目录、别名和仓库全部匹配的副本，真实路径必须仍在 Session 内。
失败的连接或同步副本明确标记 `stale`。不重置脏目录、不删除不完整克隆、不丢弃准备中的写入。
后续远端读取和发布仍受当前授权约束。

## 提示与写入

Local 和 Cloud 按别名独立报告状态，没有主树或隐含优先级。
上游 skills 负责选择相关树、标明分歧来源和显式写入目标。一棵树不可用时，其他健康树仍可使用。
未配置记忆是正常状态；可选记忆不阻止基本任务启动。不记录树内容或凭证。

## 打包与升级

`apps/cli`、`packages/client` 和 `packages/server` 精确固定 `@first-tree-ai/context-tree@0.1.16`。
CLI、manifest、skills 和模板作为磁盘资源一起进入 portable 构建和 Cloud runner 镜像；
不复制上游源码，也不使用 Git 依赖。

Server、Clients 和 Cloud runner 镜像必须一起部署。迁移 `0049_multiple_context_trees` 删除旧的可空仓库列，
添加默认空列表的 JSONB 列，不翻译旧选择。旧 Agent 需重新选择，不迁移旧快照、操作记录或 CLI 存储。
不支持的存储必须显式处理并保留未发布工作。

`0.1.16` 发布前，可打包上游提交 `1ebe3cd`，临时用 pnpm override 指向本地 tarball 进行验证。
该 override 及本地 lockfile 不应进入发布提交。发布后删除 override，运行 `pnpm install` 生成 registry
lockfile，并对正式包重新运行打包冒烟检查。

## 验证

测试覆盖列表校验、空默认值、快照往返、顺序无关哈希、冲突、定向断开、revision/暂停竞态和发布去重。
运行测试涵盖协调、部分成功、预算、冷却、多可写根目录、精确 Cloud 授权、撤权、版本 2 部分同步与草稿保留。
离线真实 CLI 场景连接两棵树，显式写入一棵，断开后读取和同步另一棵。Cloud 测试使用真实工作目录归档。
必要检查包括 install、check、build、typecheck、单元测试、agent-runtime 覆盖率、PostgreSQL 集成和打包冒烟。
