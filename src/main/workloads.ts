import { isAbsolute } from 'node:path';
import type { Workload, WorkloadFile, WorkloadView } from '../api/workloads';
import type { DownloadManager } from './hub/downloads';

/** Source and hashes are reviewed catalog data, never renderer-supplied download paths. */
export const WORKLOADS: readonly Workload[] = [
  {
    id: 'qwen3-coder-30b-q8', name: 'Qwen3-Coder 30B',
    description: 'A practical starting point for local coding, editing, and tools. The same Q8 checkpoint as the Antimatter installer.',
    engine: 'llama.cpp Vulkan',
    hardware: '30.25 GiB download. GPU offload adapts to available memory; leave room for the OS and context. A 16–24 GiB GPU uses CPU spill.',
    evidence: 'Existing Antimatter installer and Beholdd serving gates cover this exact checkpoint. Performance depends on hardware; this is not a new benchmark.',
    evidenceRefs: ['releases/model-manifest.json', 'releases/linux-x86_64/beholdd.streaming.yaml', 'https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct'],
    repoId: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF', revision: 'e9eb3e611bdcd5842e021c014b392c70746da574',
    variantKey: 'Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf', quantization: 'Q8_0',
    files: [{ path: 'Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf', size: 32483934528, sha256: 'a4a0207f4653bfece73d9818c83acf714f5593525fe3aab7026347fd73090fcc' }],
    contextTokens: 32768, maxOutputTokens: 8192, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'qwen3-omni-30b-q8', name: 'Qwen3-Omni 30B',
    description: 'The 30B perception workload: reads screenshots and hears recordings on the loopback. Pair it with a coder; it is not the better coder itself.',
    engine: 'llama.cpp Vulkan',
    hardware: '31.49 GiB download, weights plus projector. Recorded on a 96 GiB GPU allocation; GPU offload adapts to available memory and spills to CPU on smaller cards.',
    evidence: 'Revision, both file sizes, and both SHA-256 identities are the ones recorded from the downloaded files on the verified box. The projector declares both a vision and an audio encoder, and the pinned b11223 Vulkan build carries the qwen3vlmoe, qwen3vl_merger, and qwen3a symbols it needs. Serving its media roles is what was checked; it publishes no agentic coding result.',
    evidenceRefs: ['docs/model-provenance/qwen3-omni.md', 'src/main/agents/profiles.ts', 'https://huggingface.co/ggml-org/Qwen3-Omni-30B-A3B-Thinking-GGUF/tree/6807f126832efa5bce2969fec85a80594e21df9d'],
    repoId: 'ggml-org/Qwen3-Omni-30B-A3B-Thinking-GGUF', revision: '6807f126832efa5bce2969fec85a80594e21df9d',
    variantKey: 'Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', quantization: 'Q8_0',
    files: [{ path: 'Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', size: 32484493632, sha256: 'a146426ed58329962e3f9b582123d1e06dad64cb2454728d7be883bc7a5658c7' }],
    projector: { variantKey: 'mmproj-Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', file: {
      path: 'mmproj-Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', size: 1325020224,
      sha256: '2bd5459571f8230a0c251d3d0dd36267753f0800ed145449a34f220a31f93898',
    } },
    modalities: ['images', 'audio'],
    // The checkpoint declares 65,536 tokens. Serving a larger window than the weights were
    // converted for is what the provenance note warns against, so the preset pins the real one.
    contextTokens: 65536, maxOutputTokens: 8192, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'qwen3-coder-next-80b-q4', name: 'Qwen3-Coder-Next 80B',
    description: 'The agentic coder for a single large GPU: 80B total but 3B active, trained to 262,144 tokens. Its hybrid layers make a full window and a wide subagent pool affordable at the same time.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '45.09 GiB download. Only 12 of the 48 blocks hold a KV cache — 2 KV heads at head dimension 256, so 24 KiB/token at f16 against Qwen3-Coder 30B’s 96 — and 262,144 tokens cost 6 GiB of cache rather than 24. Measured on the recorded 96 GiB allocation: 52.4 GiB for one full-window slot, 55.6 GiB for six 65,536-token slots, either of which fits beside the resident Omni server. GPU offload adapts, and 3B active parameters keep CPU spill cheap on a smaller card.',
    evidence: 'Revision, all four file sizes and all four SHA-256 identities are the ones Hugging Face publishes for this revision, and the downloaded files were verified against them on this box. Served on hardware: all three modes load on the pinned b11223 Vulkan build, generate coherently, and return real tool_calls finishes rather than prose. A 130,007-token prompt with a planted constant at 8% depth was answered correctly, and six concurrent slots were measured delivering 93.8 tok/s against 57.8 for one stream. Figures are from this one 96 GiB box; they are a record of what was observed, not a published benchmark.',
    evidenceRefs: ['docs/model-provenance/qwen3-coder-next.md', 'https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF/tree/b82fb7382639d97b38fa7672e526c760c2fb358e/Qwen3-Coder-Next-Q4_K_M'],
    repoId: 'Qwen/Qwen3-Coder-Next-GGUF', revision: 'b82fb7382639d97b38fa7672e526c760c2fb358e',
    variantKey: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M', quantization: 'Q4_K_M',
    files: [
      { path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf', size: 15524827040, sha256: '6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da' },
      { path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf', size: 14872168352, sha256: '817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3' },
      { path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf', size: 14503294496, sha256: '23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f' },
      { path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf', size: 3510702144, sha256: '249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b' },
    ],
    // 262,144 is the checkpoint's own native window, which the Qwen card states and the preset
    // pins. Past it is YaRN scaling, and the card validates that only to 131,072 — so a larger
    // served window would be a promise this catalog has no evidence for.
    contextTokens: 262144, maxOutputTokens: 32768, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'mistral-small-4-119b-q4', name: 'Mistral Small 4 119B',
    description: 'Mistral’s 119B MoE generalist with a compressed MLA cache. Requires the local F32 Vulkan repair for fast expert computation; the unpatched bundled runtime falls back to CPU.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '67.65 GiB download. MLA keeps the cache unusually cheap for the size: 36 blocks with 1 KV head caching a 320-wide latent (kv_lora_rank 256 plus 64 rope dims), against Devstral 2’s 352 KiB/token on the same box. On the recorded 96 GiB allocation the weights leave roughly 28 GiB for cache and compute buffers, which the served 131,072-token window does not come close to exhausting — the window, not VRAM, is the binding limit here.',
    evidence: 'The pinned download identities were verified when installed. On 2026-10-11, a local b11223 F32 Vulkan repair passed 44 GPU numerical cases and moved all 36 expert down-projections to the Radeon GPU. A cold 128-token prompt with four output tokens completed in 1.20 seconds; a streaming arithmetic chat began replying in 0.78 seconds. The unpatched bundled runtime retains the CPU fallback. This qualifies short-context serving on the tested host; the 131,072-token window still needs retrieval and quality validation. See the repair note and reproducible build recipe.',
    evidenceRefs: ['docs/model-provenance/mistral-small-4.md', 'https://huggingface.co/bartowski/mistralai_Mistral-Small-4-119B-2603-GGUF/tree/f569d04efea9546de10ec040819908fa4e8f1c92/mistralai_Mistral-Small-4-119B-2603-Q4_K_M'],
    repoId: 'bartowski/mistralai_Mistral-Small-4-119B-2603-GGUF', revision: 'f569d04efea9546de10ec040819908fa4e8f1c92',
    variantKey: 'mistralai_Mistral-Small-4-119B-2603-Q4_K_M/mistralai_Mistral-Small-4-119B-2603-Q4_K_M', quantization: 'Q4_K_M',
    files: [
      { path: 'mistralai_Mistral-Small-4-119B-2603-Q4_K_M/mistralai_Mistral-Small-4-119B-2603-Q4_K_M-00001-of-00002.gguf', size: 39189441344, sha256: '2d80b2d3e2f330200b68b8ec9290127a45eb1967067b6322ba49abd402e12f47' },
      { path: 'mistralai_Mistral-Small-4-119B-2603-Q4_K_M/mistralai_Mistral-Small-4-119B-2603-Q4_K_M-00002-of-00002.gguf', size: 33447330432, sha256: 'c3c4e0851f33aa7768e6845cfdfcbcce6f44448c5781e26e20235eab2fc972da' },
    ],
    contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'devstral-2-123b-q4', name: 'Devstral 2 123B',
    description: 'Mistral’s coder at the 123B scale, and the fair comparison against Qwen3-Coder-Next 80B. Dense, so every parameter is active on every token — one slot, no subagent pool.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '69.75 GiB download, dense. The cache is the most expensive on this box: 88 blocks × 8 KV heads × (128 + 128) × 2 bytes = 352 KiB/token at f16, which is 14.7× Qwen3-Coder-Next’s 24 and 3.7× Qwen3-Coder 30B’s 96. On the recorded 96 GiB allocation that affords one 32,768-token slot at f16 (11.0 GiB of cache, 82.25 GiB in total) or 65,536 with a q8_0 cache for the same VRAM. There is no pool mode at any setting, so subagents serialize against the single slot.',
    evidence: 'Revision, both file sizes and both SHA-256 identities are the ones Hugging Face publishes for this revision, and the downloaded files were verified against them on this box. The KV arithmetic above is derived from the checkpoint’s own GGUF metadata rather than estimated. The file declares llama.context_length = 262,144 via YaRN from a 4,096 original_context_length at factor 64, but VRAM binds far below that ceiling on one 96 GiB card, so the served window is set from the measured budget and not from the card.',
    evidenceRefs: ['docs/model-provenance/devstral-2.md', 'https://huggingface.co/bartowski/mistralai_Devstral-2-123B-Instruct-2512-GGUF/tree/19239829ba3b52ef2f05c99db3cc73486fda768b/mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M'],
    repoId: 'bartowski/mistralai_Devstral-2-123B-Instruct-2512-GGUF', revision: '19239829ba3b52ef2f05c99db3cc73486fda768b',
    variantKey: 'mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M/mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M', quantization: 'Q4_K_M',
    files: [
      { path: 'mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M/mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M-00001-of-00002.gguf', size: 39925785920, sha256: 'e42aeda9772d7b779e1b675d7d16de42af169593f2deccdc542424816a2f421d' },
      { path: 'mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M/mistralai_Devstral-2-123B-Instruct-2512-Q4_K_M-00002-of-00002.gguf', size: 34971867392, sha256: 'e3a596050861f0683c29a8aff4f458339dd3e8c641eb99fea9efc534bad72f94' },
    ],
    contextTokens: 32768, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'deepseek-v4-flash-0731-q2', name: 'DeepSeek V4 Flash 0731',
    description: 'The established single large GPU generalist, using the UD-Q2_K_XL checkpoint.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '90.18 GiB download. The recorded setup uses a 96 GiB GPU memory allocation, 131,072 context tokens, and one slot. Smaller machines need another setup.',
    evidence: 'Pinned files match the local DeepSeek download metadata; runtime settings match the existing llama-deepseek service and one-box orchestration profile. No new inference benchmark was run.',
    evidenceRefs: ['src/main/agents/profiles.ts', 'https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/tree/fbbb5b93fb787c21338159b0af3318bb3f4d9768/UD-Q2_K_XL'],
    repoId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF', revision: 'fbbb5b93fb787c21338159b0af3318bb3f4d9768',
    variantKey: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL', quantization: 'UD-Q2_K_XL',
    files: [
      { path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00001-of-00003.gguf', size: 5257664, sha256: 'de65c5bb660817b95cc281bf54935f9d1bcc3b22535f2eae63b35a14c7c5724b' },
      { path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00002-of-00003.gguf', size: 49437013568, sha256: 'c8728a298862cd8736782e2e4056e5e3e03c415ba552a38173264494e41ef327' },
      { path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00003-of-00003.gguf', size: 47390237120, sha256: 'a4bae0788c025c1b2388754592c98fefa1372981748ac9875039bf6a30e6eeb4' },
    ],
    contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'laguna-s-21-118b-iq4', name: 'Laguna S 2.1 118B',
    description: 'poolside’s 118B-A8B agentic coder. The first model on this box to write an end-to-end Matrix application that runs — a language no model has training data for — and it does it at a usable speed.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '53.6 GiB download over three shards; the first is 3.5 MiB of metadata only, which is why the listing looks lopsided. The cache is cheap for the size because only one attention block in four is global: 48 blocks with head_count_kv 8 and k/v length 128, and a head_count array of [48, 72, 72, 72] repeating, so the 12 global blocks grow at 4 KiB/block/token = 48 KiB/token while the 36 sliding-window blocks stay fixed at roughly 72 MiB. 262,144 tokens would cost 12.0 GiB at f16 or 6.0 GiB at q8_0. On the recorded 96 GiB allocation it is served at 131,072 tokens with a q8_0 cache; weights plus headroom exceed what the Vulkan heap reports, so Beholdd places the dense trunk on the GPU and spills the experts to CPU — slower, identical output, and affordable because only 3.9% of experts are active per token.',
    evidence: 'All three file sizes and all three SHA-256 identities were taken from the downloaded files on this box and independently confirmed against what Hugging Face publishes for this revision; the two agree exactly. The `laguna` architecture is compiled into the pinned b11223 Vulkan runtime this app already ships — `laguna`, `laguna.cpp` and a Laguna-specific attention-gate diagnostic are all present in its symbols — so no engine work or extra backend was needed, and that was verified before the 53.6 GiB was spent. Served on hardware: it produced a working end-to-end Matrix application at roughly 18 tok/s with the expert spill above, in a session of about 456 tool calls. That is one observation on one 96 GiB box, not a benchmark, and poolside’s own published scores are not reproduced here. The quant rung was chosen from the ladder — 37.0 (UD-Q2_K_XL) / 50.3 (UD-Q3_K_M) / 53.6 (UD-IQ4_XS) / 68.4 (UD-Q4_K_XL) GiB — because 68.4 fits the carve-out with nothing left for cache while IQ4_XS leaves roughly 25 GiB clear.',
    evidenceRefs: ['docs/model-provenance/laguna-s-2.1.md', 'https://huggingface.co/unsloth/Laguna-S-2.1-GGUF/tree/750f92f90cf54159c4d7a610cb7b3e74498e75c6/UD-IQ4_XS'],
    repoId: 'unsloth/Laguna-S-2.1-GGUF', revision: '750f92f90cf54159c4d7a610cb7b3e74498e75c6',
    variantKey: 'UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS', quantization: 'UD-IQ4_XS',
    files: [
      { path: 'UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00001-of-00003.gguf', size: 3683648, sha256: 'a6378c893a836ee2649fbb24d60e3e9489313bd873fa53c7ffeb814466fe8867' },
      { path: 'UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00002-of-00003.gguf', size: 49820135904, sha256: 'd9d8482e132457db41c8407958bc478dbc4f1389c53e55ae8a8fd48a478142c2' },
      { path: 'UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00003-of-00003.gguf', size: 7742884768, sha256: '6fde44340ca9be41cddc86661acce1518cbaf08875f0daa6e393b62228b59dbd' },
    ],
    // 131,072 is what the recorded box serves and what the preset must therefore budget for. The
    // checkpoint reaches 262,144 by YaRN factor 32 from an 8,192 original, so a larger window is
    // available but is not what was measured here.
    contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, requiresPeers: false,
  },
  {
    id: 'mimo-v26-flash-mxfp4', name: 'MiMo V2.6 Flash RL',
    description: 'The large reasoning workload used across multiple machines. Download the exact MXFP4 file set, then connect the GPU peers for your setup.',
    engine: 'llama.cpp Vulkan with matching RPC peers',
    hardware: '155.87 GiB download. Requires combined memory beyond one 96 GiB GPU; configure your own peers. All peers must run the same llama.cpp build.',
    evidence: 'Existing Antimatter session measurements informed the reply and tool-batch limits. Beholdd’s independent decode gate compared this filename/quantization with a two-machine llama.cpp run; native Beholdd serving is not claimed.',
    evidenceRefs: ['src/main/modelProfiles.ts', 'src/main/recipes.ts', 'https://huggingface.co/ggml-org/MiMo-V2.6-Flash-RL-GGUF/tree/a5d1269fdcf9c3346934411f700038e9cd9d5102'],
    repoId: 'ggml-org/MiMo-V2.6-Flash-RL-GGUF', revision: 'a5d1269fdcf9c3346934411f700038e9cd9d5102',
    variantKey: 'MiMo-V2.6-Flash-RL-MXFP4', quantization: 'MXFP4',
    files: [
      { path: 'MiMo-V2.6-Flash-RL-MXFP4-00001-of-00002.gguf', size: 5948640, sha256: 'a34f63df32086bba7a14aa8a2f6c2f111f6e626ad7b10be18957e42d14d84738' },
      { path: 'MiMo-V2.6-Flash-RL-MXFP4-00002-of-00002.gguf', size: 167363516512, sha256: '10b74ff85577de18b336718c19905a50bcbccfee9cae7b9edd446667084f623c' },
    ],
    contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, requiresPeers: true,
  },
];

/** Weights and projector together: what a complete, verified workload has on disk. */
export const workloadFiles = (workload: Workload): WorkloadFile[] =>
  workload.projector ? [...workload.files, workload.projector.file] : [...workload.files];

export const workloadBytes = (workload: Workload): number =>
  workloadFiles(workload).reduce((sum, file) => sum + file.size, 0);

export function workloadById(value: unknown): Workload {
  const workload = typeof value === 'string' ? WORKLOADS.find((entry) => entry.id === value) : undefined;
  if (!workload) throw new Error('Choose a workload from the catalog.');
  return structuredClone(workload);
}

/** Order matters: the weakest state of the parts is the state of the whole. */
const STATES = ['failed', 'paused', 'queued', 'downloading', 'ready'] as const;

export function listWorkloads(downloads: Pick<DownloadManager, 'list'>): WorkloadView[] {
  const records = downloads.list();
  return WORKLOADS.map((source) => {
    const workload = structuredClone(source);
    const keys = [workload.variantKey, ...(workload.projector ? [workload.projector.variantKey] : [])];
    const matched = keys.map((key) => records.find((item) => item.repoId === workload.repoId &&
      item.revision === workload.revision && item.variantKey === key));
    const present = matched.filter((record): record is NonNullable<typeof record> => record !== undefined);
    // A projector workload is only as ready as its weakest part. Report nothing until at least
    // one part is queued, and never report `ready` while the other file is still missing.
    const download = present.length === 0 ? null : {
      id: present[0].id,
      state: present.length === keys.length
        ? STATES[Math.min(...present.map((record) => STATES.indexOf(record.state)))]
        : 'downloading' as const,
      bytesDone: present.reduce((sum, record) => sum + record.bytesDone, 0),
      error: present.find((record) => record.error)?.error ?? null,
      path: present[0].path,
    };
    return { ...workload, bytes: workloadBytes(workload), download };
  });
}

/**
 * Uses the same resumable, SHA-256-verified transfer queue as Discover. No inference starts.
 * A projector is its own queue record, matching how the hub groups an `mmproj` file, so it
 * resumes and verifies independently of the weights it belongs to.
 */
export function downloadWorkload(downloads: Pick<DownloadManager, 'enqueue' | 'list'>, id: unknown): WorkloadView[] {
  const workload = workloadById(id);
  downloads.enqueue({ repoId: workload.repoId, revision: workload.revision, variant: {
    key: workload.variantKey, label: workload.quantization, quant: workload.quantization,
    files: workload.files, bytes: workload.files.reduce((sum, file) => sum + file.size, 0),
    shards: workload.files.length, role: 'model', complete: true,
  } });
  if (workload.projector) {
    downloads.enqueue({ repoId: workload.repoId, revision: workload.revision, variant: {
      key: workload.projector.variantKey, label: `mmproj ${workload.quantization}`, quant: workload.quantization,
      files: [workload.projector.file], bytes: workload.projector.file.size,
      shards: 1, role: 'projector', complete: true,
    } });
  }
  return listWorkloads(downloads);
}

/**
 * Workloads whose weights may be split with the CPU rather than refused.
 *
 * Every one of these is a 3B-active MoE, which is the whole reason: a block left on the CPU
 * costs a fraction of what it would on a dense model of the same size, so a card too small for
 * the weights still serves. The big dense-ish checkpoints get `n-gpu-layers = 999` instead,
 * because a partial offload of those is not a slower answer but an unusable one.
 */
const ADAPTIVE_FIT = new Set(['qwen3-coder-30b-q8', 'qwen3-omni-30b-q8', 'qwen3-coder-next-80b-q4']);

/** Only trusted catalog values become options; paths and RPC targets cannot inject INI fields. */
export function renderWorkloadPreset(id: unknown, modelPath: string, peers: string[] = [], projectorPath?: string): string {
  const workload = workloadById(id);
  if (!isAbsolute(modelPath) || /[\u0000-\u001f\u007f]/.test(modelPath)) throw new Error('Choose an absolute model path.');
  // A projector path is held to the same rule as the model path, and a workload that has no
  // projector may not be given one: an unexpected `mmproj` is a caller mistake, not an option.
  if (workload.projector) {
    if (projectorPath === undefined) throw new Error('This workload needs its projector file path.');
    if (!isAbsolute(projectorPath) || /[\u0000-\u001f\u007f]/.test(projectorPath)) throw new Error('Choose an absolute projector path.');
  } else if (projectorPath !== undefined) {
    throw new Error('This workload has no projector file.');
  }
  if (!Array.isArray(peers) || peers.length > 8 || peers.some((peer) => typeof peer !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(peer) || Number(peer.slice(peer.lastIndexOf(':') + 1)) < 1 || Number(peer.slice(peer.lastIndexOf(':') + 1)) > 65535)) {
    throw new Error('RPC peers must be host:port addresses.');
  }
  if (workload.requiresPeers && peers.length === 0) throw new Error('MiMo needs configured RPC peers for this workload.');
  return [`[${workload.id}]`, `model = ${modelPath}`,
    ...(projectorPath ? [`mmproj = ${projectorPath}`] : []),
    `ctx-size = ${workload.contextTokens}`, 'parallel = 1',
    'load-on-startup = false', ...(peers.length ? [`rpc = ${peers.join(',')}`] : []),
    // Match the configured context floor to the profile; auto-fit may lower GPU offload,
    // but cannot silently give a smaller window than the prompt builder budgets for.
    `fit-ctx = ${workload.contextTokens}`,
    // An explicit device list excludes every unlisted device, including RPC GPUs. Let
    // llama.cpp discover local and remote devices when peers are configured.
    // The sparse workloads fit adaptively so a smaller card can spill to CPU rather than fail
    // outright: 3B active parameters make a partial offload slow rather than useless. The large
    // checkpoints are only ever run on memory sized for them.
    ...(ADAPTIVE_FIT.has(workload.id)
      ? ['fit = on', ...(peers.length === 0 ? ['device = Vulkan0'] : [])]
      : ['n-gpu-layers = 999']), '',
  ].join('\n');
}
