# Agency Agents comparison against the proposed Soul catalog

## Scope and conclusion

Inspected on 2026-10-20 against the repository default-branch tree at commit `4e3ac3ca6604c75113f52c695dbddcc7af928b46`. Source text was read directly from commit-pinned GitHub raw files; the tree was obtained through the [GitHub tree API](https://api.github.com/repos/msitarzewski/agency-agents/git/trees/main?recursive=1). This is a content comparison, not an execution benchmark. Stars are not evidence that an instruction is effective.

The local comparison target is [the proposed eight-template catalog](../design/soul-template-catalog/catalog.json), especially the English bodies; the Chinese bodies express the same design. No catalog or product code was changed. This note covers Agency Agents only; it does not claim to inspect Awesome OpenClaw Agents.

The proposal reasonably incorporates a common structure and broadly sensible principles, but it does not yet demonstrate a deep role-by-role adaptation of Agency Agents. It compresses away several of the upstream files' most distinctive decision rules, artifact requirements, and observable working habits. The main issue is not insufficient length. The roughly 220-word bodies devote significant room to shared honesty and communication principles while role-specific decision methods receive relatively little space. The next iteration should replace generic wording with a few concrete behaviors per role, without importing upstream scripts, numbers, biographies, or universal workflow mandates.

## Source map

All links below are pinned to the inspected commit. A match identifies relevant source content, not proof that the earlier draft was derived from that file.

| Local role | Inspected Agency Agents definition(s) | Match qualification |
| --- | --- | --- |
| Engineering | [Frontend Developer][frontend]; [Minimal Change Engineer][minimal] | Composite and partial: these are narrower implementation specializations, not a general engineering template. |
| Design | [UI Designer][ui]; [UX Architect][ux] | Composite and partial: visual systems and developer-ready UX foundations, not a complete general product-design role. |
| Product | [Product Manager][product] | Direct role match, though the upstream role covers a much broader lifecycle. |
| Research | [Research Synthesist][research] | Strong match for desk research and evidence synthesis; not primary user research or experimental data collection. |
| Writing | [Technical Writer][writer]; [Content Creator][content] | Indirect: technical documentation and marketing content bracket only part of general writing. Neither alone defines the intended local role. |
| Data Analysis | [Analytics Reporter][analytics] | Strong business-analysis/reporting match, not all scientific or engineering analysis. |
| Growth | [Growth Hacker][growth] | Direct category match; the source includes retention and unit economics beyond the current summary. |
| Operations | [Operations Manager][operations]; [Studio Operations][studio] | Direct broad domain match, but the local body currently leans toward coordination/project support. |

## Role-by-role comparison

### Engineering

**Source content.** Frontend Developer adds attention to implementation quality, accessibility, responsive behavior, performance, and concrete validation. Minimal Change Engineer makes scope restraint an explicit working identity and asks for a final diff review and separately surfaced follow-ups. These source roles should not be confused with general software engineering. [Sources: Frontend Developer][frontend], [Minimal Change Engineer][minimal].

**Already in the proposal.** Reading project context, addressing root causes, coherent scope, relevant checks, and honest reporting are sound and substantially aligned.

**Useful next changes — editorial inference.** Add an explicit final review of changed behavior and unnecessary scope. Require review findings to identify the concrete problem, relevant location, impact, and suggested resolution when the user requests a review. For implementation, select quality checks relevant to the system, such as accessibility or performance for UI work, rather than prescribing every check to every task. Separate extra improvement opportunities from the requested change.

**Do not import.** Minimum line count as the primary objective, an arbitrary fourth-occurrence abstraction rule, refusal to inspect contextual files, fixed framework choices, or performance targets without project requirements. These are specialist stances or examples, not general defaults. [Sources: Frontend Developer][frontend], [Minimal Change Engineer][minimal].

### Design

**Source content.** UI Designer strongly emphasizes reusable components and tokens, precise component states, developer handoff, and checking implementation against intent. UX Architect translates product requirements into information hierarchy, reusable layout foundations, and implementation guidance. [Sources: UI Designer][ui], [UX Architect][ux].

**Already in the proposal.** User tasks, hierarchy before polish, states, narrow screens, accessibility, meaningful alternatives, and implementable outcomes are covered.

**Useful next changes — editorial inference.** Add explicit reuse of existing tokens and components before inventing new visual language. Make handoff concrete when relevant: sizes, spacing, states, responsive rules, and interaction behavior. Ask the designer to inspect the implemented result and identify divergences when implementation is part of the task. This gives Design a recognizable habit beyond describing a good interface.

**Boundary.** Product decides problem, priority, and scope; Design develops and validates the experience; Engineering verifies implementation behavior. These are working emphases, not forbidden collaboration boundaries.

**Do not import.** A mandatory full design system before every small screen change, fixed spacing scales, or claims of perfect handoff and percentage consistency. [Sources: UI Designer][ui], [UX Architect][ux].

### Product

**Source content.** Product Manager treats requests as hypotheses, protects focus, makes non-goals explicit, handles changes deliberately, distinguishes alignment from unanimity, and connects launch plans to post-launch measurement. Its communication examples show a decisive recommendation under uncertainty rather than endless questioning. [Source: Product Manager][product].

**Already in the proposal.** Problem framing, evidence, trade-offs, priorities, initial scope, acceptance criteria, and proportionate discovery are present.

**Useful next changes — editorial inference.** Make the main decision explicit: build, investigate, defer, or stop, with rationale. Connect a substantial proposed initiative to a measurable outcome and a later review point without fabricating targets. State a deliberate non-goal or rejected alternative when it clarifies focus. For launches, include relevant readiness and rollout risks, rather than stopping at requirements. Preserve freedom to answer small questions without generating a PRD.

**Do not import.** A fictional named executive with ten years of experience, universal interview-count minima, fixed launch deadlines, guaranteed outcome rates, or mandatory organizational sign-off ceremonies. [Source: Product Manager][product].

### Research

**Source content.** Research Synthesist requires a transparent search scope, inclusion/exclusion criteria, source-quality evaluation, tracing claims to their origin, recognition of circular citations, and thematic synthesis of agreement, disagreement, and gaps. Its useful personality is skepticism about apparent consensus based on repetition. [Source: Research Synthesist][research].

**Already in the proposal.** Primary evidence, dates and methods, contradictory information, common comparison criteria, traceable conclusions, and calibrated confidence are covered.

**Useful next changes — editorial inference.** State the actual coverage of substantial research: which sources, time range, and exclusions. Distinguish independent evidence from several articles repeating the same original claim. Organize synthesis around the user's question and confidence in each important conclusion, not a sequence of source summaries. Explicitly report an important sub-question for which no evidence was found. These are concrete differences from generic browsing.

**Do not import.** Full PRISMA/PICO procedure for routine research, compulsory evidence grading for every trivial fact, permanent memory claims, or a simplistic confidence rule based on any weak cited source. Judge confidence using the evidence necessary to sustain the conclusion. [Source: Research Synthesist][research].

### Writing

**Source content.** Technical Writer is centered on the reader's task, prerequisites, usable examples, structural purpose, verification, and cutting sentences that do not help. Content Creator adds audience/channel adaptation, voice consistency, narrative structure, and reworking material for different formats. These are specialized adjacent sources, not direct general-writing templates. [Sources: Technical Writer][writer], [Content Creator][content].

**Already in the proposal.** Audience, purpose, voice, outline, factual integrity, preservation of meaning, and separating final copy from notes are strong.

**Useful next changes — editorial inference.** Explicitly choose the structure around what the reader needs to understand or do next; assess the opening, argument flow, and ending as a whole before polishing sentences. When adapting a text to another channel, preserve claims and voice while changing format, depth, and pacing. For explanatory or technical text, check prerequisites and verify examples when feasible. Do not require a marketing call to action in every document.

**Do not import.** Fixed tutorial times, specific documentation platforms, automatic publishing, SEO duties for all writing, or universal engagement/revenue targets. [Sources: Technical Writer][writer], [Content Creator][content].

### Data Analysis

**Source content.** Analytics Reporter connects analysis to a business decision, validates data first, preserves transformations and assumptions, and produces stakeholder-oriented charts and reports with methods and uncertainty. It also includes dashboards, segmentation, and practical versus statistical interpretation. [Source: Analytics Reporter][analytics].

**Already in the proposal.** This is one of the stronger local bodies: metric definitions, denominator checks, reproducibility, segments/cohorts, causality limits, and evidence versus interpretation are already explicit.

**Useful next changes — editorial inference.** Make the output contract more concrete for a significant analysis: result, baseline/comparison, method, limitations, and proposed next action. State whether an observed difference is large enough to matter for the decision, not merely whether a test is significant. Explain important data transformations and exclusion rules alongside reproducible code or queries when applicable. Select chart form for the question and audience.

**Do not import.** Significance tests for every conclusion, universal 95% confidence conventions, forced ROI projections, arbitrary analysis-accuracy targets, or guaranteed business improvements. The source is a useful design input but contains overgeneralized requirements. [Source: Analytics Reporter][analytics].

### Growth

**Source content.** Growth Hacker covers acquisition, activation, retention, referral loops, product-led growth, channel economics, cohorts, attribution, and experimentation. Its identity favors seeking repeatable channels and new hypotheses. [Source: Growth Hacker][growth].

**Already in the proposal.** Audience, positioning, funnel stage, hypotheses, assets, success measures, observation windows, decision rules, and learning are present.

**Useful next changes — editorial inference.** Expand the role from campaign production toward the full growth problem: locate the bottleneck before choosing a tactic and include retention where relevant. Evaluate a proposed acquisition channel against cost and downstream user quality, not clicks alone. Distinguish exploratory channel ideas from evidence-backed candidates for scaling. In an experiment brief, name the hypothesis, primary metric, guardrail, audience, and next decision without forcing a statistical ritual on every copy request.

**Boundary.** Writing optimizes expression; Growth connects content or product changes to a measurable customer-journey outcome. Data Analysis can support measurement without becoming responsible for a campaign.

**Do not import.** Universal viral coefficients, growth rates, LTV:CAC ratios, experiment counts, or promises of exponential growth. [Source: Growth Hacker][growth].

### Operations

**Source content.** Operations Manager maps current processes, locates bottlenecks, measures baselines, considers system-wide effects, and makes quality checks, escalation, and continuity explicit. Studio Operations adds concrete SOP inputs/actions/outputs, training and handoff, resource coordination, and subsequent monitoring. [Sources: Operations Manager][operations], [Studio Operations][studio].

**Already in the proposal.** Owners, dates, dependencies, completion criteria, handoffs, SOPs, and honest status reporting are covered.

**Useful next changes — editorial inference.** The current body fits a coordination assistant more closely than an operations-improvement partner. Either narrow its name and overview or add the actual operations loop: map current flow, find waits/rework and fragile dependencies, propose a practical improvement, define how to check it, and document handoff or escalation. Include what triggers a procedure, who can resolve an exception, and how completion is verified when drafting an SOP.

**Do not import.** Full Lean/Six Sigma machinery for small tasks, universal utilization and uptime targets, facility/vendor duties unrelated to the request, or unattended recurring monitoring claims. [Sources: Operations Manager][operations], [Studio Operations][studio].

## Priorities for the next content iteration

1. Keep the moderate-length format flexible. All roles do not need nearly identical word counts or the same paragraph distribution.
2. Add two to four observable role-specific working habits and one light output contract to each body; replace repeated generic wording where necessary.
3. Strengthen Research with independent-source reasoning and explicit coverage; Operations with process diagnosis and verification; Growth with retention, bottlenecks, and economics; Design with concrete handoff and implementation review.
4. Sharpen personality through decisions: Engineering is disciplined about change scope; Product protects focus; Research challenges repeated claims; Writing removes reader friction; Data Analysis questions denominators; Growth tests bottlenecks; Operations notices fragile handoffs; Design insists on coherent states and hierarchy. These are proposed adaptations, not evaluated personalities.
5. Preserve provenance role by role, distinguishing direct matches from composites and independent editorial additions. Do not describe the eight-role scope or icons as recommendations made by Agency Agents.
6. Validate with common tasks and adjacent-role comparisons. Reading source definitions establishes fidelity and gives ideas; it cannot establish improved model behavior.

## Source references

[frontend]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/engineering/engineering-frontend-developer.md
[minimal]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/engineering/engineering-minimal-change-engineer.md
[ui]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/design/design-ui-designer.md
[ux]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/design/design-ux-architect.md
[product]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/product/product-manager.md
[research]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/research/research-synthesist.md
[writer]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/engineering/engineering-technical-writer.md
[content]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/marketing/marketing-content-creator.md
[analytics]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/support/support-analytics-reporter.md
[growth]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/marketing/marketing-growth-hacker.md
[operations]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/specialized/operations-manager.md
[studio]: https://github.com/msitarzewski/agency-agents/blob/4e3ac3ca6604c75113f52c695dbddcc7af928b46/project-management/project-management-studio-operations.md
