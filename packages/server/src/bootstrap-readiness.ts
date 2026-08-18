export type BootstrapStage = "configuration" | "migration" | "application" | "listen";

const REQUIRED_STAGES: readonly BootstrapStage[] = ["configuration", "migration", "application", "listen"];

export class BootstrapReadiness {
  readonly #completed = new Set<BootstrapStage>();

  complete(stage: BootstrapStage): void {
    this.#completed.add(stage);
  }

  isReady(): boolean {
    return REQUIRED_STAGES.every((stage) => this.#completed.has(stage));
  }

  snapshot(): { ready: boolean; completedStages: BootstrapStage[] } {
    return {
      ready: this.isReady(),
      completedStages: REQUIRED_STAGES.filter((stage) => this.#completed.has(stage)),
    };
  }
}
