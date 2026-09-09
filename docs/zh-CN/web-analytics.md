# Web App 分析

[English](../web-analytics.md)

Web App 会向 Google Analytics 4 上报一条激活漏斗。本文说明测量了什么、刻意不发送什么，以及一项代码自身无法完成、必须在 GA4 属性里设置的配置。

## 开关

是否测量完全在浏览器侧决定，由 `apps/web/src/analytics/config.ts` 判断：

- 必须是 production 构建，这排除了所有开发服务器；并且
- hostname 必须是 `opentag.build` 或其子域名。

任一条件不满足时什么都不会发生 —— 不加载 tag，也不排队任何事件。

主机规则是**白名单，而不是排除 loopback**，这一点比看上去更重要。OpenTag 是开源的，设计上就支持自部署。若只排除 loopback，就意味着**每一个自部署实例都会把其运营者与其读者的行为悄悄上报进这个属性** —— 这是没有人要求发送、我们这边也不希望持有的数据。白名单同时朝安全方向失败：未列入的主机只是不被测量，这是一个静默的缺口，而不是一次静默的泄露。它也顺带排除了端到端测试栈和本地预览，因为二者都不在该域名下运行。

**自部署的 OpenTag 不加载 tag，也不上报任何内容。** 若你 fork 本项目并希望使用自己的统计，请同时修改 `ANALYTICS_MEASUREMENT_ID` 与 `MEASURED_HOST_SUFFIX`。

这里没有环境变量：每个 commit 只构建一个镜像并原样推到各环境，构建期的值无法区分环境，而运行期的值又要为一个永不变化的常量绕经 Server。（在启动时注入 `index.html` 同样行不通：`@fastify/static` 以 `wildcard: false` 注册，因此 `/` 与 `/index.html` 直接由磁盘提供，根本不经过那份被缓存的字符串。）

需要接受的后果是 **staging 与生产上报到同一个属性**。为了让这一点可控，所有非生产主机（生产为 `app.opentag.build`）都会发送 `traffic_type: "internal"`。请在 GA4 后台定义**内部流量过滤器**并设为「有效」，这样 staging 会被一次性排除在所有报告之外，而不必依赖每份报告都记得按 hostname 切分 —— 总有一份不会记得。在该过滤器建立之前，这个参数不产生任何影响，因此它先落地是安全的。

## 测量了什么

每个漏斗节点都带 `funnel: "activation"` 和连续的 `funnel_step`，因此漏斗探索可以直接依据步骤号构建，而不必手工排列事件顺序。

| 事件 | 步骤 | 触发位置 | 参数 |
| --- | --- | --- | --- |
| `login` | 1 | `routes/_authenticated.tsx`，首次解析出 Account 时 | `method` |
| `sign_up` | 1 | 同上，当发起的操作是「创建账号」时 | `method` |
| `agent_created` | 2 | `onboarding-v2/page.tsx`，Server 返回 id 之后 | `runtime_provider` |
| `agent_create_failed` | — | 同上，创建被拒绝时 | `reason`：`name_conflict` 或 `error` |
| `computer_connect_started` | — | `features/computer-connect/computer-connect.tsx`，命令展示时 | `mode` |
| `computer_connected` | 3（仅当 `mode` 为 `create`） | 同上，兑换后的 Computer 上线时 | `mode` |
| `agent_setup_stage_reached` | — | `onboarding-v2/agent-setup-page.tsx`，每个 Agent 每个 stage 一次 | `stage` |
| `agent_setup_completed` | — | 同上，stage 首次读到 `ready` 时 | — |
| `first_conversation_observed` | 4 | `features/agents/agents-page.tsx`，Agent 列表首次出现 Task 时 | — |
| `page_view` | — | `analytics/route-analytics.ts`，每次解析出的路由模板 | 由路由推导的 location |

漏斗要回答的三段转化，就是步骤 1→2、2→3、3→4 之间的流失。

