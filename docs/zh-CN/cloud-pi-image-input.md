# Cloud Pi 图片输入

Cloud Pi 的临时自定义模型必须为已确认支持图片的模型声明 `input: ["text", "image"]`。
Pi 0.84.2 会将未声明 `input` 的自定义模型默认设为 `["text"]`；其原生 `read` 工具随即报告图片将被省略，
OpenAI 兼容适配器也不会在模型请求中发送图片。

## 能力依据

Router 模型列表和现有执行授权包含准确的模型 ID、上下文窗口和输出预算，但没有输入模态。
因此，Runner 使用一个小型、显式的能力快照，描述 Server 已经准入的准确模型 ID。
它不使用模型家族前缀、别名、正则表达式或默认开启图片的策略。该快照不能授权模型；
可执行的模型仍由 Server 目录和执行令牌控制。

核验日期：2026-10-10。

| 准确的 Cloud 模型 ID | 支持文本和图片输入的依据 |
| --- | --- |
| `gemini-3.8-flash` | [Google 模型规格](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| `gemini-3.1-flash-lite` | Pi 0.84.2 内置 `google` 和 `google-vertex` 模型元数据：`input: ["text", "image"]` |
| `glm-5.3-flash` | Pi 0.84.2 内置 `zai` 模型元数据：`input: ["text", "image"]` |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Pi 0.84.2 内置 `openai` 模型元数据：`input: ["text", "image"]` |
| `gpt-6-astra` | [OpenAI 模型对比](https://developers.openai.com/api/docs/models/compare) |
| `gpt-6-sol`, `gpt-6-luna` | [OpenAI 更新日志，2026-09-22](https://developers.openai.com/api/docs/changelog) |
| `claude-opus-5`, `claude-sonnet-5` | Pi 0.84.2 内置 `anthropic` 模型元数据：`input: ["text", "image"]` |
| `claude-fable-5.1`, `claude-opus-5.5` | [Anthropic 模型概览](https://platform.claude.com/docs/en/models/overview) |
| `kimi-k3` | Pi 0.84.2 内置 `moonshotai` 模型元数据：`input: ["text", "image"]` |
| `deepseek-v4.1-flash` | [DeepSeek V4.1 Flash 发布说明](https://api-docs.deepseek.com/news/news260910/) |

Pi 元数据来自锁定依赖 `@earendil-works/pi-ai` 的 `dist/providers/data/*.json`。
该快照中的 `glm-5.3` 仅支持文本；`glm-5.3-flashx` 没有经过核验的图片声明。两者继续使用 `["text"]`。
所有未知 ID，包括已知模型的新别名，也继续使用 `["text"]`，直至完成核验。添加模型时，
先核验准确的 ID 和上游图片支持，再更新此快照。若 Router 以后发布经过核验的模态信息，
可另做兼容的协议变更，以 Server 下发的元数据替代此快照。

## 行为和验证边界

IM 入口继续提供文本和原生资源 ID，Agent 仅在需要时下载并读取原图。
此变更不会增加 Server 下载、OCR、转录、提取、采样或预处理。
Pi 保留原生图片处理；上下文窗口、输出预算、凭证、代理路由和授权均不变。
旧授权文档继续有效，纯文本请求继续正常工作。

`cloud-pi-image-input.test.ts` 使用生产文档生成器和现有格式的授权，启动锁定版本的真实 Pi CLI，
并连接本地回环模型端点。测试要求调用原生 `read` 工具，检查初始文本请求不含图片，
并核验 Gemini 3.8 Flash 的下一笔认证请求包含准确的小 PNG data URL。
仅支持文本和未知模型的对照检查图片部分仍然缺失，且 Pi 报告省略图片。
该端点提供确定性的工具调用和文本，因此证明的是传输，不是真实 Provider 的图片识别。
部署和线上 Slack/飞书图片识别需要独立的验收证据。
