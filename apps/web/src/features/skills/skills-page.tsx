import { SKILL_ERROR_CODES, type Skill, type SkillArchiveFormat } from "@opentag/shared/browser";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Empty, Icon, Loader, Text } from "../../ui/design-system.js";
import { RemoveSkillDialog, ReplaceSkillDialog } from "./skill-dialogs.js";
import { SkillRow } from "./skill-row.js";
import {
  checkSkillArchiveFile,
  sha256Hex,
  skillErrorMessage,
  skillRejectionMessage,
  storageStateForList,
} from "./skills-page-model.js";
import { useAgentSkills, useInvalidateAgentSkills, useUploadSkill } from "./skills-queries.js";

/** One archive waiting on the replace confirmation, bound to the Agent it was chosen for. */
interface PendingReplace {
  agentId: string;
  file: File;
  format: SkillArchiveFormat;
  name: string;
  sha256: string;
}

/**
 * One Agent's Skills, backed by the real management API.
 *
 * Agent-scoped transient state (the pending archive, an upload in progress, an error, the delete
 * target) lives in the body, which is keyed by Agent: an Agent change remounts it and drops all of
 * it. That is the structural half of the cross-Agent-write fix — a leftover "Replace Skill"
 * confirmation must not survive into another Agent's page; `SkillsPageBody` adds the runtime guard.
 */
export function SkillsPage({ agentId }: { agentId: string }) {
  return <SkillsPageBody agentId={agentId} key={agentId} />;
}

function SkillsPageBody({ agentId }: { agentId: string }) {
  const skills = useAgentSkills(agentId);
  const upload = useUploadSkill();
  const invalidateSkills = useInvalidateAgentSkills();
  const fileInputRef = useRef<HTMLInputElement>(null);
  /*
   * The body only remounts when the Agent changes, so within one instance this tracks unmount alone.
   * It is a ref, not state, because the async steps read it after an await, where a captured render
   * value would already be stale.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [actionError, setActionError] = useState<string | undefined>();
  const [uploadingName, setUploadingName] = useState<string | undefined>();
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Skill | undefined>();

  /*
   * Three states, not two. Storage is only "available" once a successful list says so; before that it
   * is "unknown" and every storage-dependent control stays disabled — a failed first load must not
   * present an enabled Upload, an empty list, or a calm "unavailable" notice that is really an error.
   */
  const storage = storageStateForList(skills.data);
  const storageAvailable = storage === "available";
  const uploadBusy = uploadingName !== undefined || upload.isPending;

  const openFilePicker = () => {
    setActionError(undefined);
    fileInputRef.current?.click();
  };

  /*
   * The Agent is taken from the archive, never from the current page: the archive was chosen on a
   * particular Agent's page, and a mutation that closed over "whichever Agent is mounted now" is how
   * a delayed confirmation reached the wrong one.
   */
  const uploadArchive = async (archive: PendingReplace, replace: boolean) => {
    await upload.mutateAsync({
      agentId: archive.agentId,
      file: archive.file,
      sha256: archive.sha256,
      format: archive.format,
      replace,
    });
  };

  /**
   * Hash, then upload the archive for this exact Agent.
   *
   * Hashing and the upload are each an await, and the page can change or unmount during either. Every
   * step is fenced on `alive` (this body is still mounted for this Agent) before it sets state or
   * issues the next request, so a delayed hash or a late conflict response cannot land elsewhere.
   */
  const submitArchive = async (file: File, format: SkillArchiveFormat) => {
    let archive: PendingReplace | undefined;
    let failure: unknown;
    try {
      const sha256 = await sha256Hex(file);
      if (!alive.current) return;
      archive = { agentId, file, format, name: file.name, sha256 };
      await uploadArchive(archive, false);
    } catch (cause) {
      failure = cause;
    } finally {
      if (alive.current) setUploadingName(undefined);
    }
    if (failure === undefined || !alive.current) return;
    await reportUploadFailure(failure, archive);
  };

  /**
   * Resolve a failed upload for the archive that produced it.
   *
   * A name conflict is the one failure the user resolves by confirming, so it opens the dialog with
   * the archive already hashed rather than reporting an error. A revision conflict means somebody
   * else changed the Skill mid-upload: there is nothing to confirm, so report it and refresh the
   * list rather than offering a Replace the user cannot win.
   */
  const reportUploadFailure = async (failure: unknown, archive: PendingReplace | undefined) => {
    if (archive && isNameConflict(failure)) {
      setPendingReplace(archive);
      return;
    }
    setActionError(actionMessage(failure));
    if (archive && isRevisionConflict(failure)) await invalidateSkills(archive.agentId);
  };

  const onFileSelected = async (file: File) => {
    if (uploadBusy) return;
    setActionError(undefined);
    const check = checkSkillArchiveFile(file);
    if (!check.ok) {
      setActionError(skillRejectionMessage(check.rejection));
      return;
    }
    setUploadingName(file.name);
    await submitArchive(file, check.format);
  };

  const confirmReplace = async () => {
    // Defence in depth beside the keyed remount: never confirm an archive whose recorded Agent is not
    // this page's Agent.
    if (!pendingReplace || pendingReplace.agentId !== agentId || !alive.current) return;
    setActionError(undefined);
    try {
      await uploadArchive(pendingReplace, true);
    } catch (cause) {
      if (alive.current) setActionError(actionMessage(cause));
    } finally {
      if (alive.current) setPendingReplace(undefined);
    }
  };

  const uploadAction = (
    <Button
      aria-label={m.skills_upload()}
      aria-busy={uploadBusy}
      disabled={!storageAvailable}
      loading={uploadBusy}
      onClick={openFilePicker}
      variant="secondary"
    >
      {!uploadBusy ? <Icon name="upload" /> : null}
      {m.skills_upload()}
    </Button>
  );

  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <PageHeader description={m.skills_page_description()} title={m.skills_page_title()} titleId="skills-page-title">
        {/*
         * A native file input is the only way to open the browser's file chooser; it stays hidden
         * and is triggered by the button. `type` precedes the change handler so the Kumo contract's
         * source scan sees the input's declared type before the arrow's `>`.
         */}
        <input
          type="file"
          accept=".zip,.skill,.tar.gz,.tgz"
          className="hidden"
          data-ui="skill-upload-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onFileSelected(file);
          }}
          ref={fileInputRef}
        />
        {uploadAction}
      </PageHeader>

      {storage === "unavailable" ? <Banner variant="alert">{m.skills_storage_unavailable()}</Banner> : null}
      {actionError ? <Banner variant="error">{actionError}</Banner> : null}
      {skills.isError ? (
        <Banner
          action={<Banner.Action onClick={() => void skills.refetch()}>{m.common_try_again()}</Banner.Action>}
          description={describeLoadError(skills.error)}
          role="alert"
          variant="error"
        />
      ) : null}
      {uploadBusy && uploadingName ? (
        <p className="min-w-0 wrap-anywhere text-sm text-kumo-subtle" role="status">
          {m.skills_upload_in_progress({ name: uploadingName })}
        </p>
      ) : null}

      <SkillList
        hasData={skills.data !== undefined}
        isPending={skills.isPending}
        onDelete={setDeleteTarget}
        skills={skills.data?.skills ?? []}
        storageAvailable={storageAvailable}
        uploadAction={uploadAction}
      />

      {pendingReplace ? (
        <ReplaceSkillDialog
          archiveName={pendingReplace.name}
          busy={upload.isPending}
          onCancel={() => setPendingReplace(undefined)}
          onConfirm={() => void confirmReplace()}
        />
      ) : null}
      {deleteTarget ? <RemoveSkillDialog onClose={() => setDeleteTarget(undefined)} skill={deleteTarget} /> : null}
    </section>
  );
}

