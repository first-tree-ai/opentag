import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import { agentIntegrationPreviews } from "../../mock/agent-detail-capability-data.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Checkbox, StatusIndicator, Text } from "../../ui/design-system.js";
import { flattenSkillPages, useAgentSkillsQuery, useSkillListQuery } from "../skills/skill-queries.js";

export function AgentIntegrationsTab() {
  return import.meta.env.DEV ? <AgentIntegrationsPreview /> : <AgentIntegrationsUnavailable />;
}

export function AgentIntegrationsPreview() {
  return (
    <div className="grid gap-4" data-ui="agent-integrations-preview">
      <PreviewNotice>{m.agents_integrations_preview_description()}</PreviewNotice>
      <ul aria-label={m.agents_integrations_preview_aria()} className="grid gap-3">
        {agentIntegrationPreviews.map((integration) => (
          <li key={integration.name}>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <strong>{integration.name}</strong>
                <small>{integration.identity}</small>
              </div>
              <StatusIndicator
                detail={integration.connection}
                label={integration.availability}
                tone={integration.availability === "Available" ? "success" : "warning"}
              />
            </header>
            <p>{integration.purpose}</p>
            <dl className="grid gap-2 text-sm text-kumo-subtle">
              <div>
                <dt>{m.agents_capability_scope()}</dt>
                <dd>{integration.scope}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentIntegrationsUnavailable() {
  return (
    <section
      aria-labelledby="agent-integrations-unavailable"
      className="grid gap-2 rounded-lg bg-kumo-recessed p-6 text-center"
    >
      <span className="text-sm text-kumo-subtle">{m.agents_capability_not_available()}</span>
      <Text as="h3" id="agent-integrations-unavailable" variant="heading">
        {m.agents_integrations_unavailable_title()}
      </Text>
      <p>{m.agents_integrations_unavailable_description()}</p>
      <p>{m.agents_no_preview_records_production()}</p>
    </section>
  );
}

/** The Agent's Skills route: the library with this Agent's assignment on each row. */
export function AgentSkillsPage({ agentId }: { agentId: string }) {
  return (
    <section className="grid gap-6" aria-labelledby="agent-skills-page-title" data-ui="agent-skills-page">
      <PageHeader
        description={m.agents_skills_page_description()}
        title={m.agents_skills_title()}
        titleId="agent-skills-page-title"
      />
      <AgentSkillsTab agentId={agentId} />
    </section>
  );
}

/**
 * Every skill in the library with a checkbox for whether this Agent receives it. A toggle sends
 * the whole resulting set — the endpoint replaces rather than patches, so two quick toggles cannot
 * leave the Server holding a set neither click asked for — and the answer becomes the cached
 * assignment. Only assigned skills reach the Agent's workspace, which is what the hint says.
 */
export function AgentSkillsTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const library = useSkillListQuery();
  const assignment = useAgentSkillsQuery(agentId);
  const skills = useMemo(() => flattenSkillPages(library.data), [library.data]);
  const assigned = useMemo(() => new Set(assignment.data?.skills.map((skill) => skill.name) ?? []), [assignment.data]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function toggle(name: string, checked: boolean) {
    const next = new Set(assigned);
    if (checked) next.add(name);
    else next.delete(name);
    setSaving(true);
    setError(undefined);
    try {
      const response = await browserApi.replaceAgentSkills(agentId, [...next].sort());
      queryClient.setQueryData(queryKeys.skills.byAgent(agentId), response);
      // Each row's Agent count on the library page just changed.
      await queryClient.invalidateQueries({ queryKey: queryKeys.skills.list() });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : m.agents_skills_save_failed());
    } finally {
      setSaving(false);
    }
  }

  const unavailable = (library.isError && !library.data) || (assignment.isError && !assignment.data);
  const loading = !unavailable && (library.isPending || assignment.isPending);
  const retry = () => {
    void library.refetch();
    void assignment.refetch();
  };
  return (
    <section
      aria-labelledby="agent-skills-heading"
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      data-ui="agent-skills"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <Text as="h2" id="agent-skills-heading" variant="heading">
            {m.agents_skills_assignments()}
          </Text>
          <Text as="p" size="sm" variant="secondary">
            {m.agents_skills_tab_hint()}
          </Text>
        </div>
        <Link className="text-sm text-kumo-link" to="/skills">
          {m.agents_view_skills()}
        </Link>
      </div>
      {error ? <Banner description={error} role="alert" variant="error" /> : null}
      {saving ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.agents_skills_saving()}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.agents_skills_loading()}
        </p>
      ) : null}
      {unavailable ? (
        <Banner
          action={<Banner.Action onClick={retry}>{m.common_try_again()}</Banner.Action>}
          description={firstErrorMessage(library.error, assignment.error)}
          role="alert"
          title={m.agents_skills_unavailable()}
          variant="error"
        />
      ) : null}
      {!loading && !unavailable && skills.length === 0 ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.agents_skills_none()}
        </p>
      ) : null}
      {!unavailable && assignment.data && skills.length > 0 ? (
        <>
          <p className="text-sm text-kumo-subtle" data-ui="agent-skills-count">
            {m.agents_skills_assigned_count({ assigned: assigned.size, total: skills.length })}
          </p>
          <ul aria-label={m.agents_skills_list_aria()} className="divide-y divide-kumo-line">
            {skills.map((skill) => (
              <li className="py-3" key={skill.name}>
                <Checkbox
                  checked={assigned.has(skill.name)}
                  disabled={saving}
                  label={
                    <span className="grid min-w-0 gap-0.5">
                      <span className="break-all font-medium">{skill.name}</span>
                      <span className="text-sm text-kumo-subtle">{skill.description}</span>
                    </span>
                  }
                  onCheckedChange={(checked) => void toggle(skill.name, checked === true)}
                />
              </li>
            ))}
          </ul>
          {library.hasNextPage ? (
            <Button
              className="w-fit"
              disabled={library.isFetching}
              loading={library.isFetchingNextPage}
              type="button"
              variant="secondary"
              onClick={() => void library.fetchNextPage({ cancelRefetch: false })}
            >
              {m.agents_skills_load_more()}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function firstErrorMessage(...errors: readonly unknown[]): string {
  const error = errors.find((candidate) => candidate instanceof Error);
  return error instanceof Error ? error.message : m.common_request_failed();
}

function PreviewNotice({ children }: { children: string }) {
  return (
    <aside className="grid gap-1 rounded-md bg-kumo-info-tint p-3 text-sm">
      <strong>{m.agents_preview_data()}</strong>
      <p>{children}</p>
    </aside>
  );
}
