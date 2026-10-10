import type { SkillFileEntry } from "@opentag/shared/browser";

export interface SkillFileNode {
  name: string;
  path: string;
  children?: SkillFileNode[];
}

export function skillFileTree(files: SkillFileEntry[]): SkillFileNode[] {
  const root: SkillFileNode[] = [];
  for (const file of files) {
    let nodes = root;
    const parts = file.path.split("/");
    for (const [index, name] of parts.entries()) {
      const path = parts.slice(0, index + 1).join("/");
      let node = nodes.find((item) => item.path === path && Boolean(item.children) === index < parts.length - 1);
      if (!node) {
        node = { name, path, ...(index < parts.length - 1 ? { children: [] } : {}) };
        nodes.push(node);
      }
      if (node.children) nodes = node.children;
    }
  }
  const sort = (nodes: SkillFileNode[]): SkillFileNode[] =>
    nodes
      .sort((a, b) => {
        if (a.path === "SKILL.md") return -1;
        if (b.path === "SKILL.md") return 1;
        return Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name);
      })
      .map((node) => ({ ...node, ...(node.children ? { children: sort(node.children) } : {}) }));
  return sort(root);
}

/** Resolve only real package members; relative links never become browser navigation. */
export function resolveSkillFileLink(href: string, currentPath: string, files: SkillFileEntry[]): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(href.split(/[?#]/)[0] ?? "");
  } catch {
    return undefined;
  }
  if (!pathname || pathname.includes("\\")) return undefined;
  const path = resolveRelativePath(pathname, currentPath);
  return files.some((file) => file.path === path) ? path : undefined;
}

function resolveRelativePath(pathname: string, currentPath: string): string | undefined {
  const parts = pathname.startsWith("/") ? [] : currentPath.split("/").slice(0, -1);
  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function splitSkillFrontmatter(text: string): { frontmatter?: string; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? { frontmatter: match[0], body: text.slice(match[0].length) } : { body: text };
}

export function skillHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}
