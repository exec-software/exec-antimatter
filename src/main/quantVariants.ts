import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { QuantVariant } from '../api/modelRuntimeProfiles';

/**
 * What quantizations of one model are actually on this disk.
 *
 * The Library used to carry `quantization` as free text, which made a second quant of the same
 * model a second model entry — two cards, two sources, two ports, one checkpoint. This module is
 * the other half of collapsing those back into one entry: given the directory a model lives in,
 * report the quantizations present so the card can offer them.
 *
 * Discovery reads the filesystem and never the model card, for the same reason the provenance
 * notes record hashes rather than quoting a README: what is on the disk is the only thing that
 * can be served.
 *
 * The layouts here are not uniform, and all of these are real on this machine:
 *
 *   openmythos-27b/Q6_K/OpenMythos-27B-Q6_K.gguf          quant-named directory
 *   openmythos-27b/BF16/*.safetensors                      no GGUF at all — a training base
 *   qwen3-omni-30b/Qwen3-Omni-...-Q8_0.gguf                flat, beside its projector
 *   qwen3-coder-next/Qwen3-Coder-Next-Q4_K_M/...-00001-of-00004.gguf
 *                                                          directory name is NOT a bare quant
 *   glm-5.3-ud-q2_k_xl/UD-Q2_K_XL/GLM-5.3-...-00001-of-00007.gguf
 *
 * So the quant is parsed from the file name first and the directory name only as a fallback. A
 * directory holding safetensors and no GGUF yields nothing, which is correct: it cannot be served.
 */

export type { QuantVariant } from '../api/modelRuntimeProfiles';

/**
 * Files that sit beside a model and are not one. Passing any of these as `-m` either fails or,
 * worse, half-works: `mmproj` is a projector, `mtp` a speculation head, `dflash` a side model,
 * `imatrix` calibration data. All four are real file prefixes in the repositories used here.
 */
const COMPANION = /^(?:mmproj|imatrix|dflash|mtp|draft)[-_.]/i;

/**
 * Quantization labels, longest-plausible-match first.
 *
 * `I?Q[1-8](?:_[A-Z0-9]+){0,3}` deliberately requires a digit immediately after the Q so that
 * `Qwen3` is not read as a quantization. `UD-` is Unsloth's dynamic prefix and belongs to the
 * label: `UD-Q2_K_XL` and `Q2_K_XL` are different files.
 */
const QUANT = /(?:^|[-_.])((?:UD-)?I?Q[1-8](?:_[A-Z0-9]+){0,3}|BF16|F32|F16|MXFP4|NVFP4)(?=[-_.]|$)/gi;

/** `-00001-of-00007` before the extension. */
const SHARD = /[-_.](\d{3,5})-of-(\d{3,5})$/;

/** The quantization a GGUF's name declares, or null. The LAST match wins: names put the quant
 *  after the model name and before the shard suffix, and a model name may itself contain a
 *  digit-after-Q sequence. */
export function quantFromName(fileName: string): string | null {
  const stem = basename(fileName).replace(/\.gguf$/i, '').replace(SHARD, '');
  let found: string | null = null;
  for (const m of stem.matchAll(QUANT)) found = m[1];
  return found;
}

function shardOf(fileName: string): { index: number; total: number } | null {
  const stem = basename(fileName).replace(/\.gguf$/i, '');
  const m = SHARD.exec(stem);
  if (!m) return null;
  return { index: Number(m[1]), total: Number(m[2]) };
}

/** Key a split set by its name with the shard suffix removed, so shards group together. */
function setKey(path: string): string {
  return join(dirname(path), basename(path).replace(/\.gguf$/i, '').replace(SHARD, ''));
}

function ggufFilesUnder(root: string, depth: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;                         // a dangling link or a file removed mid-scan
    }
    if (st.isDirectory()) {
      if (depth > 0) out.push(...ggufFilesUnder(full, depth - 1));
    } else if (/\.gguf$/i.test(entry) && !COMPANION.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every servable quantization under `modelDir`, sorted by size ascending so the cheapest is
 * first. Shards are grouped: the returned `path` is shard 1 and `bytes` is the whole set.
 *
 * An incomplete split set is still reported, because hiding it would present a partial download
 * as an absent one. `shards` against the file count is how a caller can tell; `complete` is
 * deliberately not inferred here, since a missing middle shard and a still-running download look
 * identical on disk.
 */
export function discoverQuantVariants(modelDir: string, maxDepth = 2): QuantVariant[] {
  if (!modelDir || !isAbsolute(modelDir)) return [];
  const groups = new Map<string, { quant: string; first: string; bytes: number; shards: number }>();
  for (const file of ggufFilesUnder(modelDir, maxDepth)) {
    const quant = quantFromName(file) ?? quantFromDirectory(file, modelDir);
    if (!quant) continue;
    const key = setKey(file);
    const shard = shardOf(file);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        quant,
        first: !shard || shard.index === 1 ? file : '',
        bytes: size,
        shards: shard ? shard.total : 1,
      });
      continue;
    }
    existing.bytes += size;
    if (shard && shard.index === 1) existing.first = file;
  }
  const variants: QuantVariant[] = [];
  for (const g of groups.values()) {
    if (!g.first) continue;             // a set whose first shard is missing cannot be loaded
    variants.push({ quant: g.quant, path: g.first, bytes: g.bytes, shards: g.shards });
  }
  // Cheapest first, then by label, so the order is stable for a UI that lists them.
  return variants.sort((a, b) => a.bytes - b.bytes || a.quant.localeCompare(b.quant));
}

/** Fallback when the file name carries no quant: the nearest directory under `modelDir` that
 *  does. Covers a bare `Q6_K/model.gguf` layout without guessing from a model-named folder. */
function quantFromDirectory(file: string, modelDir: string): string | null {
  let dir = dirname(file);
  while (dir.startsWith(modelDir) && dir !== modelDir) {
    const name = basename(dir);
    QUANT.lastIndex = 0;
    const matches = [...name.matchAll(QUANT)];
    if (matches.length) return matches[matches.length - 1][1];
    dir = dirname(dir);
  }
  return null;
}

/**
 * The directory holding every quantization of the model whose weights are at `modelPath`.
 *
 * No new configuration is needed to find this: a service's own `-m` already says where its model
 * lives. Two layouts exist here and they need opposite answers, so the parent directory's name
 * decides. If it carries a quantization label it is one quant among siblings and the model root is
 * its parent; otherwise it is the model's own directory.
 *
 *   .../openmythos-27b/Q4_K/OpenMythos-27B-Q4_K.gguf  -> parent `Q4_K` is a quant
 *                                                        -> root `.../openmythos-27b`
 *   .../qwen3-omni-30b/Qwen3-Omni-...-Q8_0.gguf       -> parent is not a quant
 *                                                        -> root `.../qwen3-omni-30b`
 *
 * Getting that backwards is not a cosmetic error: treating a flat model's parent as a quant
 * directory would make the models root the search root and offer every model on the disk as a
 * quantization of this one.
 */
export function modelRootFor(modelPath: string): string | null {
  if (!modelPath || !isAbsolute(modelPath)) return null;
  const parent = dirname(modelPath);
  const grandparent = dirname(parent);
  if (grandparent === parent) return null;                 // the filesystem root is not a model
  return quantFromName(basename(parent)) ? grandparent : parent;
}
