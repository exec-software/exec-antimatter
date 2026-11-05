/**
 * The MCP server itself is launched through Electron in Node mode. Passing that marker on to a
 * desktop program can make another Electron app start as a bare Node process, so grandchildren
 * get an ordinary user environment while retaining PATH and the graphical-session variables.
 */
export function cleanChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ELECTRON_OVERRIDE')) continue;
    env[key] = value;
  }
  return env;
}
