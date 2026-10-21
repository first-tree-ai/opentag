# Awesome OpenClaw Agents comparison against the proposed Soul catalog

Inspected: 2026-10-20. Repository tree: `05820c51125e86a979432e21651d34dc9b14621f`, obtained from the [GitHub tree API](https://api.github.com/repos/mergisi/awesome-openclaw-agents/git/trees/main?recursive=1). Eight full source files were read from commit-pinned raw URLs. The target is the existing [eight-template catalog](../design/soul-template-catalog/catalog.json). This note does not change that draft or product code.

## Conclusion

The earlier draft used OpenClaw examples mainly for structure, readable role instructions, and length. It was not a complete eight-role adaptation. This follow-up establishes an explicit source comparison and identifies substantive revision opportunities. It does not retroactively establish that the original draft was based on these newly inspected files.

Match quality varies: the repository often provides a specialized task agent rather than a broad Engineering, Design, Product, or Growth role. Such matches are marked below. Reading upstream definitions reveals useful methods but does not establish their effectiveness.

## Comparison

### Engineering

Source: [agents/automation/overnight-coder/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/automation/overnight-coder/SOUL.md) (620 whole-file whitespace-separated words).

**Match:** Partial: scheduled implementation workflow, not a general Engineering persona.

**Observed in source:** Read existing code first, establish a baseline, preserve project patterns, verify changes, and provide review-ready change notes.

**Adaptation judgment:** Use the implementation discipline and final change review. Make code review findings concrete and keep unrelated improvements separate from the requested change.

**Do not import:** Do not import midnight schedules, automatic PRs or notifications, all-tests-for-every-task rules, invented timing, or assumed repository/tool access.

### Design

Source: [agents/creative/ux-researcher/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/creative/ux-researcher/SOUL.md) (992 whole-file whitespace-separated words).

**Match:** Partial and adjacent: user research rather than a general UI/design definition.

**Observed in source:** Specify a research question, distinguish stated preferences from observed behavior, group feedback into themes, and connect findings to product decisions.

**Adaptation judgment:** Make evidence behind a design decision visible and distinguish validated findings from assumptions. Use the Agency UI/UX sources for component specifications and implementation QA.

**Do not import:** Do not imply direct access to session recordings or survey systems. Do not make this research-only definition stand in for all of Design or reproduce sample participant counts as requirements.

### Product

Source: [agents/saas/product-scrum/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/saas/product-scrum/SOUL.md) (830 whole-file whitespace-separated words).

**Match:** Partial: agile delivery and backlog management, not full product strategy.

**Observed in source:** Break epics into actionable stories, include acceptance criteria, connect scope to capacity, and investigate changes in delivery performance.

**Adaptation judgment:** Use clear acceptance and completion criteria when a delivery plan is needed, while taking broader discovery and prioritization from Agency Product Manager.

**Do not import:** Do not impose Scrum, story points, locked sprints, 8-point splitting thresholds, fixed carryover limits, or delivery predictions on every product task.

### Research

Source: [agents/education/research-assistant/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/education/research-assistant/SOUL.md) (650 whole-file whitespace-separated words).

**Match:** Strong for academic research; partial for general investigation.

**Observed in source:** Refine the question, search with explicit terms, summarize methods/findings/limitations, organize literature by themes, and preserve traceable citations.

**Adaptation judgment:** Explain actual search coverage and source limitations. Synthesize around the user's question and distinguish original claims from repetitions. The latter independence rule is more explicit in Agency Research Synthesist.

**Do not import:** Do not force academic citation formats for ordinary product or technical research. Sample paper citations and DOIs in the prompt are illustrations, not verified evidence for this project.

### Writing

Source: [agents/creative/proofreader/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/creative/proofreader/SOUL.md) (585 whole-file whitespace-separated words).

**Match:** Adjacent editing specialization; combine with the previously inspected Echo writing role.

**Observed in source:** Preserve author voice, enforce terminology and style consistency, explain substantive edits, and distinguish errors, suggestions, and optional style preferences.

**Adaptation judgment:** For editing tasks, separate objective corrections from subjective alternatives and preserve deliberate voice. For longer documents, review structure before polishing sentences.

**Do not import:** Do not always require a before/after table, forbid paragraph rewrites when rewriting is requested, force an English house style, or assert unmeasured readability scores.

### Data Analysis

Source: [agents/business/radar/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/business/radar/SOUL.md) (450 whole-file whitespace-separated words).

**Match:** Strong for business analysis and reporting; narrower than all data analysis.

**Observed in source:** Give numerical context and a comparison baseline, identify actionable insights, avoid drowning the reader in metrics, and show a clear practical implication.

**Adaptation judgment:** Make the output contract concrete: result, baseline, method, limitations, and next action. Preserve our existing metric-definition and reproducibility rules.

**Do not import:** Do not require ASCII charts or percentages for every task. Independently check example calculations and labels: the source's 48% to 42% bounce-rate example is a 6-percentage-point change, while the relative change is -12.5%.

### Growth

Source: [agents/marketing/ab-test-analyzer/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/marketing/ab-test-analyzer/SOUL.md) (290 whole-file whitespace-separated words).

**Match:** Partial experimentation specialization; broad growth coverage comes from Agency Growth Hacker.

**Observed in source:** Plan experiment duration and sample size, report uncertainty, look for novelty/segment effects, and make the result useful for a decision.

**Adaptation judgment:** Connect growth work to the actual funnel bottleneck, retention, acquisition economics, and downstream customer quality. Use an experiment's primary metric, guardrail, and next decision when an experiment is requested.

**Do not import:** Do not import the blanket English-only instruction, a universal 95%-significance decision rule, fixed numerical example results, automatic alerts, or assumed analytics integrations.

### Operations

Source: [agents/productivity/orion/SOUL.md](https://github.com/mergisi/awesome-openclaw-agents/blob/05820c51125e86a979432e21651d34dc9b14621f/agents/productivity/orion/SOUL.md) (305 whole-file whitespace-separated words).

**Match:** Strong for coordination; incomplete for process improvement.

**Observed in source:** Break work into actions, clarify priorities, identify handoffs, expose blockers, and keep updates action-oriented.

**Adaptation judgment:** Retain owners/dependencies and add the Agency operations loop: current flow, waiting/rework, improvement, verification, handoff, and exception handling.

**Do not import:** Do not assume other named agents, five-way parallel execution, calendars, reminders, or automatic follow-up. Do not require every response to celebrate milestones or ask a question.

## Relationship to Agency Agents comparison

Read the [Agency Agents deep comparison](soul-catalog-agency-deep-comparison.md) alongside this note. That investigation inspected twelve additional definitions and provides direct broader role matches for Product, Research, Data Analysis, Growth, and Operations, and composite matches for Engineering, Design, and Writing.

The two investigations cover twenty full role files in this round. Their purpose is to compare source methods, behavioral emphasis, and expected deliverables with the earlier proposal. This source reading is not a benchmark of any model or prompt.

## Highest-priority revisions

1. Replace repeated generic prose with a few observable decision rules per role.
2. Engineering: final change review, actionable review findings, and scoped follow-ups.
3. Design: existing component/token reuse, precise handoff, and implementation review.
4. Product: build, investigate, defer, or stop; explicit non-goals and outcome review.
5. Research: disclosed coverage, independent evidence, circular-citation awareness, and missing evidence.
6. Writing: reader progression, structure before sentence polish, and correction versus preference.
7. Data Analysis: baseline/method/limitation/action output, practical importance, and explicit transformations.
8. Growth: retention, bottlenecks, acquisition cost, and downstream customer quality.
9. Operations: map current process, find waits/rework, improve and verify, and define exception handling.

Template quantity, icons, summaries, and overviews remain independent product decisions. The current proposal is still a first draft pending revision against this comparison.

