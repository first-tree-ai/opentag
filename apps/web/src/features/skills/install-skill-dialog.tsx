import type { RemoteSkillCandidate, RemoteSkillInstallResult } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Checkbox, Dialog, Input, Loader, Text } from "../../ui/design-system.js";
import { skillErrorMessage, skillInstallResultMessage, skillUnavailableMessage } from "./skills-page-model.js";
import { useInstallRemoteSkills } from "./skills-queries.js";
import { useSkillSourcePreview } from "./use-skill-source-preview.js";

/** Resolve pasted sources automatically; installation always requires an explicit confirmation. */
export function InstallSkillDialog({
  agentId,
  onClose,
  onInstalled,
}: {
  agentId: string;
  onClose: () => void;
  onInstalled?: (count: number) => void;
}) {
  const source = useSkillSourcePreview(agentId);
  const install = useInstallRemoteSkills();
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [selection, setSelection] = useState<{ source: string; names: readonly string[] }>();
  const [results, setResults] = useState<RemoteSkillInstallResult[]>();
  const [error, setError] = useState<string>();
  const candidates = source.preview?.skills ?? [];
  const selectable = candidates.filter(isSelectable);
  const selected = selection?.source === source.preview?.source ? (selection?.names ?? []) : [];
  const single = candidates.length === 1;
  const only = single ? selectable[0] : undefined;
  const names = only ? [only.name] : selected;
  const busy = install.isPending;

  const change = (value: string) => {
    source.change(value);
    setSelection(undefined);
    setResults(undefined);
    setError(undefined);
  };

  const confirm = async () => {
    if (busy || names.length === 0 || !source.preview) return;
    setError(undefined);
    const selections = candidates
      .filter((entry) => names.includes(entry.name) && isSelectable(entry))
      .map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint }));
    try {
      const response = await install.mutateAsync({ agentId, source: source.preview.source, selections });
      if (!alive.current) return;
      if (response.results.length > 0 && response.results.every((result) => result.status === "installed")) {
        onInstalled?.(response.results.length);
        onClose();
      } else setResults(response.results);
    } catch (cause) {
      if (alive.current) setError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  const toggle = (name: string, checked: boolean) => {
    if (!source.preview) return;
    setSelection({
      source: source.preview.source,
      names: checked ? [...selected, name] : selected.filter((entry) => entry !== name),
    });
  };
  return (
    <Dialog
      busy={busy}
      className="skill-install-dialog"
      initialFocusRef={inputRef}
      onClose={onClose}
      title={m.skills_install_title()}
    >
      <div className="grid gap-6" data-ui="install-skill-dialog">
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          disabled={busy || results !== undefined}
          inputMode="url"
          label={m.skills_install_source_label()}
          placeholder={m.skills_install_source_placeholder()}
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={source.source}
          onChange={(event) => change(event.target.value)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.trim()) return;
            event.preventDefault();
            const input = event.currentTarget;
            const value =
              input.value.slice(0, input.selectionStart ?? 0) +
              text +
              input.value.slice(input.selectionEnd ?? input.value.length);
            change(value);
            void source.load(value);
          }}
          onBlur={(event) => {
            if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-skip-preview]"))
              return;
            if (!busy && results === undefined) void source.load();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void source.load();
          }}
        />
        {source.loading ? (
          <p className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
            <Loader size="sm" />
            {m.skills_install_fetching()}
          </p>
        ) : null}
        {source.error ? (
          <Banner
            role="alert"
            variant="error"
            description={source.error}
            action={
              <Banner.Action onClick={() => void source.load(undefined, true)}>{m.common_try_again()}</Banner.Action>
            }
          />
        ) : null}
        {error ? (
          <Banner role="alert" variant="error">
            {error}
          </Banner>
        ) : null}
        {source.preview && candidates.length === 0 ? <Banner variant="alert">{m.skills_install_empty()}</Banner> : null}
        {candidates.length > 0 && results === undefined ? (
          <CandidateList candidates={candidates} selected={names} busy={busy} onToggle={toggle} />
        ) : null}
        {results === undefined ? null : <ResultList results={results} />}
        <InstallActions
          busy={busy}
          loading={source.loading}
          count={names.length}
          done={results !== undefined}
          onClose={onClose}
          onConfirm={() => void confirm()}
        />
      </div>
    </Dialog>
  );
}

function InstallActions({
  busy,
  loading,
  count,
  done,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  loading: boolean;
  count: number;
  done: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex justify-end gap-3 border-t border-kumo-line pt-4">
      {done ? (
        <Button onClick={onClose} variant="primary">
          {m.common_done()}
        </Button>
      ) : (
        <>
          <Button data-skip-preview disabled={busy} onClick={onClose} variant="secondary">
            {m.common_cancel()}
          </Button>
          <Button disabled={busy || loading || count === 0} loading={busy} onClick={onConfirm} variant="primary">
            {busy ? m.skills_install_installing() : m.skills_install_count({ count: count || 1 })}
          </Button>
        </>
      )}
    </div>
  );
}

function isSelectable(candidate: RemoteSkillCandidate) {
  return !candidate.alreadyInstalled && candidate.unavailableReason === undefined;
}

function CandidateList({
  candidates,
  selected,
  busy,
  onToggle,
}: {
  candidates: readonly RemoteSkillCandidate[];
  selected: readonly string[];
  busy: boolean;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const single = candidates.length === 1;
  return (
    <section className="grid gap-2" aria-labelledby="skill-install-selection-title">
      <Text as="h3" id="skill-install-selection-title" variant="heading">
        {single ? m.skills_install_candidate_title() : m.skills_install_selection_title()}
      </Text>
      <ul
        aria-label={m.skills_install_candidates_aria()}
        className="skill-install-candidates ui-surface divide-y divide-kumo-line bg-kumo-base"
        data-ui="install-skill-candidates"
      >
        {candidates.map((candidate) => (
          <li className="grid min-w-0 gap-2 p-4" key={candidate.name}>
            {single ? (
              <strong className="wrap-anywhere font-semibold">{candidate.name}</strong>
            ) : (
              <Checkbox
                checked={selected.includes(candidate.name)}
                disabled={busy || !isSelectable(candidate)}
                label={candidate.name}
                onCheckedChange={(checked) => onToggle(candidate.name, checked === true)}
              />
            )}
            <Text as="p" size="sm" variant="secondary" DANGEROUS_className="wrap-anywhere">
              {candidate.description}
            </Text>
            {candidate.alreadyInstalled ? (
              <Text as="p" size="sm" variant="secondary">
                {m.skills_install_already()}
              </Text>
            ) : null}
            {candidate.unavailableReason ? (
              <Text as="p" size="sm" variant="secondary">
                {skillUnavailableMessage(candidate.unavailableReason)}
              </Text>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultList({ results }: { results: readonly RemoteSkillInstallResult[] }) {
  const occurrences = new Map<string, number>();
  const rows = results.map((result) => {
    const base = `${result.name}-${result.status}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { key: `${base}-${occurrence}`, result };
  });
  return (
    <ul aria-label={m.skills_install_results_aria()} className="grid gap-1" data-ui="install-skill-results">
      {rows.map(({ key, result }) => (
        <li className="grid gap-0.5" key={key}>
          <Text as="p" variant="body">
            {result.name}
          </Text>
          <Text as="p" size="sm" variant="secondary">
            {skillInstallResultMessage(result)}
          </Text>
        </li>
      ))}
    </ul>
  );
}
