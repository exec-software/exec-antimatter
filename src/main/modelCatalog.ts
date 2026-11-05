import type { Model, ModelDeclaration, ModelMetadataPatch } from '../api/types';
import type { InferenceSource } from './sourceStore';
import { isModelDeployment } from '../api/modelDeployment';

const MAX_TEXT = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required.`);
  if (clean.length > MAX_TEXT) throw new Error(`${label} must be ${MAX_TEXT} characters or fewer.`);
  if (CONTROL_CHARACTERS.test(clean)) throw new Error(`${label} cannot contain control characters.`);
  return clean;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, label);
}

function contextWindow(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Context window must be a positive whole number.');
  }
  return value;
}

function vision(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error('Vision must be yes, no, or unknown.');
  return value;
}

function metadata(input: ModelDeclaration | ModelMetadataPatch, fallbackName?: string): Omit<Model, 'id' | 'manuallyDeclared'> {
  const name = requiredText(input.name ?? fallbackName, 'Display name');
  const architecture = optionalText(input.architecture, 'Architecture');
  const quantization = optionalText(input.quantization, 'Quantization');
  const context = contextWindow(input.contextWindow);
  const seesImages = vision(input.vision);
  if (input.deployment !== undefined && input.deployment !== null && !isModelDeployment(input.deployment)) {
    throw new Error('Model category must be Local, Distributed, or Provider.');
  }
  return {
    name,
    ...(architecture ? { architecture } : {}),
    ...(quantization ? { quantization } : {}),
    ...(context !== undefined ? { contextWindow: context } : {}),
    ...(seesImages !== undefined ? { vision: seesImages } : {}),
    ...(input.deployment ? { deployment: input.deployment } : {}),
  };
}

/** Add one explicit model without letting renderer input replace the source or its credential. */
export function declareModel(source: InferenceSource, input: ModelDeclaration): InferenceSource {
  const id = requiredText(input.id, 'Model id');
  if (source.models.some((model) => model.id === id)) {
    throw new Error(`Model "${id}" is already declared on ${source.name}.`);
  }
  const model: Model = {
    id,
    ...metadata(input, id),
    manuallyDeclared: true,
    ...(input.contextWindow !== undefined ? { contextWindowCurated: true } : {}),
    ...(input.vision !== undefined ? { visionCurated: true } : {}),
  };
  return { ...source, models: [...source.models, model] };
}

/** Edit only durable model metadata. Source identity, credentials, and model id stay immutable. */
export function updateModelMetadata(
  source: InferenceSource,
  modelId: string,
  patch: ModelMetadataPatch
): InferenceSource {
  const id = requiredText(modelId, 'Model id');
  const index = source.models.findIndex((model) => model.id === id);
  if (index === -1) throw new Error(`Model "${id}" is not configured on ${source.name}.`);
  const current = source.models[index];
  if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean') throw new Error('Hidden must be true or false.');
  // This is a patch contract even though today's Library form submits every field. An omitted
  // optional field must not erase a value (or its provenance) when another caller changes only
  // the display name. `null` remains the deliberate way to clear an optional value.
  const nextMetadata = metadata({
    ...patch,
    architecture: patch.architecture === undefined ? current.architecture : patch.architecture,
    quantization: patch.quantization === undefined ? current.quantization : patch.quantization,
    contextWindow: patch.contextWindow === undefined ? current.contextWindow : patch.contextWindow,
    vision: patch.vision === undefined ? current.vision : patch.vision,
    deployment: patch.deployment === undefined ? current.deployment : patch.deployment,
  });
  const next: Model = {
    id: current.id,
    ...nextMetadata,
    // This is observed runtime capacity, never an editable Library preference.
    ...(current.maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens: current.maxEvaluatedTokens } : {}),
    ...(current.manuallyDeclared ? { manuallyDeclared: true } : {}),
    ...(current.nameCurated || patch.name.trim() !== current.name ? { nameCurated: true } : {}),
    ...((patch.hidden ?? current.hidden) !== undefined ? { hidden: patch.hidden ?? current.hidden } : {}),
    // `null` is an explicit Library choice too: it means keep this fact unknown rather than
    // silently restoring the next value reported by the source.
    ...(current.contextWindowCurated || patch.contextWindow !== undefined ? { contextWindowCurated: true } : {}),
    ...(current.visionCurated || patch.vision !== undefined ? { visionCurated: true } : {}),
  };
  return {
    ...source,
    models: [...source.models.slice(0, index), next, ...source.models.slice(index + 1)],
  };
}

/** Only an explicitly declared entry may be removed through the model library. */
export function removeDeclaredModel(source: InferenceSource, modelId: string): InferenceSource {
  const id = requiredText(modelId, 'Model id');
  const model = source.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Model "${id}" is not configured on ${source.name}.`);
  if (!model.manuallyDeclared) {
    throw new Error(`Model "${id}" is managed by its source and cannot be removed here.`);
  }
  return { ...source, models: source.models.filter((candidate) => candidate.id !== id) };
}
