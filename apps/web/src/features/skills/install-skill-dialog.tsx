import type { RemoteSkillCandidate, RemoteSkillInstallResult } from "@opentag/shared/browser";
import { useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Checkbox, Dialog, Input, Text } from "../../ui/design-system.js";
import { skillErrorMessage, skillInstallResultMessage, skillUnavailableMessage } from "./skills-page-model.js";
import { useInstallRemoteSkills, useResolveRemoteSkills } from "./skills-queries.js";

/**
 * Installs Skills published at an address the user pastes.
 *
 * The dialog has three moments — read the source, choose from what it holds, report what happened —
 * and it stays one dialog for all three, because the user's input is what the later moments are
 * about: a failed lookup keeps the address to correct, and a report keeps the names that were asked
 * for. Nothing is written until the user confirms, and a lookup never writes at all.
 *
 * Selection is by name, which is what the Server matches on, so the map from a candidate to its
 * checkbox is the candidate's name and nothing else. A candidate the Server already knows cannot be
 * packaged is shown, explained, and not selectable: the alternative is letting the user pick
 * something that can only fail.
 *
 * The body is assembled from `SourceForm`, `CandidateList`, `ResultList`, and `DialogActions` so that
 * each piece owns one question and the container owns the state.
 */
export function InstallSkillDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const lookUp = useResolveRemoteSkills();
  const install = useInstallRemoteSkills();
  const [source, setSource] = useState("");
  /*
   * The address the candidates came from, kept separately from the field. The field stays editable —
   * a failed lookup has to be correctable — but the install must speak about the source that produced
   * the list on screen, not about whatever the input says by the time the button is pressed.
   */
  const [previewedSource, setPreviewedSource] = useState<string | undefined>();
  const [candidates, setCandidates] = useState<RemoteSkillCandidate[] | undefined>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [results, setResults] = useState<RemoteSkillInstallResult[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const busy = lookUp.isPending || install.isPending;
  const selectable = (candidates ?? []).filter((candidate) => candidate.unavailableReason === undefined);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  const fetchCandidates = async () => {
    if (busy || source.trim() === "") return;
    const requested = source.trim();
    setError(undefined);
    setResults(undefined);
    setCandidates(undefined);
    setPreviewedSource(undefined);
    setSelected([]);
    try {
      const response = await lookUp.mutateAsync({ agentId, source: requested });
      setPreviewedSource(requested);
      setCandidates(response.skills);
    } catch (cause) {
      setError(describeFailure(cause));
    }
  };

  /**
   * Editing the address after a preview drops the preview.
   *
   * Keeping it would let a user preview source A, edit the field to source B, and install B's
   * same-named Skill without ever having seen it; clearing the list makes the next step explicit.
   */
  const changeSource = (value: string) => {
    setSource(value);
    if (candidates === undefined && results === undefined && previewedSource === undefined) return;
    setCandidates(undefined);
    setSelected([]);
    setPreviewedSource(undefined);
  };

  const toggle = (name: string, checked: boolean) => {
    setSelected((current) => (checked ? [...current, name] : current.filter((entry) => entry !== name)));
  };

  const toggleAll = () => {
    setSelected(allSelected ? [] : selectable.map((candidate) => candidate.name));
  };

  const confirm = async () => {
    if (busy || selected.length === 0 || previewedSource === undefined) return;
    setError(undefined);
    // Each selection carries the fingerprint the preview reported, so the Server can refuse an item
    // whose source moved instead of installing bytes this user never saw.
    const selections = (candidates ?? [])
      .filter((candidate) => selected.includes(candidate.name))
      .map((candidate) => ({ name: candidate.name, fingerprint: candidate.fingerprint }));
    try {
      const response = await install.mutateAsync({ agentId, source: previewedSource, selections });
      setResults(response.results);
    } catch (cause) {
      setError(describeFailure(cause));
    }
  };

  const previewing = candidates !== undefined && candidates.length > 0 && results === undefined;

  return (
    <Dialog
      busy={busy}
      className="w-[min(90vw,42rem)]"
      description={m.skills_install_description()}
      onClose={onClose}
      title={m.skills_install_title()}
    >
      <div className="grid gap-4" data-ui="install-skill-dialog">
        <SourceForm
          busy={busy}
          fetching={lookUp.isPending}
          locked={results !== undefined}
          onChange={changeSource}
          onFetch={() => void fetchCandidates()}
          source={source}
        />
        {error === undefined ? null : <Banner variant="error">{error}</Banner>}
        {candidates !== undefined && candidates.length === 0 ? (
          <Banner variant="alert">{m.skills_install_empty()}</Banner>
        ) : null}
        {previewing ? (
          <CandidateList
            allSelected={allSelected}
            candidates={candidates ?? []}
            onToggle={toggle}
            onToggleAll={toggleAll}
            selected={selected}
          />
        ) : null}
        {results === undefined ? null : <ResultList results={results} />}
        <DialogActions
          busy={busy}
          installing={install.isPending}
          onClose={onClose}
          onConfirm={() => void confirm()}
          selectedCount={selected.length}
          showDone={results !== undefined}
        />
      </div>
    </Dialog>
  );
}

