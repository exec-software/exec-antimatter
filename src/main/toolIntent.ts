/**
 * A deliberately narrow bridge between a person's wording and a required tool call. General
 * coding requests still leave tool choice to the model; an explicit request to use Bash or the
 * shell does not get to succeed as prose.
 */
export function explicitlyRequiredTool(text: string): string | undefined {
  const request = text.trim().toLowerCase();
  if (!request) return undefined;

  // Never turn a prohibition into execution during the corrective retry. This check precedes
  // every positive pattern on purpose: "do not call run_command" still contains its name.
  if (
    /\b(?:do\s+not|don't|dont|never|avoid|without|stop|refrain\s+from|not)\b(?:\s+[a-z]+){0,7}\s+(?:using|use|calling|call|running|run)?\s*(?:the\s+|your\s+)?(?:bash|shell|cli|terminal|run_command|open_path)\b/.test(
      request
    )
  ) {
    return undefined;
  }

  // Require an imperative/request clause, not a bare mention such as "this works with Bash".
  // A clause can begin the message or follow ordinary sentence punctuation.
  const clause =
    /(?:^|[.!?;,]\s*)(?:(?:okay|ok|and|then)\s*,?\s*)?(?:(?:(?:can|could|would|will)\s+you\s+(?:at\s+least\s+)?|(?:please|now)\s+|let['’]?s\s+|i\s+(?:need|want)\s+you\s+to\s+))?(?:use|call|invoke|run)\s+(?:the\s+|your\s+|available\s+)?(run_command|open_path|bash|shell|cli)\b/.exec(
      request
    );
  if (clause) {
    const named = clause[1];
    if (named === 'open_path') return 'open_path';
    if (
      named === 'cli' &&
      /\bopen\b[^?\n]*\b(?:document|file|folder|directory|desktop|editor|application|app)\b/.test(request.slice(clause.index))
    ) {
      return 'open_path';
    }
    return 'run_command';
  }

  if (/(?:^|[.!?;,]\s*)(?:please\s+|now\s+)(?:run_command|open_path)\b/.test(request)) {
    return request.match(/(?:run_command|open_path)\b/)?.[0];
  }
  if (/(?:^|[.!?;,]\s*)(?:(?:please|now)\s+)?(?:run|execute)\s+(?:a\s+|the\s+)?(?:bash|shell|terminal)\s+command\b/.test(request)) {
    return 'run_command';
  }

  return undefined;
}
