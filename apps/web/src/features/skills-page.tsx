import type { SkillSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Banner, Button, Dialog, Icon, Loader, Text } from "../ui/design-system.js";
import { liveRefreshErrors, ResourceRefreshNotice, usePersistedSettledError } from "./resource/resource-state.js";
import { SkillMarkdownDialog } from "./skills/skill-markdown-dialog.js";
import {
  flattenSkillPages,
  invalidateSkills,
  removeSkillFromCache,
  useSkillListQuery,
} from "./skills/skill-queries.js";
import { type SkillRowAction, SkillTable } from "./skills/skill-table.js";
import { SkillUploadConflictDialog, SkillUploadFeedback, useSkillUpload } from "./skills/skill-upload.js";

/**
 * The Account's skill library: upload, read `SKILL.md`, download, delete. Assignment to an Agent
 * lives on that Agent's own Skills page.
 */
export function SkillsPage() {
  const queryClient = useQueryClient();
  const library = useSkillLibrary();
  const upload = useSkillUpload();
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  // The row control that opened the current dialog, so closing it puts focus back where it came from.
  const openerRef = useRef<HTMLElement | null>(null);
  const [viewing, setViewing] = useState<string>();
  const [deleting, setDeleting] = useState<SkillSummary>();
  const [deleteNotice, setDeleteNotice] = useState<string>();

  function openDialog(setter: (skill: SkillSummary) => void): SkillRowAction {
    return (skill, trigger) => {
      openerRef.current = trigger;
      upload.dismissNotice();
      setDeleteNotice(undefined);
      setter(skill);
    };
  }

  function deleted(name: string) {
    setDeleting(undefined);
    removeSkillFromCache(queryClient, name);
    setDeleteNotice(m.skills_deleted_notice({ name }));
    void invalidateSkills(queryClient);
  }

  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <PageHeader description={m.skills_page_description()} title={m.skills_page_title()} titleId="skills-page-title">
        <Button loading={upload.busy} ref={uploadButtonRef} type="button" variant="primary" onClick={upload.openPicker}>
          <Icon name="upload" />
          {m.skills_upload()}
        </Button>
        <input
          aria-label={m.skills_upload()}
          data-ui="skills-upload-input"
          ref={upload.inputRef}
          type="file"
          {...upload.inputProps}
        />
      </PageHeader>

      <div className="grid gap-3" data-ui="skills-upload-status">
        <Text as="p" size="sm" variant="secondary">
          {m.skills_upload_trust_warning()}
        </Text>
        <Text as="p" size="sm" variant="secondary">
          {m.skills_upload_drop_hint()}
        </Text>
        <SkillUploadFeedback upload={upload} />
        {deleteNotice ? (
          <Banner data-ui="skills-delete-notice" description={deleteNotice} role="status" variant="secondary" />
        ) : null}
      </div>

      {library.refreshError ? (
        <ResourceRefreshNotice error={library.refreshError} onRetry={() => void library.query.refetch()} />
      ) : null}

      <div
        className="grid gap-4 rounded-lg transition-shadow data-[dragging]:ring-2 data-[dragging]:ring-kumo-brand data-[dragging]:ring-offset-4 data-[dragging]:ring-offset-kumo-base"
        data-ui="skills-drop-zone"
        {...upload.dropZoneProps}
      >
        <SkillLibraryBody
          library={library}
          onDelete={openDialog(setDeleting)}
          onView={openDialog((skill) => setViewing(skill.name))}
        />
      </div>

      <SkillUploadConflictDialog returnFocusRef={uploadButtonRef} upload={upload} />
      {viewing !== undefined ? (
        <SkillMarkdownDialog name={viewing} returnFocusRef={openerRef} onClose={() => setViewing(undefined)} />
      ) : null}
      {deleting ? (
        <SkillDeleteDialog
          returnFocusRef={openerRef}
          skill={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={deleted}
        />
      ) : null}
    </section>
  );
}

type SkillLibrary = ReturnType<typeof useSkillLibrary>;

