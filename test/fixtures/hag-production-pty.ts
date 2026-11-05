export const spawn = (..._args: unknown[]): never => {
  (globalThis as any).__hagProductionSmoke.boundaries.deniedChildren.push({ method: 'node-pty.spawn' });
  throw new Error('HAG production smoke forbids terminal startup');
};
