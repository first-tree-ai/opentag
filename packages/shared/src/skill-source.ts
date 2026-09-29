import { z } from "zod";
import { SKILL_MAX_ENTRIES, SKILL_MAX_PER_AGENT, SkillErrorCodeSchema } from "./skill.js";
import { normalizeSourcePath } from "./skill-discovery.js";
import { SKILL_DESCRIPTION_MAX_LENGTH } from "./skill-manifest.js";

/**
 * Remote Skill sources: the accepted input forms, the normalized descriptor the Server fetches, and
 * the two request/response pairs the Web UI uses.
 *
 * The accepted forms follow the open skills ecosystem (skills.sh): GitHub shorthand and URLs, any
 * GitLab instance, Azure Repos, any public HTTPS git repository, a well-known discovery index, and a
 * direct download of a single `SKILL.md` or an archive. Two upstream forms are deliberately not
 * accepted because a hosted deployment has no business using them:
 *
 * - local paths (`./my-skills`, `/abs/path`), which describe the caller's file system rather than a
 *   remote source, and
 * - SSH and scp-style git addresses (`{{EMAIL_e5ngknu}}:owner/repo.git`, `ssh://…`), which require a
 *   private key the Server does not have; this platform supports public sources only.
 *
 * A URL whose authority carries user information — a user name, a password, or both — is refused
 * for the same reason: the Server never sends a caller-supplied credential to a third-party host.
 * The address rules re-check this at the point of dialing, so a credential cannot reach a peer even
 * if one is smuggled through this parser.
 *
 * This module is pure: it never performs a request and never touches the file system, so the whole
 * rule set is testable as a table. Enforcing the network policy (public addresses, HTTPS, no
 * redirects) is the fetch layer's job.
 */

/* ---------------------------------- limits --------------------------------- */

export const SKILL_SOURCE_INPUT_MAX_LENGTH = 2048;
/** Maximum bytes read for one direct download. */
export const SKILL_SOURCE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** Maximum total bytes an unpacked download may hold. */
export const SKILL_SOURCE_EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
/** Maximum entries an unpacked download may hold. */
export const SKILL_SOURCE_EXTRACT_MAX_FILES = 1000;
/** Maximum bytes a fetched repository snapshot may occupy on disk. */
export const SKILL_SOURCE_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
/** Maximum candidates one resolve may return. */
export const SKILL_SOURCE_MAX_CANDIDATES = 200;
/**
 * Maximum bytes a preview will download to bind candidates to their content.
 *
 * Only the legacy well-known layout needs this: it publishes no content hash, so a preview has to
 * read a Skill's files to know what it offers. The budget stops a long catalog from turning one
 * preview into a download of the whole catalog.
 */
export const SKILL_SOURCE_PREVIEW_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
/** Deadline for the git transfer of one source. */
export const SKILL_SOURCE_GIT_TIMEOUT_MS = 60_000;
/** Deadline for one HTTP request to a source. */
export const SKILL_SOURCE_HTTP_TIMEOUT_MS = 30_000;

/* --------------------------------- sources --------------------------------- */

export const SkillSourceKindSchema = z.enum(["github", "gitlab", "azure", "git", "well_known", "download"]);
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>;

/**
 * A normalized source. `url` is what the fetcher dials — a clone URL for the four repository kinds,
 * a document or artifact URL for the other two. `subpath` confines discovery to one directory of the
 * repository, and `skillFilter` is the name filter a `#ref@skill` or `owner/repo@skill` input
 * carries.
 */
export const RemoteSkillSourceSchema = z
  .object({
    kind: SkillSourceKindSchema,
    url: z.string().min(1).max(SKILL_SOURCE_INPUT_MAX_LENGTH),
    ref: z.string().min(1).max(256).optional(),
    subpath: z.string().min(1).max(1024).optional(),
    skillFilter: z.string().min(1).max(256).optional(),
  })
  .strict();
export type RemoteSkillSource = z.infer<typeof RemoteSkillSourceSchema>;

