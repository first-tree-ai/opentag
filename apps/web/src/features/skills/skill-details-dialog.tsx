import { type ReadSkillFileResponse, SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, buttonClassName, Dialog, Empty, Icon, Loader, Select } from "../../ui/design-system.js";
import { focusSkillHeading, SkillReaderMarkdown } from "./skill-reader-markdown.js";
import { type SkillFileNode, skillFileTree, splitSkillFrontmatter } from "./skill-reader-model.js";
import { formatArchiveBytes } from "./skills-page-model.js";
import { useSkillFile } from "./skills-queries.js";
import "./skill-reader.css";

/** Keep the dialog mounted for focus restoration; package state exists only while it is open. */
export function SkillDetailsDialog({
  skill,
  onClose,
  returnFocusRef,
  storageAvailable,
}: {
  skill: Skill | undefined;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  storageAvailable: boolean;
}) {
  const identity = skill ? `${skill.agentId}/${skill.id}/${skill.archiveSha256}` : undefined;
  const [unavailableIdentity, setUnavailableIdentity] = useState<string>();
  const markUnavailable = useCallback(() => setUnavailableIdentity(identity), [identity]);
  return (
    <Dialog
      className="skill-reader-dialog"
      open={skill !== undefined}
      onClose={onClose}
      title={skill?.name ?? m.skills_details_title()}
      returnFocusRef={returnFocusRef}
      headerActions={
        skill && storageAvailable && unavailableIdentity !== identity ? (
          <a
            className={buttonClassName({ size: "compact", variant: "secondary" })}
            href={browserApi.agentSkillBundleUrl(skill.agentId, skill.id)}
            download={`${skill.name}.tar.gz`}
          >
            {m.skills_download()}
          </a>
        ) : undefined
      }
    >
      {skill ? <SkillReader key={identity} skill={skill} onUnavailable={markUnavailable} /> : null}
    </Dialog>
  );
}

