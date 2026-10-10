import { type ReadSkillFileResponse, SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, buttonClassName, Dialog, Empty, Icon, Loader, Select } from "../../ui/design-system.js";
import { SkillReaderMarkdown } from "./skill-reader-markdown.js";
import { type SkillFileNode, skillFileTree } from "./skill-reader-model.js";
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
  return (
    <Dialog
      className="skill-reader-dialog"
      open={skill !== undefined}
      onClose={onClose}
      title={skill?.name ?? m.skills_details_title()}
      eyebrow={m.skills_details_title()}
      returnFocusRef={returnFocusRef}
      headerActions={
        skill && storageAvailable ? (
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
      {skill ? <SkillReader key={`${skill.agentId}/${skill.id}/${skill.archiveSha256}`} skill={skill} /> : null}
    </Dialog>
  );
}

function SkillReader({ skill }: { skill: Skill }) {
  const [path, setPath] = useState("SKILL.md");
  const manifest = useSkillFile(skill, "SKILL.md", true);
  const files = manifest.data?.files ?? [];
  const [source, setSource] = useState(false);
  const file = useSkillFile(skill, path, true);
  const client = useQueryClient();
  const multiFile = skill.fileCount > 1;
  const markdown = /\.(md|markdown)$/i.test(path);
  const scroll = useRef<HTMLElement>(null);
  const focusReading = useRef(false);
  useEffect(() => {
    if (file.data && focusReading.current) {
      scroll.current?.focus({ preventScroll: true });
      focusReading.current = false;
    }
  }, [file.data]);
  useEffect(() => {
    if (file.error instanceof ApiError && file.error.code === SKILL_ERROR_CODES.REVISION_CONFLICT) {
      // Refresh the list only: refetching this reader would repeat the same stale-hash failure.
      void client.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(skill.agentId), exact: true });
    }
  }, [file.error, skill.agentId, client]);
  const selectFile = (next: string, focus = false) => {
    focusReading.current = focus;
    setPath(next);
    setSource(false);
    if (scroll.current) scroll.current.scrollTop = 0;
  };
  const bytes = files.find((entry) => entry.path === path)?.bytes;
  return (
    <div className={`skill-reader-layout${multiFile ? " skill-reader-layout--files" : ""}`}>
      {multiFile ? (
        <ReaderFiles files={files} selected={path} pending={manifest.isPending} onSelect={selectFile} />
      ) : null}
      <div className="skill-reader-main">
        <ReaderToolbar
          path={path}
          bytes={bytes}
          canToggle={markdown && file.data?.preview.status === "text"}
          source={source}
          setSource={setSource}
        />
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll the reading region. */}
        <section className="skill-reader-scroll" ref={scroll} tabIndex={0} aria-label={path} aria-busy={file.isPending}>
          {file.isPending ? (
            <Loading />
          ) : file.isError ? (
            <ReaderError error={file.error} onRetry={() => void file.refetch()} />
          ) : file.data ? (
            <FileContent
              key={`${path}/${source}`}
              data={file.data}
              source={source || !markdown}
              onSelect={(next) => selectFile(next, true)}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
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
  source,
  onSelect,
}: {
  data: ReadSkillFileResponse;
  source: boolean;
  onSelect: (path: string) => void;
}) {
  if (data.preview.status !== "text")
    return (
      <Empty
        className="skill-reader-empty"
        title={data.preview.status === "binary" ? m.skills_details_binary_title() : m.skills_details_large_title()}
        description={data.preview.status === "binary" ? m.skills_details_binary() : m.skills_details_large()}
      />
    );
  if (!data.preview.content) return <Empty className="skill-reader-empty" title={m.skills_details_empty()} />;
  return source ? (
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

function ReaderToolbar({
  path,
  bytes,
  canToggle,
  source,
  setSource,
}: {
  path: string;
  bytes: number | undefined;
  canToggle: boolean;
  source: boolean;
  setSource: (source: boolean) => void;
}) {
  return (
    <div className="skill-reader-toolbar">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="file" className="shrink-0 text-kumo-subtle" />
        <span className="truncate text-sm" title={path}>
          {path}
        </span>
        {bytes !== undefined ? (
          <span className="hidden shrink-0 text-xs text-kumo-subtle sm:inline">{formatArchiveBytes(bytes)}</span>
        ) : null}
      </div>
      {canToggle ? (
        <fieldset className="flex shrink-0 gap-1" aria-label={m.skills_details_reading()}>
          <Button
            variant={source ? "ghost" : "secondary"}
            size="compact"
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            {m.skills_details_reading()}
          </Button>
          <Button
            variant={source ? "secondary" : "ghost"}
            size="compact"
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            {m.skills_details_source()}
          </Button>
        </fieldset>
      ) : null}
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
    <>
      <nav className="skill-reader-files" aria-label={m.skills_details_files()}>
        <p className="mb-3 text-xs font-semibold text-kumo-subtle">{m.skills_details_files()}</p>
        {files.length ? (
          <FileNodes nodes={skillFileTree(files)} selected={selected} onSelect={onSelect} />
        ) : pending ? (
          <Loading />
        ) : null}
      </nav>
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
    </>
  );
}