export const SkillSourceRejectionSchema = z.enum(["empty", "unsupported", "unsafe_subpath"]);
export type SkillSourceRejection = z.infer<typeof SkillSourceRejectionSchema>;

export type ParseSkillSourceResult =
  | { ok: true; source: RemoteSkillSource }
  | { ok: false; rejection: SkillSourceRejection };

interface SourceFragment {
  ref?: string;
  skillFilter?: string;
}

type SourceRule = (input: string, fragment: SourceFragment) => RemoteSkillSource | undefined;

/* --------------------------------- parsing --------------------------------- */

function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function decodeFragmentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLocalPath(input: string): boolean {
  return (
    input.startsWith("/") ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".." ||
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

/** `git@host:path` and `ssh://…` both need a private key, which a hosted Server never holds. */
function isSshAddress(input: string): boolean {
  return input.startsWith("ssh://") || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(input);
}

const GITHUB_REPOSITORY_PATH = /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/;
const GITLAB_REPOSITORY_PATH = /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/;
const GENERIC_GIT_URL = /^https?:\/\/.+\.git(?:$|[/?])/i;

/**
 * Whether a URL fragment should be read as a git ref. Only repository-shaped URLs qualify, so a
 * fragment on an ordinary document URL keeps its own meaning; a `blob` or `archive` URL is not
 * repository-shaped and therefore never contributes a ref.
 */
function looksLikeGitSource(input: string): boolean {
  if (input.startsWith("github:") || input.startsWith("gitlab:")) return true;
  const url = parseUrl(input);
  if (url === undefined) {
    return (
      !input.includes(":") &&
      !input.startsWith(".") &&
      !input.startsWith("/") &&
      /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input)
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (url.hostname === "github.com") return GITHUB_REPOSITORY_PATH.test(url.pathname);
  if (url.hostname === "gitlab.com") return GITLAB_REPOSITORY_PATH.test(url.pathname);
  const gitIndex = segments.indexOf("_git");
  if (gitIndex >= 0 && gitIndex < segments.length - 1) return true;
  return GENERIC_GIT_URL.test(input);
}

function splitFragment(input: string): { body: string; fragment: SourceFragment } {
  const hashIndex = input.indexOf("#");
  if (hashIndex < 0) return { body: input, fragment: {} };
  const body = input.slice(0, hashIndex);
  if (!looksLikeGitSource(body)) return { body: input, fragment: {} };
  const fragment = input.slice(hashIndex + 1);
  if (fragment === "") return { body: input, fragment: {} };
  const atIndex = fragment.indexOf("@");
  if (atIndex < 0) return { body, fragment: { ref: decodeFragmentValue(fragment) } };
  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    body,
    fragment: {
      ...(ref === "" ? {} : { ref: decodeFragmentValue(ref) }),
      ...(skillFilter === "" ? {} : { skillFilter: decodeFragmentValue(skillFilter) }),
    },
  };
}

function repository(kind: SkillSourceKind, url: string, fragment: SourceFragment, subpath?: string): RemoteSkillSource {
  const directory = subpath === undefined || subpath === "" ? undefined : subpath;
  return {
    kind,
    url,
    ...(fragment.ref === undefined ? {} : { ref: fragment.ref }),
    ...(directory === undefined ? {} : { subpath: directory }),
    ...(fragment.skillFilter === undefined ? {} : { skillFilter: fragment.skillFilter }),
  };
}

/** The subpath of a repository URL as a source-relative directory; an empty string when there is none. */
function subpathOf(segments: readonly string[]): string {
  return normalizeSourcePath(segments.join("/")) ?? "";
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment;
}

const hostedArtifactRule: SourceRule = (input) => {
  const url = parseUrl(input);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  const host = url.hostname;
  if (
    host === "raw.githubusercontent.com" ||
    host === "codeload.github.com" ||
    host === "objects.githubusercontent.com"
  ) {
    return { kind: "download", url: input };
  }
  if (
    host === "github.com" &&
    /^\/[^/]+\/[^/]+\/(?:archive\/|raw\/|releases\/(?:download\/|latest\/download\/))/.test(url.pathname)
  ) {
    return { kind: "download", url: input };
  }
  if (host === "gitlab.com" && /\/-\/(?:archive|raw)\//.test(url.pathname)) return { kind: "download", url: input };
  return undefined;
};

const githubPrefixRule: SourceRule = (input, fragment) =>
  input.startsWith("github:") ? matchSource(input.slice("github:".length).trim(), fragment) : undefined;

const gitlabPrefixRule: SourceRule = (input, fragment) =>
  input.startsWith("gitlab:")
    ? matchSource(`https://gitlab.com/${input.slice("gitlab:".length).trim()}`, fragment)
    : undefined;

const githubRule: SourceRule = (input, fragment) => {
  const url = parseUrl(input);
  if (url === undefined || url.hostname !== "github.com") return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] ?? "");
  if (owner === undefined || repo === "" || owner === "") return undefined;
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  if (segments[2] !== "tree") return repository("github", cloneUrl, fragment);
  const ref = segments[3];
  if (ref === undefined || ref === "") return repository("github", cloneUrl, fragment);
  const subpath = subpathOf(segments.slice(4));
  return repository("github", cloneUrl, { ...fragment, ref }, subpath);
};

const gitlabRule: SourceRule = (input, fragment) => {
  const url = parseUrl(input);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  if (url.hostname === "github.com") return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  const treeIndex = segments.indexOf("-");
  let repoPath: string[];
  let ref: string | undefined;
  let subpathSegments: string[] = [];
  if (treeIndex > 0 && segments[treeIndex + 1] === "tree") {
    repoPath = segments.slice(0, treeIndex);
    ref = segments[treeIndex + 2];
    subpathSegments = segments.slice(treeIndex + 3);
  } else {
    if (url.hostname !== "gitlab.com") return undefined;
    repoPath = segments;
  }
  const repositoryPath = repoPath.map((segment, index) =>
    index === repoPath.length - 1 ? stripGitSuffix(segment) : segment,
  );
  const cloneUrl = `${url.protocol}//${url.hostname}/${repositoryPath.join("/")}.git`;
  const subpath = subpathOf(subpathSegments);
  return repository("gitlab", cloneUrl, { ...fragment, ...(ref === undefined ? {} : { ref }) }, subpath);
};

const azureReposRule: SourceRule = (input, fragment) => {
  const url = parseUrl(input);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const gitIndex = segments.indexOf("_git");
  if (gitIndex < 0 || gitIndex === segments.length - 1) return undefined;
  const repo = stripGitSuffix(segments[gitIndex + 1] ?? "");
  if (repo === "") return undefined;
  const cloneUrl = `${url.protocol}//${url.hostname}/${[...segments.slice(0, gitIndex), "_git", repo].join("/")}`;
  // Azure encodes the ref as `version=GB<branch>` or `GT<tag>`; a bare commit id is not usable.
  const version = /^(?:GB|GT)(.+)$/i.exec(url.searchParams.get("version") ?? "")?.[1];
  const path = url.searchParams.get("path");
  const subpath = path === null ? "" : subpathOf(path.split("/").filter((segment) => segment !== ""));
  return repository("azure", cloneUrl, version === undefined ? fragment : { ...fragment, ref: version }, subpath);
};

const shorthandRule: SourceRule = (input, fragment) => {
  if (input.includes(":") || input.startsWith(".") || input.startsWith("/")) return undefined;
  const atSkill = /^([^/]+)\/([^/@]+)@(.+)$/.exec(input);
  if (atSkill !== null) {
    const [, owner, repo, skill] = atSkill;
    if (skill === undefined || skill === "") return undefined;
    return repository("github", `https://github.com/${owner}/${stripGitSuffix(repo ?? "")}.git`, {
      ...fragment,
      skillFilter: skill,
    });
  }
  const segments = input.split("/");
  if (segments.length < 2) return undefined;
  const owner = segments[0] ?? "";
  const repo = stripGitSuffix(segments[1] ?? "");
  if (owner === "" || repo === "") return undefined;
  const subpath = subpathOf(segments.slice(2));
  return repository("github", `https://github.com/${owner}/${repo}.git`, fragment, subpath);
};

const wellKnownRule: SourceRule = (input) => {
  const url = parseUrl(input);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  if (url.hostname === "github.com" || url.hostname === "gitlab.com" || url.hostname === "raw.githubusercontent.com") {
    return undefined;
  }
  if (input.endsWith(".git")) return undefined;
  return { kind: "well_known", url: input };
};

const genericGitRule: SourceRule = (input, fragment) => {
  const url = parseUrl(input);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  return repository("git", input, fragment);
};

/**
 * Ordered exactly as the ecosystem resolves: the two shorthand prefixes, then hosted artifacts, then
 * GitHub, GitLab, Azure Repos, bare `owner/repo`, well-known discovery, and finally a generic git
 * URL. The first match wins.
 */
const SOURCE_RULES: readonly SourceRule[] = [
  githubPrefixRule,
  gitlabPrefixRule,
  hostedArtifactRule,
  githubRule,
  gitlabRule,
  azureReposRule,
  shorthandRule,
  wellKnownRule,
  genericGitRule,
];

function matchSource(input: string, fragment: SourceFragment): RemoteSkillSource | undefined {
  for (const rule of SOURCE_RULES) {
    const source = rule(input, fragment);
    if (source !== undefined) return source;
  }
  return undefined;
}

/**
 * Whether any path segment of the input is `..`, checked on the raw text before URL parsing.
 *
 * The text is what the user typed: WHATWG URL normalization silently resolves `..` segments away, so
 * a check on `url.pathname` would see `a/../../b` as an ordinary path and hand the repository a ref
 * the user never meant. Percent-encoded dots are checked too, because a source is never expected to
 * carry them.
 */
function hasUnsafePathSegment(input: string): boolean {
  const path = input.split(/[?#]/, 1)[0] ?? input;
  const decoded = decodeFragmentValue(path);
  return [path, decoded].some((candidate) => candidate.split("/").some((segment) => segment === ".."));
}

/**
 * Normalizes one user-supplied source. A bare `owner/repo` means GitHub, as it does in the ecosystem;
 * every other host must be named by URL. Rejections are deliberately coarse — the caller maps them to
 * one public error code — but `unsafe_subpath` is separated so a traversal attempt is visible in logs
 * without any of it reaching the user.
 */
export function parseSkillSource(rawInput: string): ParseSkillSourceResult {
  const input = rawInput.trim();
  if (input === "") return { ok: false, rejection: "empty" };
  if (isLocalPath(input) || isSshAddress(input)) return { ok: false, rejection: "unsupported" };
  const url = parseUrl(input);
  if (url !== undefined && (url.username !== "" || url.password !== "")) {
    return { ok: false, rejection: "unsupported" };
  }
  const { body, fragment } = splitFragment(input);
  if (body === "") return { ok: false, rejection: "empty" };
  if (hasUnsafePathSegment(body)) return { ok: false, rejection: "unsafe_subpath" };
  const source = matchSource(body, fragment);
  if (source === undefined) return { ok: false, rejection: "unsupported" };
  return { ok: true, source };
}

/* ------------------------------ install contract --------------------------- */

export const RemoteSkillUnavailableReasonSchema = z.enum([
  "manifest_invalid",
  "name_reserved",
  "too_large",
  "path_invalid",
]);
export type RemoteSkillUnavailableReason = z.infer<typeof RemoteSkillUnavailableReasonSchema>;

/**
 * One installable Skill found at the source. `path` is where it lives inside the source, which is
 * what the user needs in order to tell two same-named Skills apart. `name` is the manifest name, or
 * the directory's own name when the manifest is unreadable, so an unusable candidate is still
 * listed and explained rather than silently dropped.
 *
 * `fileCount` and `bytes` are reported only when the source already knows them: an in-memory source
 * knows both, a repository listing knows the file count, and a well-known index knows neither until
 * the artifact is downloaded. The UI therefore treats them as optional detail rather than as a
 * promise, which is what keeps a preview from downloading every candidate in a large catalog.
 *
 * `fingerprint` identifies the content the preview saw, and install refuses a candidate whose
 * fingerprint no longer matches. Without it the promise "what you previewed can have moved, and the
 * result says so" would be false: a branch or index rewritten at the same name would install quietly.
 * The value is opaque to the client and is only ever compared.
 */
export const RemoteSkillCandidateSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(SKILL_DESCRIPTION_MAX_LENGTH),
    path: z.string().min(1).max(1024),
    fileCount: z.number().int().min(0).max(SKILL_MAX_ENTRIES).optional(),
    bytes: z.number().int().min(0).optional(),
    alreadyInstalled: z.boolean(),
    fingerprint: z.string().min(1).max(200),
    unavailableReason: RemoteSkillUnavailableReasonSchema.optional(),
  })
  .strict();
export type RemoteSkillCandidate = z.infer<typeof RemoteSkillCandidateSchema>;

const SkillSourceInputSchema = z.string().trim().min(1).max(SKILL_SOURCE_INPUT_MAX_LENGTH);

export const ResolveRemoteSkillsRequestSchema = z.object({ source: SkillSourceInputSchema }).strict();
export type ResolveRemoteSkillsRequest = z.infer<typeof ResolveRemoteSkillsRequestSchema>;

export const ResolveRemoteSkillsResponseSchema = z
  .object({
    source: RemoteSkillSourceSchema,
    skills: z.array(RemoteSkillCandidateSchema).max(SKILL_SOURCE_MAX_CANDIDATES),
  })
  .strict();
export type ResolveRemoteSkillsResponse = z.infer<typeof ResolveRemoteSkillsResponseSchema>;

/**
 * The selection carries the fingerprint the preview reported, not just the name. The install is
 * therefore a statement about exact content, and the Server rejects an item whose source changed
 * between the two calls instead of installing bytes the user never saw.
 */
export const RemoteSkillSelectionSchema = z
  .object({
    // Trimmed before the length check, so a whitespace-only name is a validation failure at the
    // boundary rather than a trimmed-to-empty name that no install result can represent.
    name: z.string().trim().min(1).max(128),
    fingerprint: z.string().min(1).max(200),
  })
  .strict();
export type RemoteSkillSelection = z.infer<typeof RemoteSkillSelectionSchema>;

export const InstallRemoteSkillsRequestSchema = z
  .object({
    source: SkillSourceInputSchema,
    selections: z.array(RemoteSkillSelectionSchema).min(1).max(SKILL_MAX_PER_AGENT),
  })
  .strict();
export type InstallRemoteSkillsRequest = z.infer<typeof InstallRemoteSkillsRequestSchema>;

export const RemoteSkillInstallStatusSchema = z.enum(["installed", "skipped_name_conflict", "failed"]);
export type RemoteSkillInstallStatus = z.infer<typeof RemoteSkillInstallStatusSchema>;

export const RemoteSkillInstallResultSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    status: RemoteSkillInstallStatusSchema,
    /** Present exactly when the item failed, so the UI can render the reason as a sentence. */
    errorCode: SkillErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "failed" && result.errorCode === undefined) {
      context.addIssue({ code: "custom", path: ["errorCode"], message: "A failed item carries its error code" });
    }
    if (result.status !== "failed" && result.errorCode !== undefined) {
      context.addIssue({ code: "custom", path: ["errorCode"], message: "Only a failed item carries an error code" });
    }
  });
export type RemoteSkillInstallResult = z.infer<typeof RemoteSkillInstallResultSchema>;

export const InstallRemoteSkillsResponseSchema = z
  .object({ results: z.array(RemoteSkillInstallResultSchema).max(SKILL_MAX_PER_AGENT) })
  .strict();
export type InstallRemoteSkillsResponse = z.infer<typeof InstallRemoteSkillsResponseSchema>;
