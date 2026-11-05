/**
 * Checking that the model which answered is the model that was asked for.
 *
 * A server is not obliged to refuse an id it does not know. beholdd, asked for a model that is
 * not in its configuration, loads its `default: true` entry instead and answers normally — so a
 * conversation labelled MiMo can be written entirely by Nemotron, and every visible sign says
 * MiMo: the picker, the header, the carbon. The reply's own `model` field is the only place the
 * substitution shows, and until now nothing read it.
 *
 * The check has to be loose, because a correct answer routinely comes back under a different
 * string from the one that was sent. The same server resolves `mimo-v26-flash` to
 * `MiMo-V2.6-Flash-RL-MXFP4` and `nemotron-nano-4b` to `nemotron-nano-4b-q8`: a configuration id
 * on the way in, an engine alias on the way out. Both are the right model. What must be caught is
 * the case where the two names have nothing to do with each other.
 *
 * So: compare on letters and digits alone, and accept when either name contains the other. A
 * false alarm here is worse than a miss — it would put a warning on a turn that was fine, and a
 * warning people learn to ignore protects nobody.
 */

/** Letters and digits only, folded to lower case: `MiMo-V2.6-Flash-RL` becomes `mimov26flashrl`. */
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * beholdd v1 takes an absolute GGUF path as a model id, and answers under the checkpoint's name
 * rather than the path. Comparing the whole path would never match, so compare its file name.
 */
const identifying = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const tail = /[\\/]/.test(trimmed) ? (trimmed.split(/[\\/]/).pop() ?? trimmed) : trimmed;
  return normalize(tail.replace(/\.gguf$/i, ''));
};

/**
 * Below this, containment stops meaning anything: a two-character name is inside half the ids on
 * any server, and treating that as agreement would disable the check exactly where it is cheapest
 * to be wrong.
 */
const MIN_COMPARABLE = 3;

/**
 * Whether the server's answer came from the model that was requested.
 *
 * True when nothing can be decided — a server that sends no `model` field is not evidence of a
 * substitution, and neither is one whose id is too short to compare.
 */
export function modelsAgree(requested: string, served: string | undefined): boolean {
  if (!served) return true;
  const asked = identifying(requested);
  const answered = identifying(served);
  if (!asked || !answered) return true;
  if (asked.length < MIN_COMPARABLE || answered.length < MIN_COMPARABLE) return true;
  return asked.includes(answered) || answered.includes(asked);
}

/**
 * What the person is told when the two disagree, in both names, so the next step is obvious.
 *
 * Deliberately says the server chose it rather than that something failed: the turn did produce
 * an answer, and it may even be a good one. What it is not is the model on the label.
 */
export const substitutionWarning = (requested: string, served: string): string =>
  `This turn was answered by ${served}, not the selected ${requested}. ` +
  `The source did not recognise ${requested} and used its own default model instead. ` +
  `Check that ${requested} is configured on the source and can load — an answer from the wrong model is still an answer, ` +
  `so nothing else will report this.`;
