export type AgentProviderId = 'cursor_sdk' | 'claude_code';

export type AgentCenterSelection = {
  providerId: AgentProviderId;
  workspaceId: string;
  modelId: string;
};

/**
 * Non-secret in-Lens Agent Center selection state.
 * Credentials remain on the paired Mac bridge.
 */
export class AgentCenterStateStore {
  private static selectionByProvider: Record<string, AgentCenterSelection> = {
    cursor_sdk: {
      providerId: 'cursor_sdk',
      workspaceId: '',
      modelId: 'auto',
    },
    claude_code: {
      providerId: 'claude_code',
      workspaceId: '',
      modelId: 'auto',
    },
  };

  public static get(providerId: string): AgentCenterSelection {
    const normalized = this.normalizeProvider(providerId);
    const selection = this.selectionByProvider[normalized];
    return {
      providerId: normalized,
      workspaceId: selection.workspaceId,
      modelId: selection.modelId,
    };
  }

  public static setWorkspace(providerId: string, workspaceId: string): void {
    const normalized = this.normalizeProvider(providerId);
    this.selectionByProvider[normalized].workspaceId = String(workspaceId || '').trim();
  }

  public static setModel(providerId: string, modelId: string): void {
    const normalized = this.normalizeProvider(providerId);
    this.selectionByProvider[normalized].modelId =
      String(modelId || '').trim() || 'auto';
  }

  private static normalizeProvider(providerId: string): AgentProviderId {
    return String(providerId || '').trim().toLowerCase() === 'claude_code'
      ? 'claude_code'
      : 'cursor_sdk';
  }
}
