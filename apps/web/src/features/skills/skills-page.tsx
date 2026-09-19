import { SKILL_ERROR_CODES, type Skill, type SkillArchiveFormat } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Text } from "../../ui/design-system.js";
import { RemoveSkillDialog, ReplaceSkillDialog } from "./skill-dialogs.js";
import { SkillRow } from "./skill-row.js";
import { checkSkillArchiveFile, sha256Hex, skillErrorMessage, skillRejectionMessage } from "./skills-page-model.js";
import { useAgentSkills, useUploadSkill } from "./skills-queries.js";

/** One archive waiting on the replace confirmation, kept with its hash so it is never re-read. */
interface PendingReplace {
  file: File;
  format: SkillArchiveFormat;
  name: string;
  sha256: string;
}

/**
 * One Agent's Skills, backed by the real management API.
 *
 * The page takes only the Agent id and reads nothing from the router, so it can be mounted directly
 * in a test. Storage status comes from the list response, which an object-storage-less deployment
 * still answers: the list renders, and only uploading and downloading are disabled. No probe request
 * is made for it, so a deployment without storage never produces a failed fetch.
 */
export function SkillsPage({ agentId }: { agentId: string }) {
  const skills = useAgentSkills(agentId);
  const upload = useUploadSkill(agentId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const [uploadingName, setUploadingName] = useState<string | undefined>();
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Skill | undefined>();

  const storageAvailable = skills.data?.storage !== "unavailable";

  const openFilePicker = () => {
    setActionError(undefined);
    fileInputRef.current?.click();
  };

  const uploadArchive = async (archive: PendingReplace, replace: boolean) => {
    await upload.mutateAsync({ file: archive.file, sha256: archive.sha256, format: archive.format, replace });
  };

  const onFileSelected = async (file: File) => {
    setActionError(undefined);
    const check = checkSkillArchiveFile(file);
    if (!check.ok) {
      setActionError(skillRejectionMessage(check.rejection));
      return;
    }
    setUploadingName(file.name);
    let archive: PendingReplace | undefined;
    try {
      archive = { file, format: check.format, name: file.name, sha256: await sha256Hex(file) };
      await uploadArchive(archive, false);
    } catch (cause) {
      // A name conflict is the one failure the user resolves by confirming, so it opens the dialog
      // with the archive already hashed rather than reporting an error.
      if (archive && cause instanceof ApiError && cause.code === SKILL_ERROR_CODES.NAME_CONFLICT) {
        setPendingReplace(archive);
      } else {
        setActionError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
      }
    } finally {
      setUploadingName(undefined);
    }
  };

  const confirmReplace = async () => {
    if (!pendingReplace) return;
    setActionError(undefined);
    try {
      await uploadArchive(pendingReplace, true);
    } catch (cause) {
      setActionError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setPendingReplace(undefined);
    }
  };

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
        <Button
          disabled={!storageAvailable || upload.isPending}
          onClick={openFilePicker}
          size="compact"
          variant="secondary"
        >
          {upload.isPending ? m.skills_upload_in_progress({ name: uploadingName ?? "" }) : m.skills_upload()}
        </Button>
      </PageHeader>

      {!storageAvailable ? <Banner variant="alert">{m.skills_storage_unavailable()}</Banner> : null}
      {actionError ? <Banner variant="error">{actionError}</Banner> : null}
      {skills.isError ? <Banner variant="error">{describeLoadError(skills.error)}</Banner> : null}

      <SkillList
        agentId={agentId}
        isPending={skills.isPending}
        onDelete={setDeleteTarget}
        onError={setActionError}
        skills={skills.data?.skills ?? []}
        storageAvailable={storageAvailable}
      />

      {pendingReplace ? (
        <ReplaceSkillDialog
          archiveName={pendingReplace.name}
          busy={upload.isPending}
          onCancel={() => setPendingReplace(undefined)}
          onConfirm={() => void confirmReplace()}
        />
      ) : null}
      {deleteTarget ? (
        <RemoveSkillDialog agentId={agentId} onClose={() => setDeleteTarget(undefined)} skill={deleteTarget} />
      ) : null}
    </section>
  );
}

/** The Agent's Skills, or the reason there are none to show. */
function SkillList({
  agentId,
  isPending,
  onDelete,
  onError,
  skills,
  storageAvailable,
}: {
  agentId: string;
  isPending: boolean;
  onDelete: (skill: Skill) => void;
  onError: (message: string | undefined) => void;
  skills: Skill[];
  storageAvailable: boolean;
}) {
  if (isPending) return <Text variant="body">{m.common_loading()}</Text>;
  if (skills.length === 0) return <Text variant="secondary">{m.skills_empty()}</Text>;
  return (
    <ul aria-label={m.skills_list_aria()} className="grid gap-3" data-ui="skills-list">
      {skills.map((skill) => (
        <SkillRow
          agentId={agentId}
          downloadUrl={browserApi.agentSkillBundleUrl(agentId, skill.id)}
          key={skill.id}
          onDelete={onDelete}
          onError={onError}
          skill={skill}
          storageAvailable={storageAvailable}
        />
      ))}
    </ul>
  );
}

function describeLoadError(error: unknown): string {
  return error instanceof ApiError ? error.message : m.common_request_failed();
}
