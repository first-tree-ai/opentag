# Soul template catalog proposal

Status: content proposal for review. No product code or current presets have been changed.

Source-review status: the original draft drew on sampled research rather than an eight-role source comparison. A later [Agency Agents comparison](../../research/soul-catalog-agency-deep-comparison.md) and [Awesome OpenClaw Agents comparison](../../research/soul-catalog-openclaw-deep-comparison.md) inspect twenty full definitions across all eight proposed roles. They identify missing role-specific methods and output expectations. The catalog bodies have not yet been revised against those findings; do not treat those later readings as the original draft's provenance.

## Proposed scope

Provide eight task-oriented templates: Engineering, Design, Product, Research, Writing, Data Analysis, Growth, and Operations. Preserve the existing five task domains and add research, writing, and numerical analysis as distinct workflows.

- Research investigates external or supplied evidence and supports a decision.
- Data Analysis investigates measured datasets, definitions, calculations, and numerical change.
- Writing improves expression, argument, and editorial quality.
- Growth uses audience, positioning, channels, and experiments to improve acquisition, activation, or conversion.
- Product decides which problems and scope to pursue.
- Design specifies usable experiences.
- Engineering builds and verifies software.
- Operations organizes responsibility and execution.

An empty editor remains directly writable. Starting blank is not counted as a role template and does not need another entry in the template list.

## Catalog metadata

The bilingual [catalog.json](catalog.json) contains the complete proposal: stable id, proposed Phosphor icon name, and name, summary, overview, and body in English and Simplified Chinese. These fields are an editorial artifact, not a new runtime DTO or implementation.

| Template | Phosphor regular icon | List summary |
| --- | --- | --- |
| Engineering | Code (Code brackets) | Build, debug, and review software. |
| Design | Palette (Color palette) | Shape interfaces, flows, and experiences. |
| Product | Compass (Compass) | Clarify needs, priorities, and scope. |
| Research | MagnifyingGlass (Magnifying glass) | Investigate questions and compare evidence. |
| Writing | PenNib (Pen nib) | Draft, edit, and clarify content. |
| Data Analysis | ChartBar (Bar chart) | Understand metrics, trends, and drivers. |
| Growth | TrendUp (Upward trend) | Improve acquisition, activation, and conversion. |
| Operations | ListChecks (Checklist) | Organize actions and move work forward. |

Use one visual icon family: 20px regular outline, neutral foreground by default and the existing brand violet for selection. Register the proposed icons through the current design-system seam during implementation. Icons supplement the visible template names.

## Placement in the agreed interaction

- Left template row: icon, name, and concise task-oriented summary.
- Right template detail: name, one brief overview of applicability and expected help, then the full body expanded by default.
- The overview is catalog guidance; only the body is inserted into the editor.
- The body contains all of its own instructions. There is no hidden template-specific prefix or suffix.
- Using a template replaces the draft without saving or changing capabilities.
- Users may edit freely, then Discard changes or Apply changes. The separate template Undo action remains omitted as agreed.
- Browse templates remains available in the page header; the initial empty editor also provides the contextual text link.

## Content structure and length

Every body contains four sections: Role and goal, How you work, What you deliver, and How you communicate. The English wording is independently authored and the Chinese localization preserves its practical meaning.

- Engineering: 219 English whitespace-separated words; 401 Chinese-body characters excluding whitespace and Markdown heading markers.
- Design: 224 English whitespace-separated words; 416 Chinese-body characters excluding whitespace and Markdown heading markers.
- Product: 232 English whitespace-separated words; 413 Chinese-body characters excluding whitespace and Markdown heading markers.
- Research: 229 English whitespace-separated words; 412 Chinese-body characters excluding whitespace and Markdown heading markers.
- Writing: 231 English whitespace-separated words; 423 Chinese-body characters excluding whitespace and Markdown heading markers.
- Data Analysis: 229 English whitespace-separated words; 422 Chinese-body characters excluding whitespace and Markdown heading markers.
- Growth: 221 English whitespace-separated words; 411 Chinese-body characters excluding whitespace and Markdown heading markers.
- Operations: 227 English whitespace-separated words; 415 Chinese-body characters excluding whitespace and Markdown heading markers.

The intended scale is roughly 180–280 English words and 300–500 Chinese characters per template. These are editorial guides rather than proposed validation limits in product code.

## Research basis

See the [source-backed research note](../../research/agent-instructions-role-libraries.md).

- [Agency Agents](https://github.com/msitarzewski/agency-agents): distinguish role goals, decisions, behavior, and deliverables.
- [Awesome OpenClaw Agents coordinator](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/productivity/orion/SOUL.md), [reviewer](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/development/code-reviewer/SOUL.md), and [writer](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/marketing/echo/SOUL.md): concrete role behavior and readable moderate-length organization.
- [Awesome Copilot](https://github.com/github/awesome-copilot): keep short browsing descriptions separate from full instruction bodies.
- [OpenClaw Soul](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/SOUL.md): independent judgment, practical help, honest communication, and proportionate detail.

The eight-role scope, icon mapping, names, and all proposed copy are original editorial decisions for OpenTag. They have not been benchmarked or adopted by the product. No upstream role file is copied into this proposal. The bodies avoid invented professional histories, fixed technology stacks, unavailable collaboration protocols, mandatory questioning for every request, and claims that template selection grants tools, persistent memory, or automatic outbound execution.

## Review checklist

- Can a user choose by the summary without reading every template?
- Does each overview explain applicable work and useful outcomes?
- Does the full body create a meaningful behavioral difference from adjacent roles?
- Do both locales preserve scope, factual rigor, and proportionate communication?
- Does the editor receive exactly the visible body, independently of current UI locale after application?

