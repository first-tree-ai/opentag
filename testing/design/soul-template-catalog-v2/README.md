# Soul template catalog v2

Status: approved catalog. The complete bilingual copy is implemented in `apps/web/messages/agent-settings/{en,zh}.json`;
`soul-templates.test.tsx` verifies every name, summary, overview, and body against this review artifact.

## Complete versions

- [English review copy](catalog.en.md)
- [Simplified Chinese review copy](catalog.zh-CN.md)
- [Bilingual structured catalog](catalog.json)
- [Role-by-role source map](source-map.md)

Each review copy includes all eight templates with icon, list summary, detail overview, and complete body. The review documents adjust heading levels for readability; catalog.json preserves each exact instruction body.

## Proposed first catalog

Keep eight distinct work goals, with Engineering, Design, Product, Research, Writing, Data Analysis, Growth, and Operations. The count remains a scope recommendation, not an empirical optimum. Starting blank remains a direct editing path rather than another role template.

| Name | Icon | Primary work |
| --- | --- | --- |
| Engineering | Code | Build features, fix bugs, and review code. |
| Design | Palette | Design interfaces, flows, and interactions. |
| Product | Compass | Choose priorities and define useful scope. |
| Research | MagnifyingGlass | Investigate questions and weigh evidence. |
| Writing | PenNib | Draft, restructure, and refine content. |
| Data Analysis | ChartBar | Explain metrics, trends, and differences. |
| Growth | TrendUp | Improve acquisition, activation, and retention. |
| Operations | ListChecks | Improve processes and coordinate execution. |

Key boundaries:
- Product selects problems and useful scope; Design specifies the experience; Engineering implements and verifies.
- Research synthesizes source evidence; Data Analysis interprets measured datasets and calculations.
- Writing serves meaning and reader understanding; Growth connects messages and product changes to customer-journey outcomes.
- Operations includes coordination and process improvement, with visible handoffs and completion checks.

## Revision basis

The catalog draws on twelve Agency Agents definitions and eight Awesome OpenClaw Agents definitions. The
[source map](source-map.md) traces each body to pinned original definitions and discloses direct, specialist, adjacent,
workflow, or coordination matches. This acceptance fixture retains the approved copy and its source map; exploratory
audits and superseded design drafts are outside the pull request.

The revision replaces repeated general principles with observable work habits and task-appropriate deliverables. It retains a four-section body, with natural length variation rather than a mandatory word count.

## Presentation and application

- Use Phosphor Regular 20px icons: neutral foreground by default, existing violet for selected items. The icon names were verified in the published 2.1.10 declarations during the first proposal.
- Left list: icon, name, short task summary.
- Right detail: name, brief applicability/benefit overview, then full body expanded by default.
- Only the selected locale's body is inserted, without a hidden prefix or suffix. It remains user-editable text.
- Bodies use the same readable section sequence: Role and purpose, Working approach, Deliverables, and Communication
  style (角色与目标、工作方式、交付要求、沟通风格). Role-specific methods and requirements remain in the complete body.
- Changing the application locale must not silently translate or replace an existing draft or saved Soul.
- Browse templates remains in the page header, with contextual template and writing actions inside one guidance sentence, using the same borderless empty-state recipe as Skills and Connectors.
- Use template fills/replaces the draft. Discard changes restores the latest saved content; Apply changes persists it. No separate template Undo.
- Templates describe behavior and do not grant tools, privileges, integrations, or background scheduling.

## Content lengths

- Engineering: 224 English whitespace-separated words; 440 Chinese-body characters excluding whitespace and Markdown heading markers.
- Design: 231 English whitespace-separated words; 416 Chinese-body characters excluding whitespace and Markdown heading markers.
- Product: 231 English whitespace-separated words; 436 Chinese-body characters excluding whitespace and Markdown heading markers.
- Research: 232 English whitespace-separated words; 424 Chinese-body characters excluding whitespace and Markdown heading markers.
- Writing: 245 English whitespace-separated words; 439 Chinese-body characters excluding whitespace and Markdown heading markers.
- Data Analysis: 232 English whitespace-separated words; 430 Chinese-body characters excluding whitespace and Markdown heading markers.
- Growth: 228 English whitespace-separated words; 440 Chinese-body characters excluding whitespace and Markdown heading markers.
- Operations: 237 English whitespace-separated words; 453 Chinese-body characters excluding whitespace and Markdown heading markers.

These counts describe the current copy rather than product limits. Completeness checks do not replace user selection testing, bilingual editorial review, or behavior evaluation on common tasks.

