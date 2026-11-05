/** Personalization belongs to the main assistant; specialist agents retain their own briefs. */
export interface AssistantSettings {
  name: string;
  personality: string;
}

export const DEFAULT_ASSISTANT: Readonly<AssistantSettings> = Object.freeze({ name: 'Antimatter', personality: '' });
export const ASSISTANT_NAME_LIMIT = 60;
export const ASSISTANT_PERSONALITY_LIMIT = 4000;

export interface SetupState {
  assistant: AssistantSettings;
  completedAt: number | null;
  showOnStartup: boolean;
}

export interface SetupAPI {
  get(): Promise<SetupState>;
  updateAssistant(patch: Partial<AssistantSettings>): Promise<SetupState>;
  complete(): Promise<SetupState>;
  onChanged(callback: (state: SetupState) => void): () => void;
}

export function validateAssistantPatch(value: unknown): Partial<AssistantSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Assistant settings must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'name' && key !== 'personality')) throw new Error('Unknown assistant setting.');
  const patch: Partial<AssistantSettings> = {};
  if (Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > ASSISTANT_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(input.name)) {
      throw new Error(`Choose an assistant name between 1 and ${ASSISTANT_NAME_LIMIT} characters.`);
    }
    patch.name = input.name.trim();
  }
  if (Object.hasOwn(input, 'personality')) {
    if (typeof input.personality !== 'string' || input.personality.length > ASSISTANT_PERSONALITY_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.personality)) {
      throw new Error(`Keep the assistant personality under ${ASSISTANT_PERSONALITY_LIMIT} characters.`);
    }
    patch.personality = input.personality.replace(/\r\n/g, '\n').trim();
  }
  return patch;
}

/** A separate block keeps personal style distinct from tool policy and model capabilities. */
export function renderAssistantIdentity(settings: AssistantSettings): string {
  if (settings.name === DEFAULT_ASSISTANT.name && !settings.personality) return '';
  return `Your name is ${JSON.stringify(settings.name)}. You are the user's main assistant in Antimatter.` +
    (settings.personality ? `\nThe user has chosen this personality and working style for you:\n${settings.personality}` : '') +
    '\nThis identity does not change your available tools, permissions, or the role assigned to a specialist agent.';
}
