# Open-source Soul and role instruction references for OpenTag

Retrieved: 2026-10-20. Scope: actual role instruction source files, not only framework documentation or link directories. No product code was changed.

## Verified repositories

Star counts are a point-in-time observation from GitHub's public REST API and will change. MIT is the license reported by that API and linked repository license file. Popularity does not demonstrate instruction quality or task effectiveness.

| Repository | Stars observed | License | Inspected default-branch commit | Relevance |
| --- | ---: | --- | --- | --- |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | 161,834 | [MIT](https://github.com/msitarzewski/agency-agents/blob/main/LICENSE) | `4e3ac3ca6604c75113f52c695dbddcc7af928b46` | Broad specialist personalities spanning engineering, design, product, and marketing |
| [wshobson/agents](https://github.com/wshobson/agents) | 41,179 | [MIT](https://github.com/wshobson/agents/blob/main/LICENSE) | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` | Specialist agents inside a multi-tool plugin marketplace |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | 25,872 | [MIT](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/LICENSE) | `408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e` | Claude Code subagents categorized by work domain |

Metadata sources: [Agency GitHub API](https://api.github.com/repos/msitarzewski/agency-agents), [wshobson GitHub API](https://api.github.com/repos/wshobson/agents), [VoltAgent GitHub API](https://api.github.com/repos/VoltAgent/awesome-claude-code-subagents). License files were also resolved through each repository's `/license` REST endpoint. Commit IDs were retrieved through `/commits/main`.

## 1. Agency Agents: the closest broad role library

The [README](https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/README.md) describes agent files organized around personality, mission, workflow, deliverables, and success criteria; it provides installations for multiple tools and explicitly supports adapting files as reference material.

Sample lengths below count whitespace-separated words in the whole Markdown file, including frontmatter, examples, and code. They are not token counts.

| Real instruction file | Approximate length | Observed structure |
| --- | ---: | --- |
| [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/engineering/engineering-frontend-developer.md) | 1,173 words / 231 lines | Identity, mission, rules, code example, workflow, deliverable template, communication, memory, success metrics, advanced capabilities |
| [UI Designer](https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/design/design-ui-designer.md) | 1,673 words / 386 lines | Identity, design mission, constraints, substantial CSS/token examples, workflow, deliverables, communication, success measures |
| [Product Manager](https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/product/product-manager.md) | 3,692 words / 469 lines | Named persona, principles, mission, rules, several artifact templates, lifecycle workflow, communication examples, success metrics |

**Useful for OpenTag:** The files demonstrate meaningful differences in how roles behave and what they deliver. The shared authoring pattern can inform consistent Engineering, Design, Product, Growth, and Operations templates.

**Adaptation limits:** These examples are considerably longer than a moderate-length consumer-facing template. They embed code, artifact scaffolds, fixed success targets, and asserted professional histories or memory. The frontend sample also includes editor-extension requirements beyond ordinary frontend work. OpenTag should extract relevant behavior and omit invented experience, unsupported memory claims, mandatory metrics, and unrelated implementation detail. These are editorial judgments from inspecting the linked files, not measured performance findings.

## 2. VoltAgent: explicit execution steps, with runtime assumptions

The [README](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e/README.md) presents 161-plus Claude Code subagents across ten categories and documents per-category plugin installation and Markdown agent installation.

| Real instruction file | Approximate length | Observed structure |
| --- | ---: | --- |
| [Frontend Developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e/categories/01-core-development/frontend-developer.md) | 588 words / 133 lines | Role, context gathering, execution, JSON progress protocol, handoff, technical requirements, other-agent integration |
| [Product Manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e/categories/08-business-product/product-manager.md) | 901 words / 287 lines | Invocation steps, competency checklists, context protocol, discovery/delivery workflow, progress payload, other-agent integration |

**Useful for OpenTag:** Concrete steps such as gathering context before asking questions, analyzing evidence before deciding, and providing a clear handoff are better raw material than vague claims of expertise.

**Adaptation limits:** The frontend agent mandates contacting a `context-manager`; the product agent also assumes a context manager and collaborator agents. Both specify Claude-style tools and model choices in frontmatter. Their JSON protocols and example success figures are not appropriate defaults for an independent OpenTag agent. Reuse the work principles only after removing runtime dependencies, fixed metrics, and output boilerplate. This is a source-based adaptation assessment.

## 3. wshobson: structured specialization inside a larger marketplace

The [README](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/README.md) describes a shared Markdown source adapted to multiple coding tools. It reports 202 local agent files, 185 skills, and 105 commands across 92 local plugins, plus two external plugin entries. The marketplace is broader than a library of user-editable Soul prompts.

| Real instruction file | Approximate length | Observed structure |
| --- | ---: | --- |
| [Frontend Developer](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/frontend-mobile-development/agents/frontend-developer.md) | 946 words / 164 lines | Purpose, capability domains, behavioral traits, knowledge, response approach, example tasks |
| [UI Designer](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/ui-design/agents/ui-designer.md) | 826 words / 125 lines | Purpose, component/layout/visual capabilities, behavioral traits, knowledge, response approach, example tasks |
| [Backend Architect](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/backend-development/agents/backend-architect.md) | 2,171 words / 309 lines | Purpose, philosophy, extensive capability catalogue, behaviors, workflow position, task examples, role boundaries, expected outputs |

**Useful for OpenTag:** The separation between behavioral traits, response approach, and example tasks is clear. Backend Architect explicitly distinguishes its responsibilities from adjacent roles, which can help authors avoid overlap between OpenTag templates.

**Adaptation limits:** The capability lists are long and version-specific; the frontend role names React and Next.js versions and ecosystem choices. Those choices would narrow a general Engineering Soul unnecessarily. Keep reusable judgment, workflow, and delivery principles; move technology knowledge and specialized procedures into task-specific instructions or skills. This is an editorial inference, not an experimentally validated design.

## 4. Awesome OpenClaw Agents: directly relevant SOUL.md templates

The [repository](https://github.com/mergisi/awesome-openclaw-agents) has 4,014 stars and an MIT license according to the [GitHub REST metadata](https://api.github.com/repos/mergisi/awesome-openclaw-agents), retrieved on 2026-10-20. The README contains task-oriented selection tables with specialty, when-to-use descriptions, and links to the actual SOUL files. Its counts differ between repository description and README, so this report does not treat either advertised template count as verified.

| Real instruction file | Approximate whole-file length | Observed structure |
| --- | ---: | --- |
| [Orion: coordinator](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/productivity/orion/SOUL.md) | 305 words | Identity, responsibilities, behavior, communication, interaction example, integration notes |
| [Lens: code reviewer](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/development/code-reviewer/SOUL.md) | 498 words | Identity, responsibilities, behavior, severity levels, example reviews, integration notes |
| [Echo: writer](https://github.com/mergisi/awesome-openclaw-agents/blob/main/agents/marketing/echo/SOUL.md) | 401 words | Identity, responsibilities, channel styles, behavior, examples, output formats |

**Useful for OpenTag:** These examples give a practical moderate-length comparison, with concrete behavior and a small amount of demonstration. The catalog's when-to-use metadata directly addresses template selection.

**Adaptation limits:** Some prompts assume named collaborator agents, a fixed amount of parallelism, messaging or calendar integrations, and automatic PR commenting. Examples also contain asserted figures and narrowly framed technical fixes. Such details are illustrative upstream text, not verified capabilities or advice for OpenTag. Read them as authoring references, then write independent instructions grounded in OpenTag's actual capabilities.

## 5. Awesome Copilot: metadata and complete instruction bodies

The [repository](https://github.com/github/awesome-copilot) has 40,199 stars and an MIT license according to the [GitHub REST metadata](https://api.github.com/repos/github/awesome-copilot), retrieved on 2026-10-20. It contains actual `.agent.md` definitions as well as instructions, skills, and other customizations.

Two inspected examples are [Product Manager Advisor](https://github.com/github/awesome-copilot/blob/main/agents/se-product-manager-advisor.agent.md), approximately 984 whole-file words, and [UX/UI Designer](https://github.com/github/awesome-copilot/blob/main/agents/se-ux-ui-designer.agent.md), approximately 1,587 whole-file words. Their frontmatter separates display names and descriptions from tools/model settings and the full body. The [agent authoring guidelines](https://github.com/github/awesome-copilot/blob/main/instructions/agents.instructions.md) document this pattern.

**Useful for OpenTag:** Separate a short, task-oriented catalog description from the instruction body, so the browser can support quick decisions while the preview shows actual instructions. The examples express specific expected deliverables rather than only role names.

**Adaptation limits:** These two samples are prescriptive workflow agents. The product role mandates GitHub issues and specific labels for code changes; the UX role emphasizes research artifacts and manual translation to Figma. Tools, models, fixed artifacts, mandatory questioning, and repository procedures require adaptation. They are not universal defaults for Product or Design Soul templates.

## 6. OpenClaw: a high-star reference for identity and behavioral voice

The [OpenClaw repository](https://github.com/openclaw/openclaw) has 392,822 stars and an MIT license according to the [GitHub REST metadata](https://api.github.com/repos/openclaw/openclaw), retrieved on 2026-10-20. This is the popularity of the whole agent product, not a separate Soul-template collection.

Its actual [SOUL.md template](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/SOUL.md) contains approximately 261 whitespace-separated words including documentation frontmatter and related links. It groups instructions under core truths, boundaries, voice, and continuity. It emphasizes practical help, independent judgment, resourcefulness, respect for private context, and variable response detail.

**Useful for OpenTag:** This is a direct example of persistent behavioral identity rather than a long capability catalogue. Its sectioning and voice can inform shared principles across role-specific templates.

**Adaptation limits:** The template describes workspace-file memory and self-evolution. OpenTag must independently establish any comparable persistence or editing behavior. It is one baseline Soul, not a library of Engineering, Design, Product, Growth, and Operations roles.

## Additional candidates checked

[madhvantyagi/SOUL.md](https://github.com/madhvantyagi/SOUL.md) had 431 stars and [ClawSouls](https://github.com/clawsouls/clawsouls) had 21 stars in the same GitHub REST lookup. They are relevant to persona sharing, but are omitted from the high-star shortlist. A repository name containing SOUL does not by itself satisfy the requested popularity filter.

## Implications for OpenTag's template content

1. Use these repositories to compare role behavior and content structure, rather than copying their complete files into Soul.
2. A moderate-length template should prioritize the role's goal, working decisions, uncertainty handling, output expectations, and communication style. Domain expertise lists alone do not explain behavior.
3. Keep template browsing metadata separate from the actual instruction body. A short task-oriented description helps selection; the full editable instructions remain the source of truth.
4. The inspected sources range from a roughly 260-word baseline Soul, through 300–500-word role templates, to files exceeding 3,000 words. This is evidence of real authoring approaches, not evidence that longer prompts perform better. Moderate templates can include concrete behaviors without importing full workflow manuals. Determine OpenTag's length through coherent content and actual task evaluation.
5. Preserve applicable license notices when copying or substantially adapting source material. No upstream instructions have been imported into OpenTag in this research.

## Retrieval method

Repository metadata, recursive file trees, license paths, and default-branch commit IDs came from public GitHub REST endpoints. Source bodies and READMEs were read from `raw.githubusercontent.com`; the links above pin the observed commits for repeatable review. Word and line counts were calculated from the downloaded Markdown strings with `split()` and `splitlines()`. These counts include source formatting and should only guide rough comparison.
