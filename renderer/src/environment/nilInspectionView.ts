import type { NyInspectedFunction, NyInspectedInstruction, NyModuleInspection } from '../../../src/api/nyInspector';

export const NIL_PAGE_SIZE = 100;
const normalized = (query: string) => query.trim().toLocaleLowerCase();
const includes = (values: (string | number | undefined)[], query: string) => values.some((value) => String(value ?? '').toLocaleLowerCase().includes(query));

export function nilInstructionMatches(instruction: NyInspectedInstruction, query: string): boolean {
  const search = normalized(query);
  return !search || includes([instruction.offset, instruction.opcode, ...instruction.operands,
    instruction.source?.path, instruction.source?.line, instruction.debugLine || undefined,
    ...(instruction.locals ?? []).flatMap((local) => [local.name, local.storage, local.type])], search);
}

export function nilFunctionMatches(fn: NyInspectedFunction, query: string): boolean {
  const search = normalized(query);
  return !search || includes([fn.name, fn.returnType, ...fn.parameters, ...fn.generics, ...fn.annotations], search);
}

export function nilMatchingFunctions(module: NyModuleInspection, query: string): NyInspectedFunction[] {
  return module.functions.filter((fn) => nilFunctionMatches(fn, query) || fn.instructions.some((instruction) => nilInstructionMatches(instruction, query)));
}

export function nilMatchingInstructions(fn: NyInspectedFunction, query: string): NyInspectedInstruction[] {
  return nilFunctionMatches(fn, query) ? fn.instructions : fn.instructions.filter((instruction) => nilInstructionMatches(instruction, query));
}

export function nilSourceFiles(module: NyModuleInspection) {
  const files = new Map<string, { path: string; workspacePath?: string; line: number; instructionCount: number }>();
  for (const fn of module.functions) for (const instruction of fn.instructions) {
    const source = instruction.source;
    if (!source) continue;
    const key = source.workspacePath ?? source.path;
    const existing = files.get(key);
    if (existing) { existing.instructionCount++; existing.line = Math.min(existing.line, source.line); }
    else files.set(key, { ...source, instructionCount: 1 });
  }
  return [...files.values()];
}

export function nilByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Keep large constants bounded in the DOM while showing the part the user searched for. */
export function nilValuePreview(value: string, query: string, limit = 512): string {
  if (value.length <= limit) return value;
  const match = normalized(query) ? value.toLocaleLowerCase().indexOf(normalized(query)) : -1;
  const start = Math.max(0, match - Math.floor(limit / 3));
  const end = Math.min(value.length, start + limit);
  return `${start ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}