function SkillReader({ skill, onUnavailable }: { skill: Skill; onUnavailable: () => void }) {
  const [selection, setSelection] = useState<{ path: string; focus?: boolean; fragment?: string }>({
    path: "SKILL.md",
  });
  const { path } = selection;
  const manifest = useSkillFile(skill, "SKILL.md", true);
  const files = manifest.data?.files ?? [];
  const file = useSkillFile(skill, path, true);
  // A missing member alone does not prove that the whole package is unavailable.
  const detail = useQuery({
    queryKey: queryKeys.skills.skill(skill.agentId, skill.id),
    queryFn: () => browserApi.agentSkill(skill.agentId, skill.id),
    enabled: isMissing(file.error),
    staleTime: 0,
    retry: false,
    gcTime: 0,
  });
  const unavailable = isMissing(file.error) && isMissing(detail.error);
  const client = useQueryClient();
  const multiFile = skill.fileCount > 1;
  const scroll = useRef<HTMLElement>(null);
  useEffect(() => {
    if (file.data) {
      if (selection.focus) scroll.current?.focus({ preventScroll: true });
      if (selection.fragment) focusSkillHeading(scroll.current, selection.fragment);
    }
  }, [file.data, selection]);
  useEffect(() => {
    if (unavailable) onUnavailable();
  }, [unavailable, onUnavailable]);
  useEffect(() => {
    if (unavailable || (file.error instanceof ApiError && file.error.code === SKILL_ERROR_CODES.REVISION_CONFLICT)) {
      // Refresh management state without repeating a terminal content-addressed read.
      void client.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(skill.agentId), exact: true });
    }
  }, [file.error, skill.agentId, client, unavailable]);
  const selectFile = (next: string, focus = false, fragment?: string) => {
    setSelection({ path: next, focus, fragment });
    if (scroll.current) scroll.current.scrollTop = 0;
  };
  const bytes = files.find((entry) => entry.path === path)?.bytes;
  return (
    <div className={`skill-reader-layout${multiFile ? " skill-reader-layout--files" : ""}`}>
      {multiFile ? (
        <ReaderFiles files={files} selected={path} pending={manifest.isPending} onSelect={selectFile} />
      ) : null}
      <div className="skill-reader-main">
        <div className="skill-reader-toolbar">
          <ReaderToolbar path={path} bytes={bytes} multiFile={multiFile} />
          {multiFile ? <ReaderFileSelect files={files} selected={path} onSelect={selectFile} /> : null}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll the reading region. */}
        <section className="skill-reader-scroll" ref={scroll} tabIndex={0} aria-label={path} aria-busy={file.isPending}>
          {path === "SKILL.md" &&
          file.data?.preview.status === "text" &&
          file.data.preview.content &&
          skill.description ? (
            <p className="skill-reader-summary ui-text text-kumo-subtle" data-text-size="sm">
              <span className="font-semibold">{m.skills_details_description()}</span> {skill.description}
            </p>
          ) : null}
          {file.isPending ? (
            <Loading />
          ) : file.isError ? (
            <ReaderError error={file.error} onRetry={() => void file.refetch()} />
          ) : file.data ? (
            <FileContent key={path} data={file.data} onSelect={(next, fragment) => selectFile(next, true, fragment)} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === SKILL_ERROR_CODES.NOT_FOUND;
}

function FileNodes({
  nodes,
  selected,
  onSelect,
}: {
  nodes: SkillFileNode[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="grid gap-1">
      {nodes.map((node) => (
        <li key={`${node.path}/${node.children ? "folder" : "file"}`}>
          {node.children ? (
            <FileFolder node={node} selected={selected} onSelect={onSelect} />
          ) : (
            <Button
              className={`skill-reader-file${selected === node.path ? " skill-reader-file--selected" : ""}`}
              variant="ghost"
              size="compact"
              aria-current={selected === node.path ? "page" : undefined}
              title={node.path}
              onClick={() => onSelect(node.path)}
            >
              <Icon name="file" />
              <span className="truncate">{node.name}</span>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function FileFolder({
  node,
  selected,
  onSelect,
}: {
  node: SkillFileNode;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <Button
        className="skill-reader-file"
        variant="ghost"
        size="compact"
        aria-expanded={expanded}
        title={node.path}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} />
        <span className="truncate">{node.name}</span>
      </Button>
      {expanded ? (
        <div className="ml-3 border-l border-kumo-line pl-2">
          <FileNodes nodes={node.children ?? []} selected={selected} onSelect={onSelect} />
        </div>
      ) : null}
    </>
  );
}

function FileContent({
  data,
  onSelect,
}: {
  data: ReadSkillFileResponse;
  onSelect: (path: string, fragment?: string) => void;
}) {
  if (data.preview.status !== "text")
    return (
      <Empty
        className="skill-reader-empty"
        title={data.preview.status === "binary" ? m.skills_details_binary_title() : m.skills_details_large_title()}
        description={data.preview.status === "binary" ? m.skills_details_binary() : m.skills_details_large()}
      />
    );
  const markdown = /\.(md|markdown)$/i.test(data.path);
  if (!data.preview.content || (markdown && !splitSkillFrontmatter(data.preview.content).body.trim())) {
    return <Empty className="skill-reader-empty" title={m.skills_details_empty()} />;
  }
  return !markdown ? (
    <pre className="skill-reader-source">
      <code>{data.preview.content}</code>
    </pre>
  ) : (
    <article className="skill-reader-article">
      <SkillReaderMarkdown content={data.preview.content} path={data.path} files={data.files} onSelect={onSelect} />
    </article>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 p-6 text-sm text-kumo-subtle" role="status">
      <Loader size="sm" />
      {m.common_loading()}
    </div>
  );
}

function ReaderError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : undefined;
  const terminal = code === SKILL_ERROR_CODES.REVISION_CONFLICT || code === SKILL_ERROR_CODES.NOT_FOUND;
  return (
    <div className="p-5">
      <Banner
        variant="error"
        role="alert"
        description={
          code === SKILL_ERROR_CODES.REVISION_CONFLICT
            ? m.skills_details_changed()
            : code === SKILL_ERROR_CODES.NOT_FOUND
              ? m.skills_details_missing()
              : m.skills_details_failed()
        }
        action={terminal ? undefined : <Banner.Action onClick={onRetry}>{m.common_try_again()}</Banner.Action>}
      />
    </div>
  );
}

function ReaderToolbar({ path, bytes, multiFile }: { path: string; bytes: number | undefined; multiFile: boolean }) {
  return (
    <div className={`skill-reader-current-file${multiFile ? " skill-reader-current-file--desktop" : ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="file" className="shrink-0 text-kumo-subtle" />
        <span className="truncate text-sm" title={path}>
          {path}
        </span>
        {bytes !== undefined ? (
          <span className="hidden shrink-0 text-xs text-kumo-subtle sm:inline">{formatArchiveBytes(bytes)}</span>
        ) : null}
      </div>
    </div>
  );
}

function ReaderFiles({
  files,
  selected,
  pending,
  onSelect,
}: {
  files: import("@opentag/shared/browser").SkillFileEntry[];
  selected: string;
  pending: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <nav className="skill-reader-files" aria-label={m.skills_details_files()}>
      {files.length ? (
        <FileNodes nodes={skillFileTree(files)} selected={selected} onSelect={onSelect} />
      ) : pending ? (
        <Loading />
      ) : null}
    </nav>
  );
}

function ReaderFileSelect({
  files,
  selected,
  onSelect,
}: {
  files: import("@opentag/shared/browser").SkillFileEntry[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="skill-reader-mobile-files">
      <Select
        className="w-full min-w-0 max-w-full"
        disabled={files.length === 0}
        aria-label={m.skills_details_file_label()}
        value={selected}
        onValueChange={(value) => {
          if (value) onSelect(value);
        }}
      >
        {(files.length ? files : [{ path: "SKILL.md", bytes: 0 }]).map((entry) => (
          <Select.Option key={entry.path} value={entry.path}>
            {entry.path}
          </Select.Option>
        ))}
      </Select>
    </div>
  );
}
