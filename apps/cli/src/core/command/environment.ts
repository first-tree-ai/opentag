/** Build a detached child-process environment without changing the parent process. */
export function buildChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  options: { keys?: readonly string[]; overrides?: NodeJS.ProcessEnv } = {},
): NodeJS.ProcessEnv {
  const keys = options.keys ?? Object.keys(baseEnvironment);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = baseEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
