/** Host-owned workspace identity. Remembering a folder is separate from granting access to it. */
export interface ConversationWorkspaceBinding {
  path: string;
  confirmed: boolean;
}

export interface ConversationWorkspaceState extends ConversationWorkspaceBinding {
  available: boolean;
  reason?: string;
}