/** The one input the user types into, and the action that reads it. */
function SourceForm({
  busy,
  fetching,
  locked,
  onChange,
  onFetch,
  source,
}: {
  busy: boolean;
  fetching: boolean;
  locked: boolean;
  onChange: (value: string) => void;
  onFetch: () => void;
  source: string;
}) {
  return (
    <div className="flex items-end gap-2">
      <Input
        className="min-h-11"
        disabled={busy || locked}
        label={m.skills_install_source_label()}
        onChange={(event) => onChange(event.target.value)}
        placeholder={m.skills_install_source_placeholder()}
        type="text"
        value={source}
      />
      <Button
        aria-busy={fetching}
        disabled={busy || source.trim() === "" || locked}
        loading={fetching}
        onClick={onFetch}
        variant="secondary"
      >
        {fetching ? m.skills_install_fetching() : m.skills_install_fetch()}
      </Button>
    </div>
  );
}

/**
 * The two endings: a report closes, and anything else confirms or cancels. Splitting this out keeps
 * the dialog body about the source and what it holds.
 */
function DialogActions({
  busy,
  installing,
  onClose,
  onConfirm,
  selectedCount,
  showDone,
}: {
  busy: boolean;
  installing: boolean;
  onClose: () => void;
  onConfirm: () => void;
  selectedCount: number;
  showDone: boolean;
}) {
  if (showDone) {
    return (
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} variant="primary">
          {m.common_done()}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-2">
      <Button disabled={busy} onClick={onClose} variant="ghost">
        {m.common_cancel()}
      </Button>
      <Button
        aria-busy={installing}
        disabled={busy || selectedCount === 0}
        loading={installing}
        onClick={onConfirm}
        variant="primary"
      >
        {installing ? m.skills_install_installing() : m.skills_install_confirm()}
      </Button>
    </div>
  );
}

/** The readable sentence for a failed request: the code is the contract, the sentence is the copy. */
function describeFailure(cause: unknown): string {
  return skillErrorMessage(cause instanceof ApiError ? cause.code : undefined);
}

/** What the source holds: one row per candidate, with everything the choice needs on it. */
function CandidateList({
  allSelected,
  candidates,
  onToggle,
  onToggleAll,
  selected,
}: {
  allSelected: boolean;
  candidates: readonly RemoteSkillCandidate[];
  onToggle: (name: string, checked: boolean) => void;
  onToggleAll: () => void;
  selected: readonly string[];
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Text as="p" size="sm" variant="secondary">
          {m.skills_install_found({ count: candidates.length })}
        </Text>
        <Button onClick={onToggleAll} size="compact" variant="ghost">
          {allSelected ? m.skills_install_clear() : m.skills_install_select_all()}
        </Button>
      </div>
      <ul
        aria-label={m.skills_install_candidates_aria()}
        className="ui-surface max-h-[min(50vh,22rem)] divide-y divide-kumo-line overflow-y-auto bg-kumo-base"
        data-ui="install-skill-candidates"
      >
        {candidates.map((candidate) => (
          <li className="grid gap-1 p-3" key={candidate.name}>
            <Checkbox
              checked={selected.includes(candidate.name)}
              data-ui="install-skill-candidate"
              disabled={candidate.unavailableReason !== undefined}
              label={candidate.name}
              onCheckedChange={(checked) => onToggle(candidate.name, checked === true)}
            />
            <Text as="p" size="sm" variant="secondary">
              {candidate.description}
            </Text>
            <Text as="p" size="sm" variant="secondary">
              {`${candidate.path}${candidate.fileCount === undefined ? "" : ` · ${m.skills_file_count({ count: candidate.fileCount })}`}`}
            </Text>
            {candidate.alreadyInstalled ? (
              <Text as="p" size="sm" variant="secondary">
                {m.skills_install_already()}
              </Text>
            ) : null}
            {candidate.unavailableReason === undefined ? null : (
              <Text as="p" size="sm" variant="secondary">
                {skillUnavailableMessage(candidate.unavailableReason)}
              </Text>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What happened to each requested name.
 *
 * A request may name the same Skill twice — the second occurrence is skipped — so the key is the
 * name, the outcome, and how many times that pair has occurred. A list key that leaned on the array
 * index would be the one thing here that changes when results are reordered.
 */
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
