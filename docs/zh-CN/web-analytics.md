# Web App 分析

[English](../web-analytics.md)

Web App 会向 Google Analytics 4 上报一条激活漏斗。本文说明测量了什么、刻意不发送什么，以及一项代码自身无法完成、必须在 GA4 属性里设置的配置。

## 开关

是否测量完全在浏览器侧决定，由 `apps/web/src/analytics/config.ts` 判断：

- 必须是 production 构建，这排除了所有开发服务器；并且
- hostname 不能是 loopback，这排除了端到端测试栈、`vite preview`，以及任何本地运行的 `apps/web/dist`。

任一条件不满足时什么都不会发生 —— 不加载 tag，也不排队任何事件。这里没有环境变量：每个 commit 只构建一个镜像并原样推到各环境，构建期的值无法区分环境，而运行期的值又要为一个永不变化的常量绕经 Server。

需要接受的后果：**staging 与生产上报到同一个属性。** 请在 Google Analytics 中按 hostname 区分。

## 测量了什么

每个漏斗节点都带 `funnel: "activation"` 和连续的 `funnel_step`，因此漏斗探索可以直接依据步骤号构建，而不必手工排列事件顺序。

| 事件 | 步骤 | 触发位置 | 参数 |
| --- | --- | --- | --- |
| `login` | 1 | `routes/_authenticated.tsx`，首次解析出 Account 时 | `method` |
| `sign_up` | 1 | 同上，当发起的操作是「创建账号」时 | `method` |
| `agent_created` | 2 | `onboarding-v2/page.tsx`，Server 返回 id 之后 | `runtime_provider` |
| `agent_create_failed` | — | 同上，创建被拒绝时 | `reason`：`name_conflict` 或 `error` |
| `computer_connect_started` | — | `features/computer-connect/computer-connect.tsx`，命令展示时 | `mode` |
| `computer_connected` | 3 | 同上，兑换后的 Computer 上线时 | `mode` |
| `agent_setup_stage_reached` | — | `onboarding-v2/agent-setup-page.tsx`，每个 Agent 每个 stage 一次 | `stage` |
| `agent_setup_completed` | — | 同上，stage 首次读到 `ready` 时 | — |
| `first_conversation_observed` | 4 | `features/agents/agents-page.tsx`，Agent 列表首次出现 Task 时 | — |
| `page_view` | — | `analytics/route-analytics.ts`，每次路由解析 | 已脱敏的 location |

漏斗要回答的三段转化，就是步骤 1→2、2→3、3→4 之间的流失。

### 两条登录路径都无法自己上报

密码表单在会话 Cookie 到达后立刻整页跳转，紧贴该调用发出的事件会与 unload 竞争；身份提供方则完全离开应用，再经 Server 重定向返回，而重定向不携带任何标记。但两者在离开之前都知道登录方式，因此该方式被写入 session storage（`analytics/sign-in-intent.ts`），由落地页读取一次。读取即消费，所以带着既有会话回访的用户会被识别身份，但不会上报登录事件。

### `first_conversation_observed` 天然低估

对话发生在 Slack 或飞书，而不是 Web App 里，且 Task 相关视图不做轮询。Agent 列表是唯一既按间隔重读、又带 Task 计数的界面，因此该事件在列表下次被打开时才触发 —— 时间偏晚；而对于连接完电脑、与 Agent 对话后再没回到站点的用户，则永远不会触发。

**请把步骤 4 视为真实转化的下界，而非估计值。** 要做到精确，需要在 turn report 落库处经由 GA4 Measurement Protocol 在服务端上报；本次刻意未实现。

## 绝不发送什么

- **不发送邮箱、显示名、Agent 名称。** 唯一标识是 Account 自身的 uuid，作为 `user_id` 设置，使漏斗能跨设备延续。
- **不发送原始 URL。** `analytics/page-location.ts` 只用被允许保留的部分重建 location：origin、把每个 uuid 与整数段归约为 `:id` 的路由模板，以及一份营销参数白名单（`utm_*`、`gclid` 等）。查询串中的其余部分一律丢弃，因此日后新增的参数默认是私有的。同源 referrer 适用同一规则；外部 referrer 只保留 origin。
- **不发送广告信号。** `allow_google_signals` 与 `allow_ad_personalization_signals` 均已关闭。
- **不上报 `/internal` 下的任何内容。** 预览 Lab 用内存适配器驱动真实组件，在那里「创建」的 Agent 并不是 Agent。

## 必需的属性设置

Web App 自行发送脱敏后的 `page_view`，并以 `send_page_view: false` 配置 tag。而 GA4 的增强型衡量还会在浏览器历史变化时另发一次 page view，且读取的是原始地址。

**请在 GA4 网页数据流中关闭「基于浏览器历史记录事件的网页更改」。** 保持开启会重复统计 page view，并把脱敏器刚刚移除的标识符重新引入。作为纵深防御，脱敏后的 location 也会通过 `gtag('set', …)` 记录为默认值，使自动上报的命中携带安全值，但正确的修复仍然是关闭该设置。

## 内容安全策略

`packages/server/src/web-app.ts` 显式声明了 `script-src` 以放行 `googletagmanager.com`，并为区域采集端点放宽了 `connect-src` 与 `img-src`。这只是主机放行，仅此而已：没有 `'unsafe-inline'`，因此 Google Analytics 控制台给出的代码片段无法按原样运行，Web App 改为在自己的 bundle 中创建 `dataLayer` 队列（`analytics/gtag.ts`）。

放行是无条件的，而 tag 的加载是有条件的，所以在开发或端到端来源上这些源被允许但从不会被使用。

## 同意机制

没有同意机制，也没有 Cookie 横幅。这项决定属于部署方；上文的开关就是他们手中的控制项。若日后需要同意机制，GA Consent Mode v2 应加在 `installAnalytics` 中。

## 测试

`AnalyticsReporter` 在被 arm 之前是惰性的，因此任何测试都不会因为 import 了某个页面而上报。需要断言事件的测试调用 `analytics.arm(sink)` 传入记录型 sink，并在结束时 `analytics.disarm()` —— 参见 `apps/web/src/__tests__/analytics-funnel.test.tsx`。整个过程不涉及模块 mock。