`mode: "repair"` 的 `computer_connected` **不携带** `funnel_step`：它重连的是 Account 本就拥有的 Computer，计入会让同一位用户再次「到达」步骤 3，从而抬高该步骤、压低其后的流失。该事件本身仍值得保留 —— 修复意味着有人正在自救。

### 两条登录路径都无法自己上报

密码表单在会话 Cookie 到达后立刻整页跳转，紧贴该调用发出的事件会与 unload 竞争；身份提供方则完全离开应用，再经 Server 重定向返回，而重定向不携带任何标记。但两者在离开之前都知道登录方式，因此该方式被写入 session storage（`analytics/sign-in-intent.ts`），由落地页读取一次。读取即消费，所以带着既有会话回访的用户会被识别身份，但不会上报登录事件。

重定向类登录只能在**按下按钮时**记录，而按下按钮还不等于登录成功 —— 否则用户在授权页放弃后，下一个已登录页面就会把它变成一次从未发生的 `login`。因此意图会带上时间戳并在十分钟后过期：足够走完授权页与二次验证，又远短于一个工作日。

由于 `page_view` 以路由模板为键，`/agents/A` → `/agents/B` 只算**一次** page view，而不是两次。这是刻意为之 —— 报告本来就按此归组 —— 但也意味着该事件无法回答「用户打开了多少个 Agent 详情页」。

### `first_conversation_observed` 天然低估

对话发生在 Slack 或飞书，而不是 Web App 里，且 Task 相关视图不做轮询。Agent 列表是唯一既按间隔重读、又带 Task 计数的界面。由此带来三点后果，且都只会**丢失**事件：

- **滞后与幸存者偏差。** 事件在列表下次被打开时才触发 —— 时间偏晚；而对于连接完电脑、与 Agent 对话后再没回到站点的用户，则永远不会触发。这与事实恰好相反：一个满意到不再回访的用户，会被记成步骤 3 的流失。
- **三十天窗口。** `usage.tasks` 是滚动三十天的聚合值（`AgentUsageSummarySchema` 将 `windowDays` 固定为 30），而非终身计数。若某 Agent 的对话全部早于该窗口，在这里就会读成「从未对话」。
- **只代表已受理，不代表已完成。** `usage.tasks > 0` 意味着消息已被受理；是否完成记录在 turn report 中，而本应用从不轮询那个界面。

**请把步骤 4 视为真实转化的下界，绝不可读作「曾经产生过对话的用户数」。** 要做到精确，需要在 turn report 落库处经由 GA4 Measurement Protocol 在服务端上报；本次刻意未实现。

### 事件计数以对象为单位，而非以用户为单位

步骤 2、3、4 都是按 Agent 或按 Computer 上报的，因此一个拥有五个在对话的 Agent 的账号会贡献五次步骤 4 事件。漏斗探索是以用户为范围的，所以转化**率**不受影响 —— 但任何针对这些步骤的原始事件数报告都会偏高。

## 绝不发送什么

- **不发送邮箱、显示名、Agent 名称。** 唯一标识是 Account 自身的 uuid，作为 `user_id` 设置，使漏斗能跨设备延续。
- **绝不发送地址栏内容 —— 路径来自路由，而非 URL。** `page_path` 与 `page_location` 由**匹配到的路由的声明路径**投影而来：`/agents/$agentId/settings/$section` 变成 `/agents/:agentId/settings/:section`。某个值能进入报告，只可能是因为某个路由文件为该参数命名。

  最初尝试过按「形状」判别地址，事实证明并不可靠，这里记录下来以免被重新引入：本仓库的路由声明了自由格式参数，因此 `/agents/<uuid>/settings/<任意内容>` 也能匹配并渲染，而任何基于段长度或字符集的规则都无法区分「小节名」与「密钥」。凡是路由未能匹配的地址 —— 包括 `/invites/<token>`，它会渲染 not-found 页面而不是匹配失败 —— 一律上报为唯一的常量路径 `/(not-found)`，不携带地址中的任何内容。