/** The paged library plus the three kinds of failure the page tells apart. */
function useSkillLibrary() {
  const query = useSkillListQuery();
  const skills = useMemo(() => flattenSkillPages(query.data), [query.data]);
  const error = asError(query.error);
  const persistedError = usePersistedSettledError(queryKeys.skills.list(), {
    error: query.error ? error : null,
    isError: query.isError,
    isSuccess: query.isSuccess,
  });
  // A 401/403/404/410 on any page is about the library, not the page boundary: it withdraws the rows.
  const { terminalError, loadMoreError, refreshError } = liveRefreshErrors({ ...query, error }, persistedError);
  const unavailable = terminalError !== null || (query.isError && !query.data);
  return {
    query,
    skills,
    loadMoreError,
    refreshError,
    unavailable,
    unavailableDetail: (terminalError ?? error).message,
    loading: !unavailable && query.isPending,
    empty: !unavailable && query.data !== undefined && skills.length === 0,
    listed: !unavailable && skills.length > 0,
  };
}

function SkillLibraryBody({
  library,
  onDelete,
  onView,
}: {
  library: SkillLibrary;
  onDelete: SkillRowAction;
  onView: SkillRowAction;
}) {
  if (library.loading) {
    return <SkillNotice loading heading={m.skills_loading()} detail={m.skills_loading_detail()} />;
  }
  if (library.unavailable) {
    return (
      <SkillNotice
        action={
          <Button type="button" variant="secondary" onClick={() => void library.query.refetch()}>
            {m.skills_try_again()}
          </Button>
        }
        heading={m.skills_unavailable()}
        detail={library.unavailableDetail}
      />
    );
  }
  if (library.empty) return <SkillNotice heading={m.skills_empty_title()} detail={m.skills_empty_detail()} />;
  if (!library.listed) return null;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <Text as="h2" variant="heading">
          {m.skills_all_skills()}
        </Text>
        <Text as="p" size="sm" variant="secondary">
          {m.skills_count({ count: library.skills.length })}
        </Text>
      </div>
      <SkillTable skills={library.skills} onDelete={onDelete} onView={onView} />
      <SkillLoadMore library={library} />
    </>
  );
}

function SkillLoadMore({ library }: { library: SkillLibrary }) {
  const { query, loadMoreError } = library;
  if (!query.hasNextPage) return null;
  const label = query.isFetchingNextPage
    ? m.skills_loading_more()
    : loadMoreError
      ? m.skills_try_again()
      : m.skills_load_more();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={query.isFetching}
        loading={query.isFetchingNextPage}
        type="button"
        variant="secondary"
        onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
      >
        {label}
      </Button>
      {loadMoreError ? (
        <span className="text-sm text-kumo-danger" role="alert">
          {loadMoreError.message}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Deleting also unassigns the skill from every Agent and stops their Computers syncing it, so it
 * is confirmed first and cannot be dismissed while the Server has not answered.
 */
function SkillDeleteDialog({
  onClose,
  onDeleted,
  returnFocusRef,
  skill,
}: {
  onClose: () => void;
  onDeleted: (name: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  skill: SkillSummary;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await browserApi.deleteSkill(skill.name);
      onDeleted(skill.name);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : m.skills_delete_failed());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      busy={busy}
      description={m.skills_delete_confirm_description({ name: skill.name })}
      returnFocusRef={returnFocusRef}
      role="alertdialog"
      title={m.skills_delete_confirm_title({ name: skill.name })}
      onClose={onClose}
    >
      <div className="grid gap-4">
        {error ? <Banner description={error} role="alert" variant="error" /> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button disabled={busy} type="button" variant="ghost" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button disabled={busy} type="button" variant="danger" onClick={() => void remove()}>
            {busy ? m.skills_deleting() : m.common_delete()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SkillNotice({
  action,
  detail,
  heading,
  loading = false,
}: {
  action?: ReactNode;
  detail: string;
  heading: string;
  loading?: boolean;
}) {
  return (
    <section
      className="grid gap-2 rounded-lg bg-kumo-base p-8 text-center ring ring-kumo-line"
      aria-live="polite"
      data-ui="skills-empty-state"
    >
      <div className="flex items-center justify-center gap-2">
        {loading ? <Loader aria-label={heading} size="sm" /> : null}
        <Text as="h2" variant="heading">
          {heading}
        </Text>
      </div>
      <Text as="p" variant="secondary">
        {detail}
      </Text>
      {action ? <div className="flex justify-center">{action}</div> : null}
    </section>
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(m.skills_request_failed());
}
