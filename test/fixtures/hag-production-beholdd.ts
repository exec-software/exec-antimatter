/** Replace the unrelated bundled listener boundary, never the configured source/provider. */
import * as actual from '../../src/main/beholdd';
export * from '../../src/main/beholdd';
export const start = async () => {
  (globalThis as any).__hagProductionSmoke.boundaries.bundledStartupSuppressed++;
  return actual.status();
};
export const inspectStatus = async () => actual.status();
export const endpointAnswers = async () => false;
export const restart = async (): Promise<never> => { throw new Error('HAG smoke forbids bundled restart'); };
