# OpenTag 部署指南

> Canonical source: [../deploying.md](../deploying.md)
> Last synced with: 2026-08-26

OpenTag 的 Staging 环境运行在 [CapRover](https://caprover.com/) 上。每个合入 `main` 且通过 CI 的 revision，都会用
`Docker` workflow 已经发布到 GHCR 的容器镜像自动部署。CapRover 主机上不构建任何内容，也不上传源码 tarball；一次部署
只是把指针切到一个不可变镜像。

| Environment | 触发条件 | 镜像 | Workflow |
| --- | --- | --- | --- |
| Staging | `main` 的 `CI` 成功，或有意的手动运行 | `ghcr.io/first-tree-ai/opentag:<commit-sha>` | `deploy-staging.yml` |

本仓库不部署 Production。Production 发布的 artifact 见 [releasing.md](./releasing.md)。

## 一次推送如何到达 Staging

1. 一个 revision 合入 `main`，`CI` 与 `Docker` 并行启动。
2. `Docker` 构建并推送不可变的 commit coordinate `ghcr.io/first-tree-ai/opentag:<commit-sha>`。
3. `CI` 成功，触发 `Deploy Staging`。
4. `Deploy Staging` 先证明该 revision 属于 `main` 历史，等待 commit coordinate 发布完成，再确认该 revision 仍是 `main`
   的 tip。
5. CapRover App 被指向这个精确的镜像 tag，由 CapRover 拉取并完成上线。

部署始终使用按 commit 的 tag，绝不使用 `edge` 或 `latest`。移动的 tag 会让 CapRover 面对一个没有变化的镜像引用，从而
无法向前推进，也会让线上运行的 revision 无法识别。

排查"部署没发生"之前，有两个特性需要先知道：

- **Staging 绝不回退。** 连续 commit 的运行可能重叠，因此自动运行如果发现自己的 revision 已不是 `main` 的 tip，就会
  跳过，而不是覆盖更新的 revision。该运行仍然成功，并在 job summary 中记录这次跳过。
- **tip 损坏会让 Staging 停在原地。** 如果 commit `A` 通过 CI，随后 commit `B` 合入并失败，那么 `A` 的运行会因为 `A`
  不再是 tip 而跳过，`B` 也不会部署，Staging 保持在上一次成功上线的 revision。此时用手动运行有意部署 `A`。

## 仓库 Secrets

在 **Settings → Secrets and variables → Actions** 中配置以下 repository secrets。Workflow 会在调用 CapRover 之前列出
缺失的名称并失败，因此未配置的部署会被明确报告，而不是执行到一半。

| Secret | 值 | 获取位置 |
| --- | --- | --- |
| `CAPROVER_STAGING_SERVER` | CapRover dashboard URL，例如 `https://captain.apps.example.com` | 你的 CapRover 实例 |
| `CAPROVER_STAGING_APP` | 承载 Staging 的 CapRover App 名称 | CapRover dashboard → Apps |
| `CAPROVER_STAGING_APP_TOKEN` | App 级别的部署 token | CapRover dashboard → App → Deployment → App Token |

请使用 App Token 而不是 CapRover 账号密码。该 token 只授权对这一个 App 的部署，泄露后无法重配置服务器其余部分，并且
可以在该 App 的 Deployment 页单独轮换，不影响其他 App。

Workflow 声明了 `staging` 这个 GitHub Environment，使部署出现在仓库的 Deployments 视图中，之后也可以为它加上保护规则。
Repository secrets 在该 job 中依然可读；把这三个 secret 改放到该 Environment 下同样可行，并能把它们限定在 Staging。

## CapRover App 前置条件

Workflow 只改变 App 运行哪个镜像。以下都是首次部署前必须在 CapRover 侧完成的配置。

- **Container HTTP port** 为 `8000`，与镜像暴露的端口一致。
- **PostgreSQL**：CapRover 的一键 Postgres App，或主机可达的外部实例。
- **持久化存储**：server 镜像本身不需要，但数据库 App 需要。
- App 上的**环境变量**：

| 变量 | Staging 取值 |
| --- | --- |
| `OPENTAG_ENV` | `staging` |
| `OPENTAG_HOST` | `0.0.0.0` |
| `OPENTAG_PORT` | `8000` |
| `OPENTAG_PUBLIC_URL` | App 的 HTTPS URL；hosted environment 拒绝纯 HTTP |
| `OPENTAG_DATABASE_URL` | Staging 数据库的 `postgresql://…` |
| `OPENTAG_JWT_SECRET` | 至少 32 个随机字符，Staging 专用 |
| `OPENTAG_ENCRYPTION_KEY` | Base64 编码的 32 字节 key，Staging 专用 |
| `OPENTAG_AUTO_MIGRATE` | `true`，使每次上线都应用待执行的 migration |

设置 `OPENTAG_PUBLIC_URL` 之前，先在 App 上启用 HTTPS 并强制 HTTPS；在 hosted environment 中，public URL 不是 HTTPS
时 server 会拒绝启动。Staging 的 secret 不得与任何其他环境共用。

GHCR package 是公开的，因此 CapRover 匿名拉取镜像即可。如果该 package 之后被改为私有，需要在
**CapRover → Cluster → Docker Registries** 中用带 `read:packages` 的 GitHub token 添加 registry 凭据，否则每次部署都会
在拉取阶段失败。

## 手动部署与回滚

在 Actions 页面基于 `main` 运行 **Deploy Staging** workflow。`revision` 输入留空表示部署当前 tip；填入 commit SHA 则
部署该 revision，这也是执行回滚的方式。手动运行被视为显式决策，永远不会因为"过期"被跳过，但该 revision 仍必须属于
`main` 历史，并且已经有发布好的镜像。

回滚只回退应用代码，不会回退更新的 revision 已经执行过的数据库 migration，因此跨越破坏性 migration 的回滚需要一份
有意为之的数据库方案。

## 验证一次部署

Job summary 会记录部署的 revision、镜像 tag 和镜像 digest。之后再从 CapRover 侧确认上线结果：

- App 的 Deployment 页显示新的镜像引用和成功的构建日志。
- `https://<app>/healthz` 返回成功。
- App 日志中出现预期 revision 的 migration 与监听日志。

## 需要在上线之外补动作的部署

绝大多数 revision 只需要上面那些检查。但如果一次 migration 让数据库之外持有的凭证失效，情况就不同：上线成功、
`/healthz` 通过、日志干净，而 Computer 全都掉线。这类 migration 必须记录在这里，因为部署流程本身不会暴露它。

### Workspace 与机器授权切换 —— `0016_certain_revanche`（#161）

这次 migration 把 Runtime 认证从 Account access token 换成了作用域限定到单条入组记录的机器凭证。它刻意不为存量
Computer 生成任何凭证，并且断言自己确实没有生成：

```sql
IF EXISTS (SELECT 1 FROM "workspace_computer_credentials") THEN
    RAISE EXCEPTION 'Workspace cutover must not synthesize machine credentials';
```

凭空造出一份没有人同意过的机器凭证等于自开后门，所以这个断言是对的。代价是**切换前入组的每一台 Computer 都必须
重新手工入组**，而且有三重效应会掩盖真正的原因：

- 所有 Computer 显示 Offline。`workspace_computers` 的行在插入时没有 `current_instance_id`，只有 Computer 注册才会
  写入它。
- 使用切换前 CLI 的 daemon 会用 Account access token 认证 Runtime WebSocket，被以 `AUTH_INVALID_TOKEN` 和关闭码
  4401 拒绝。
- 只升级 CLI 无法恢复。daemon 会以 `This Computer is not enrolled; run computer connect first` 退出，因为
  `computer-credentials.json` 并不存在。而切换前的 CLI 根本没有 `computer connect` 子命令，所以必须先升级才谈得上
  重新入组。

Agent 的 Connected computer 页会显示 `OpenTag is not running on <name>. Start it there to bring this Computer back
online.`。这句话对"机器只是睡着了"是对的，在这里是错的——启动旧 daemon 不可能成功。

#### 建立待办清单

```sql
select w.name as workspace, wc.display_name, wc.computer_id, wc.platform, wc.last_seen_at
from workspace_computers wc
join workspaces w on w.id = wc.workspace_id
left join workspace_computer_credentials c
       on c.workspace_computer_id = wc.id and c.revoked_at is null
where wc.revoked_at is null and c.id is null
order by wc.computer_id, w.name;
```

每一行是一条**尚未被签发**机器凭证的入组记录，不是一台主机。同一个 `computer_id` 出现在多行上，说明这台主机入组了
多个 Workspace，每一行都需要单独走一遍。

这个查询衡量的是"是否签发"，不是"是否恢复"。用它建立待办清单，不要用它判断收工——原因见
[确认恢复](#确认恢复)。

#### 恢复方式

**恢复的单位是一条 Workspace 入组记录，不是一台物理机。** 连接码携带它被签发时所属的 Workspace，`computer connect`
只写入该 Workspace 的凭证；而 daemon 会为每条已存储的入组记录各跑一条独立的 Runtime 连接。对一台入组了多个
Workspace 的主机只跑一次，其余 Workspace 的 Agent 仍然离线，而这台机器看上去已经恢复了。

而且无法集中完成——凭证要写到目标主机的磁盘上。

对待办清单里的每一行：

1. **该 Workspace 的** Admin 在 Web 的 Computers 页生成连接命令。该命令一次性、15 分钟过期，所以要等使用者到位再
   生成，不要提前批量生成。
2. 由使用者在那台主机上执行生成的命令。它会在一行里完成 CLI 升级和入组——这一点很关键，因为已安装的 CLI 早于
   `computer connect` 子命令。
3. 命令写入机器凭证并重启 daemon 服务。
4. 用下面的检查确认这条入组记录确实回到 Online 之后再处理下一条。**不要**把它从待办清单里消失当作成功。

在一台已经为别的 Workspace 恢复过的主机上重复执行是安全的。`computer-credentials.json` 每条入组记录存一项，入组
时只替换正在入组的那个 Workspace 对应的那一项，先前的凭证会保留，daemon 重启后会重新拾起全部已存储的入组记录。

重新入组时，只要主机上的 `config/computer.json` 还在，`computerId` 就不变，已有的入组记录会被复用，绑在上面的
Agent 不受影响。该文件丢失则会被认作一台新的 Computer，此前的每一条入组记录连同它们的 Agent 一起留在离线状态。

#### 确认恢复

权威信号是一次 Runtime 注册，也就是 Computers 页显示的 Online。用 SQL 表达同一条规则——只有当入组记录持有当前
instance、且在存活窗口（默认 90 秒）内被看到过，才算在线：

```sql
select w.name as workspace, wc.display_name, wc.computer_id, wc.last_seen_at
from workspace_computers wc
join workspaces w on w.id = wc.workspace_id
where wc.revoked_at is null
  and (wc.current_instance_id is null or wc.last_seen_at < now() - interval '90 seconds')
order by wc.computer_id, w.name;
```

优先用这条，而不是待办清单那条——后者无法证明恢复。`runComputerConnect` 先兑换连接码、由服务端创建新凭证并**吊销
该入组记录原有的凭证**，之后 CLI 才把 `computer-credentials.json` 写到主机上。因此本地写入若因磁盘、权限或进程中断
而失败，这条入组记录就处于"服务端有一份 daemon 拿不到的有效凭证、而旧凭证已被吊销"的状态。它会从待办清单里消失，
却并没有恢复，而且比尝试之前更糟。遇到这种情况，重新生成一条命令再跑一次。
