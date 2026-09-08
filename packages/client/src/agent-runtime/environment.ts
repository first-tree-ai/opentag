import { delimiter } from "node:path";

/** Compose all environment layers before giving Session tools first place on PATH. */
export function composeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  workspaceEnvironment?: Readonly<Record<string, string>>,
  pathPrepend?: string,
): NodeJS.ProcessEnv {
  const composed = { ...environment, ...workspaceEnvironment };
  const current = composed.PATH;
  if (pathPrepend && current !== pathPrepend && !current?.startsWith(`${pathPrepend}${delimiter}`)) {
    composed.PATH = current ? `${pathPrepend}${delimiter}${current}` : pathPrepend;
  }
  return composed;
}
