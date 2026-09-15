export function parseRunnerScriptArgv(argv) {
  const command = argv[0];
  const options = {};
  if (!command) return { ok: false, error: "missing command", exitCode: 2 };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      return { ok: false, error: `invalid argument sequence near "${key ?? ""}"`, exitCode: 2 };
    }
    options[key.slice(2)] = value;
  }
  return { ok: true, command, options };
}

export function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}