/**
 * The Agent's Skills, or the reason there are none to show.
 *
 * The empty state is a statement about data that arrived: with no data yet it is a loading state while
 * pending and nothing at all once the request failed — the error banner already says why, and "No
 * Skills yet" beside a failure would claim a list the page never read.
 */
function SkillList({
  hasData,
  isPending,
  onDelete,
  skills,
  storageAvailable,
  uploadAction,
}: {
  hasData: boolean;
  isPending: boolean;
  onDelete: (skill: Skill) => void;
  skills: Skill[];
  storageAvailable: boolean;
  uploadAction: ReactNode;
}) {
  if (isPending)
    return (
      <div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
        <span aria-hidden="true">
          <Loader size="sm" />
        </span>
        {m.common_loading()}
      </div>
    );
  if (!hasData) return null;
  if (skills.length === 0)
    return (
      <Empty
        className="min-h-80 justify-center gap-4 rounded-lg bg-transparent px-4 py-10 text-sm [&_h2]:text-base"
        icon={<Icon className="size-10 text-kumo-inactive" name="file" />}
        title={m.skills_empty()}
        description={m.skills_empty_description()}
        contents={
          <div className="flex flex-col items-center gap-5 text-center">
            <Text as="p" size="sm" variant="secondary">
              {m.skills_upload_requirements()}
            </Text>
            {storageAvailable ? uploadAction : null}
          </div>
        }
      />
    );
  return (
    <ul aria-label={m.skills_list_aria()} className="grid gap-3" data-ui="skills-list">
      {skills.map((skill) => (
        <SkillRow
          downloadUrl={browserApi.agentSkillBundleUrl(skill.agentId, skill.id)}
          key={skill.id}
          onDelete={onDelete}
          skill={skill}
          storageAvailable={storageAvailable}
        />
      ))}
    </ul>
  );
}

function isNameConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === SKILL_ERROR_CODES.NAME_CONFLICT;
}

function isRevisionConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === SKILL_ERROR_CODES.REVISION_CONFLICT;
}

function actionMessage(cause: unknown): string {
  return skillErrorMessage(cause instanceof ApiError ? cause.code : undefined);
}

function describeLoadError(error: unknown): string {
  return error instanceof ApiError ? error.message : m.common_request_failed();
}
