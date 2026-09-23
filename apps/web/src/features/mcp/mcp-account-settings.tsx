import { useState } from "react";
import * as m from "../../paraglide/messages.js";
import {
  Banner,
  Button,
  Dialog,
  Field,
  Icon,
  KumoInputControl,
  Loader,
  SettingsList,
  SettingsRow,
  Text,
} from "../../ui/design-system.js";
import { McpDefaultsDialog } from "./mcp-defaults-dialog.js";
import { actionError } from "./mcp-form-model.js";
import { useMcpServers } from "./mcp-queries.js";

export function McpAccountSettings() {
  const [open, setOpen] = useState(false);
  return (
    <section className="grid gap-4">
      <Text as="h2" variant="heading">
        {m.mcp_heading()}
      </Text>
      <SettingsList>
        <SettingsRow label={m.mcp_account_manage()} description={m.mcp_account_description()}>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {m.mcp_account_manage()}
            <Icon name="arrow-right" />
          </Button>
        </SettingsRow>
      </SettingsList>
      {open ? <McpAccountDialog onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
export function McpAccountDialog({ onClose }: { onClose: () => void }) {
  const account = useMcpServers();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const servers = account.data?.servers ?? [];
  const matches = servers.filter((server) =>
    `${server.name} ${server.url}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (selected) return <McpDefaultsDialog serverId={selected} onClose={() => setSelected(undefined)} />;
  return (
    <Dialog className="mcp-form-dialog" title={m.mcp_heading()} description={m.mcp_defaults_scope()} onClose={onClose}>
      {account.isPending ? (
        <Loader />
      ) : account.isError ? (
        <div className="grid gap-3">
          <Banner variant="error">{actionError(account.error, m.common_request_failed())}</Banner>
          <Button onClick={() => void account.refetch()}>{m.mcp_retry()}</Button>
        </div>
      ) : !servers.length ? (
        <p className="text-sm text-kumo-subtle">{m.mcp_account_empty()}</p>
      ) : (
        <>
          <Field htmlFor="mcp-account-search" label={m.mcp_account_search()}>
            <KumoInputControl
              id="mcp-account-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <ul className="mt-6 divide-y divide-kumo-line border-y border-kumo-line">
            {matches.map((server) => (
              <li key={server.id}>
                <button type="button" className="mcp-choice" onClick={() => setSelected(server.id)}>
                  <span className="grid min-w-0 gap-1">
                    <strong className="text-sm font-medium">{server.name}</strong>
                    <span className="wrap-anywhere text-xs text-kumo-subtle">{server.url}</span>
                    <span className="mt-1 text-xs text-kumo-subtle">
                      {server.boundAgentCount > 1
                        ? m.mcp_account_used_count({ count: server.boundAgentCount })
                        : server.boundAgentCount === 1
                          ? m.mcp_account_used_one()
                          : m.mcp_defaults_unused()}
                    </span>
                  </span>
                  <Icon name="chevron-right" className="size-3.5 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
          {!matches.length ? <p className="mt-3 text-sm text-kumo-subtle">{m.mcp_account_no_matches()}</p> : null}
        </>
      )}
      <div className="mt-6 flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          {m.common_close()}
        </Button>
      </div>
    </Dialog>
  );
}
