interface NodeRecord {
  repositoryId: string;
  number?: number;
  scopeHash: string;
  expiresAt: number;
}
/** The GraphQL node index contains only identities established by repository-scoped upstream reads. */
export class GitHubNodeStore {
  readonly #nodes = new Map<string, NodeRecord>();
  constructor(
    readonly now: () => number = Date.now,
    readonly maximum = 4096,
  ) {}
  get(executionId: string, scopeHash: string, id: string): NodeRecord | undefined {
    const key = `${executionId}:${id}`;
    const row = this.#nodes.get(key);
    if (!row || row.scopeHash !== scopeHash || row.expiresAt <= this.now()) {
      this.#nodes.delete(key);
      return undefined;
    }
    return row;
  }
  remember(executionId: string, scopeHash: string, id: string, repositoryId: string, number?: number): void {
    if (!/^[A-Za-z0-9_=-]{1,256}$/.test(id)) return;
    for (const [key, row] of this.#nodes) if (row.expiresAt <= this.now()) this.#nodes.delete(key);
    if (this.#nodes.size >= this.maximum) this.#nodes.delete(this.#nodes.keys().next().value as string);
    this.#nodes.set(`${executionId}:${id}`, { repositoryId, scopeHash, number, expiresAt: this.now() + 300_000 });
  }
  forget(executionId: string): void {
    for (const key of this.#nodes.keys()) if (key.startsWith(`${executionId}:`)) this.#nodes.delete(key);
  }
}