- **营销参数按 key 白名单，且其 value 依然不被信任。** 查询串中只有 `utm_*`、`gclid` 等能存活。它们的值由构造链接的人写入，因此形如邮箱地址或长度异常的值会被丢弃，而不是假定对方读过相关规范就照单转发。这也是上面「不发送邮箱」这一说法的诚实边界：它保证的是**本应用**不发送，而营销参数的值来自调用方。
- **referrer 只保留 origin。** 应用内跳转上报上一页的模板；文档首次展示时上报来源站点的裸 origin。不透明 origin（Android 应用、`about:` 文档）上报为「无」，而不是字面量 `"null"`。
- **不发送广告信号。** `allow_google_signals` 与 `allow_ad_personalization_signals` 均已关闭。
- **不上报 `/internal` 下的任何内容。** 预览 Lab 用内存适配器驱动真实组件，在那里「创建」的 Agent 并不是 Agent。仅仅拒绝本应用自己的调用并不够 —— 增强型衡量会自行发出滚动、点击、下载与表单事件 —— 因此该排除是在 tag 层面用 Google 的 `ga-disable-<id>` 开关实施的，并与路由保持同步，从而同时覆盖直接进入与后续跳转两种情况。
- **会话结束后不再携带身份，两条退出路径都覆盖。** 一个会话恰好有两种结束方式：用户点击「退出登录」（`endSession`），或会话过期、Server 拒绝下一次 `/me`（`_authenticated.tsx` 中的 401 分支）。两者都会清空 `user_id`，也都有回归测试保护 —— 过期是更常见的那一条，而它由「重新联网触发的重新校验」引发，该行为仅在非测试环境开启，因此对应的回归测试会刻意把该行为还原。加载中与网络中断都不会清除任何东西：它们同样表现为「没有账号」，但把它们当作登出会丢掉一个仍然有效的会话的身份。

## 必需的属性设置

Web App 自行发送由路由推导的 `page_view`，并以 `send_page_view: false` 配置 tag。而 GA4 的增强型衡量还会在浏览器历史变化时另发一次 page view，且读取的是原始地址。

**请在 GA4 网页数据流中关闭「基于浏览器历史记录事件的网页更改」。** 保持开启会重复统计 page view，并把投影所移除的地址重新引入。作为纵深防御，由路由推导的 location 也会通过 `gtag('set', …)` 记录为默认值，使自动上报的命中携带安全值，但正确的修复仍然是关闭该设置。

在数字具备意义之前，还需要两项后台配置：

- **定义内部流量**（`traffic_type` 等于 `internal`）并将过滤器设为**有效**，详见「开关」一节。
- **注册事件范围自定义维度**：`funnel`、`funnel_step`、`method`、`runtime_provider`、`mode`、`stage`、`reason`。它们需要 24–48 小时才可用于查询，请优先完成，否则探索报告的第一天会是空的。

## 内容安全策略

`packages/server/src/web-app.ts` 显式声明了 `script-src` 以放行 `googletagmanager.com`，并为区域采集端点放宽了 `connect-src` 与 `img-src`。这只是主机放行，仅此而已：没有 `'unsafe-inline'`，因此 Google Analytics 控制台给出的代码片段无法按原样运行，Web App 改为在自己的 bundle 中创建 `dataLayer` 队列（`analytics/gtag.ts`）。

放行是无条件的，而 tag 的加载是有条件的，所以在开发或端到端来源上这些源被允许但从不会被使用。

## 同意机制

没有同意机制，也没有 Cookie 横幅。这项决定属于部署方；上文的开关就是他们手中的控制项。若日后需要同意机制，GA Consent Mode v2 应加在 `installAnalytics` 中。

## 测试

`AnalyticsReporter` 在被 arm 之前是惰性的，因此任何测试都不会因为 import 了某个页面而上报。需要断言事件的测试调用 `analytics.arm(sink)` 传入记录型 sink，并在结束时 `analytics.disarm()` —— 参见 `apps/web/src/__tests__/analytics-funnel.test.tsx`，其中包含针对真实路由树的断言。整个过程不涉及模块 mock。
