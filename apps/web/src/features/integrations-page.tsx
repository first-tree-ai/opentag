import { type RefObject, useMemo, useRef, useState } from "react";
import { type IntegrationCategory, type IntegrationPreview, integrationPreviews } from "../mock/capability-data.js";
import { Button, Dialog, StatusIndicator } from "../ui/design-system.js";
import "../mock-pages.css";

type CategoryFilter = "All categories" | IntegrationCategory;

const categoryFilters: readonly CategoryFilter[] = ["All categories", "Developer tools", "Knowledge", "Productivity"];

export function IntegrationsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All categories");
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationPreview>();
  const returnFocusRef = useRef<HTMLElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredIntegrations = useMemo(
    () =>
      integrationPreviews.filter(
        (integration) =>
          (category === "All categories" || integration.category === category) &&
          (normalizedQuery.length === 0 ||
            `${integration.name} ${integration.description}`.toLocaleLowerCase().includes(normalizedQuery)),
      ),
    [category, normalizedQuery],
  );
  const connected = filteredIntegrations.filter((integration) => integration.connection.state === "connected");
  const available = filteredIntegrations.filter((integration) => integration.connection.state === "available");

  return (
    <section className="capability-page" aria-labelledby="integrations-page-title">
      <header className="capability-page-header integration-page-header">
        <div>
          <h1 id="integrations-page-title">Integrations</h1>
          <p>Connect the services Agents can use to find context and complete work.</p>
        </div>
        <span className="capability-demo-note">Demo data</span>
      </header>

      <dl className="integration-summary" aria-label="Demo integration summary">
        <div>
          <dt>Connected</dt>
          <dd>2</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>4</dd>
        </div>
        <div>
          <dt>Agents with access</dt>
          <dd>6</dd>
        </div>
      </dl>

      <section className="integration-directory" aria-labelledby="integration-directory-title">
        <header className="integration-directory-header">
          <div>
            <h2 id="integration-directory-title">Workspace integrations</h2>
            <p>Connections are shared at the Workspace level, then assigned to individual Agents.</p>
          </div>
          <div className="integration-filters">
            <label className="integration-search">
              <span className="visually-hidden">Search integrations</span>
              <svg aria-hidden="true" fill="none" focusable="false" viewBox="0 0 20 20">
                <circle cx="8.5" cy="8.5" r="5" />
                <path d="m12.2 12.2 3.8 3.8" />
              </svg>
              <input
                aria-label="Search integrations"
                className="ds-control ds-control--compact"
                placeholder="Search integrations"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              <span className="visually-hidden">Filter by category</span>
              <select
                aria-label="Filter by category"
                className="ds-control ds-control--compact"
                value={category}
                onChange={(event) => setCategory(event.target.value as CategoryFilter)}
              >
                {categoryFilters.map((filter) => (
                  <option key={filter}>{filter}</option>
                ))}
              </select>
            </label>
          </div>
        </header>

        {filteredIntegrations.length > 0 ? (
          <div className="integration-groups">
            {connected.length > 0 ? (
              <IntegrationGroup
                integrations={connected}
                label="Connected"
                onSelect={(integration, trigger) => {
                  returnFocusRef.current = trigger;
                  setSelectedIntegration(integration);
                }}
              />
            ) : null}
            {available.length > 0 ? (
              <IntegrationGroup
                integrations={available}
                label="Available to connect"
                onSelect={(integration, trigger) => {
                  returnFocusRef.current = trigger;
                  setSelectedIntegration(integration);
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="integration-empty-state" role="status">
            <strong>No matching integrations</strong>
            <p>Try another search term or category.</p>
            <Button
              size="compact"
              variant="outline"
              onClick={() => {
                setQuery("");
                setCategory("All categories");
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </section>

      {selectedIntegration ? (
        <IntegrationPreviewDialog
          integration={selectedIntegration}
          returnFocusRef={returnFocusRef}
          onClose={() => setSelectedIntegration(undefined)}
        />
      ) : null}
    </section>
  );
}

function IntegrationGroup({
  integrations,
  label,
  onSelect,
}: {
  integrations: readonly IntegrationPreview[];
  label: string;
  onSelect: (integration: IntegrationPreview, trigger: HTMLButtonElement) => void;
}) {
  return (
    <section
      className="integration-group"
      aria-labelledby={`integration-group-${label.replaceAll(" ", "-").toLowerCase()}`}
    >
      <div className="integration-group-heading">
        <h3 id={`integration-group-${label.replaceAll(" ", "-").toLowerCase()}`}>{label}</h3>
        <span>{integrations.length}</span>
      </div>
      <ul className="capability-integration-list">
        {integrations.map((integration) => {
          const { connection } = integration;
          const isConnected = connection.state === "connected";
          return (
            <li key={integration.id}>
              <div className="capability-integration-identity">
                <span className={`capability-integration-mark is-${integration.id}`} aria-hidden="true">
                  {integration.abbreviation}
                </span>
                <div>
                  <strong>{integration.name}</strong>
                  <small>{integration.description}</small>
                </div>
              </div>
              <span className="integration-category">{integration.category}</span>
              <StatusIndicator
                className="capability-status"
                detail={connection.state === "connected" ? connection.identity : undefined}
                label={isConnected ? "Connected" : "Not connected"}
                tone={isConnected ? "success" : "neutral"}
              />
              <span className="capability-agent-count">
                {connection.state === "connected" ? `${connection.agentCount} Agents` : "No access"}
              </span>
              <Button
                size="compact"
                variant={isConnected ? "outline" : "secondary"}
                onClick={(event) => onSelect(integration, event.currentTarget)}
              >
                {isConnected ? "Manage" : "Connect"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IntegrationPreviewDialog({
  integration,
  onClose,
  returnFocusRef,
}: {
  integration: IntegrationPreview;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { connection } = integration;
  const isConnected = connection.state === "connected";
  return (
    <Dialog
      description={
        isConnected
          ? `Preview how administrators would manage the ${integration.name} connection and Agent access.`
          : `Preview the information shown before connecting ${integration.name} to this Workspace.`
      }
      eyebrow="Mock interaction"
      returnFocusRef={returnFocusRef}
      title={isConnected ? `Manage ${integration.name}` : `Connect ${integration.name}`}
      onClose={onClose}
    >
      <div className="integration-dialog-body">
        <div className="integration-dialog-identity">
          <span className={`capability-integration-mark is-${integration.id}`} aria-hidden="true">
            {integration.abbreviation}
          </span>
          <div>
            <strong>{integration.name}</strong>
            <small>{integration.category}</small>
          </div>
        </div>
        <dl>
          <div>
            <dt>Workspace access</dt>
            <dd>
              {connection.state === "connected"
                ? `${connection.agentCount} Agents assigned`
                : "Assigned after connection"}
            </dd>
          </div>
          <div>
            <dt>Purpose</dt>
            <dd>{integration.description}</dd>
          </div>
        </dl>
        <aside>
          <strong>Preview only</strong>
          <p>The server does not expose a Workspace Integration contract yet.</p>
        </aside>
        <div className="integration-dialog-actions">
          <Button variant="outline" onClick={onClose}>
            Close preview
          </Button>
          <Button disabled>{isConnected ? "Save changes" : "Continue"}</Button>
        </div>
      </div>
    </Dialog>
  );
}
