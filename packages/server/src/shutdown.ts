export async function closeServerResources(resources: ReadonlyArray<readonly [string, () => unknown]>): Promise<void> {
  const errors: Error[] = [];
  for (const [name, close] of resources) {
    try {
      await close();
    } catch (cause) {
      errors.push(new Error(`Failed to close ${name}`, { cause }));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Server resource cleanup failed", { cause: errors[0] });
  }
}
