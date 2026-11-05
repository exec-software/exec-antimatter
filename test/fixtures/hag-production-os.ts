/** Test-only filesystem boundary. The production modules still use their normal path logic. */
import * as actual from 'node:os';
export * from 'node:os';
export const homedir = (): string => {
  const directory = process.env.ANTIMATTER_HAG_SMOKE_HOME;
  if (!directory) throw new Error('HAG production smoke requires its private home');
  return directory;
};
export default { ...actual, homedir };
