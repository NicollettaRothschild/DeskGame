import {
  isIgnorableUtterance,
  looksLikeAssistantEcho,
  looksLikeIncompleteAgentPrompt,
  looksLikePossibleAgentWake,
  normalizeAsrTranscript,
  parseArvisWakePhrase,
} from './ArvisWakePhrase';
import { isImageQuery } from './ArvisImageSkill';
import { isMeshQuery } from './ArvisMeshSkill';
import { isMusicQuery } from './ArvisMusicSkill';
import { isArvisCalendarQuery } from './ArvisCalendarIntent';
import { isArvisEmailDraftQuery } from './ArvisEmailDraftIntent';
import { isNewsIntentQuery } from './ArvisNewsSkill';
import {
  getSharedArvisAgentChat,
  getSharedCodingBuddy,
  getSharedFlowGardenTts,
  getSharedFriendGrab,
  getSharedSpeechRecognition,
} from './FlowGardenServiceRegistry';
import { looksLikeWorkspaceResetCommand } from './FriendGrab';
import { PlantLifecycle } from './PlantLifecycle';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';

type SpacePanelLike = {
  refreshPanel?: () => void;
  appendNote?: (text: string, onDone?: (ok: boolean) => void) => void;
  showPanel?: () => void;
  nextItem?: () => void;
  previousItem?: () => void;
  showAgentCenter?: (tab?: 'agents' | 'chats' | 'settings') => void;
  getAgentCenterState?: () => {
    provider: string;
    repository: string;
    model: string;
  };
  showAgentPairing?: (pairingUrl?: string, pairingCode?: string) => void;
  showAgentCenterDemo?: (summary?: string, detail?: string) => void;
  showAgentProviderSelection?: (providers: string[], selected?: string) => void;
  showAgentRepositorySelection?: (repositories: string[], selected?: string) => void;
  showAgentModelSelection?: (models: string[], selected?: string) => void;
};

type SpawnSourceLike = {
  spawnPotAtSource?: () => SceneObject | null;
};

@component
export class FlowGardenVoiceCommands extends BaseScriptComponent {
  private static readonly POLL_INTERVAL_SEC = 0.15;

  @input
  @allowUndefined
  speechRecognition!: SpeechRecognition;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  potSource!: ScriptComponent;

  @input
  @allowUndefined
  statusText!: Text;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  debugLogging: boolean = false;

  private lastPollUtterance = '';
  private lastPollUtteranceAt = 0;
  private wiringLogged = false;
  private nextPollAt = 0;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.resolveDependencies());
    this.createEvent('UpdateEvent').bind(() => this.pollTranscript());
  }

  private resolveDependencies(): void {
    if (isNull(this.speechRecognition)) {
      this.speechRecognition = getSharedSpeechRecognition();
    }
    if (this.debugLogging && !this.wiringLogged) {
      this.wiringLogged = true;
      print(
        `[VoiceCommands] ready speech=${!isNull(this.speechRecognition)} debug=${this.debugLogging}`
      );
    }
  }

  private pollTranscript(): void {
    const now = getTime();
    if (now < this.nextPollAt) {
      return;
    }
    this.nextPollAt = now + FlowGardenVoiceCommands.POLL_INTERVAL_SEC;

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      return;
    }

    if (this.speechRecognition.isAgentSessionActive()) {
      return;
    }

    const agent = getSharedArvisAgentChat();
    if (!isNull(agent) && agent.isBusy()) {
      return;
    }

    if (this.speechRecognition.isSuppressingVoiceCommands()) {
      return;
    }

    if (this.speechRecognition.isPostItCaptureActive()) {
      return;
    }

    const tts = getSharedFlowGardenTts();
    if (!isNull(tts) && (tts.isBlockingVoiceCommands() || tts.isSpeaking())) {
      return;
    }

    const finalText = normalizeAsrTranscript(this.speechRecognition.finalTranscript || '');
    const stableText = normalizeAsrTranscript(
      this.speechRecognition.getStableUtterance(0.5)
    );

    if (
      finalText &&
      !looksLikeIncompleteAgentPrompt(finalText) &&
      !parseArvisWakePhrase(finalText).triggered &&
      !looksLikePossibleAgentWake(finalText) &&
      !looksLikeAssistantEcho(finalText) &&
      this.tryForwardAgentUtterance(finalText)
    ) {
      if (
        finalText === this.lastPollUtterance &&
        getTime() - this.lastPollUtteranceAt < 0.75
      ) {
        return;
      }
      this.lastPollUtterance = finalText;
      this.lastPollUtteranceAt = getTime();
      this.speechRecognition.clearUtteranceState();
      this.speechRecognition.markCommandHandled();
      return;
    }

    const utterance = finalText || stableText;
    if (!utterance || isIgnorableUtterance(utterance)) {
      return;
    }

    // Agent wake is handled by ArvisAgentChat.pollIdleVoiceWake().
    if (
      parseArvisWakePhrase(utterance).triggered ||
      looksLikePossibleAgentWake(utterance)
    ) {
      return;
    }

    if (looksLikeAssistantEcho(utterance)) {
      return;
    }

    if (
      utterance === this.lastPollUtterance &&
      getTime() - this.lastPollUtteranceAt < 0.75
    ) {
      return;
    }

    if (this.speechRecognition.isCoolingDown()) {
      return;
    }

    this.lastPollUtterance = utterance;
    this.lastPollUtteranceAt = getTime();
    this.speechRecognition.clearUtteranceState();
    this.handleUtterance(utterance);
    this.speechRecognition.markCommandHandled();
  }

  private handleUtterance(text: string): void {
    if (looksLikeAssistantEcho(text)) {
      if (this.debugLogging) {
        print(`[VoiceCommands] Ignoring assistant echo: ${text.slice(0, 80)}`);
      }
      return;
    }

    if (this.debugLogging) {
      print(`[VoiceCommands] Processing: ${text}`);
    }

    if (isArvisCalendarQuery(text) && this.tryForwardAgentUtterance(text)) {
      return;
    }

    if (this.tryAgentCenterCommand(text)) {
      return;
    }
    if (this.tryTodoCommand(text)) {
      return;
    }
    if (this.tryWorkspaceResetCommand(text)) {
      return;
    }
    if (this.tryCompleteCommand(text)) {
      return;
    }
    if (this.trySyncCommand(text)) {
      return;
    }
    if (this.trySpaceCommand(text)) {
      return;
    }
    if (this.trySpawnCommand(text)) {
      return;
    }
    if (this.tryForwardAgentUtterance(text)) {
      return;
    }

    if (this.debugLogging) {
      print(`[VoiceCommands] Transcript only (no wake phrase): ${text}`);
    }
  }

  private tryForwardAgentUtterance(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed || looksLikeIncompleteAgentPrompt(trimmed)) {
      return false;
    }

    const isAgentIntent =
      isImageQuery(trimmed) ||
      isMeshQuery(trimmed) ||
      isMusicQuery(trimmed) ||
      isArvisCalendarQuery(trimmed) ||
      isArvisEmailDraftQuery(trimmed) ||
      isNewsIntentQuery(trimmed);
    if (!isAgentIntent) {
      return false;
    }

    if (looksLikeAssistantEcho(trimmed)) {
      return false;
    }

    const agent = getSharedArvisAgentChat();
    if (isNull(agent) || agent.isBusy()) {
      return false;
    }

    if (this.debugLogging) {
      print(`[VoiceCommands] Forwarding to Arvis: ${trimmed.slice(0, 100)}`);
    }
    agent.sendUtterance(trimmed);
    return true;
  }

  private tryAgentCenterCommand(text: string): boolean {
    const normalized = String(text || '').trim().toLowerCase();
    const panel = this.spacePanel as unknown as SpacePanelLike;
    if (isNull(this.spacePanel)) {
      return false;
    }

    if (
      /\b(cancel|stop)\b/.test(normalized) &&
      /\b(cursor|claude|agent|session|coding task)\b/.test(normalized)
    ) {
      const provider =
        normalized.indexOf('claude') >= 0 ? 'claude_code' : 'cursor_sdk';
      const cancelled =
        getSharedCodingBuddy(provider)?.cancelCurrentSession?.() === true;
      this.setStatus(
        cancelled
          ? `${provider === 'claude_code' ? 'Claude' : 'Cursor'} session cancellation requested`
          : `No active ${provider === 'claude_code' ? 'Claude' : 'Cursor'} session`
      );
      return true;
    }

    if (/\b(show|open)\s+(agent center|agents|chats|settings)\b/.test(normalized)) {
      const tab = /\bsettings\b/.test(normalized)
        ? 'settings'
        : /\bchats\b/.test(normalized)
          ? 'chats'
          : 'agents';
      panel.showAgentCenter?.(tab);
      this.setStatus(`Agent Center: ${tab}`);
      return true;
    }

    if (/\b(start|show|open)\s+demo\b/.test(normalized)) {
      this.specsApi?.setExplicitDemoMode(true);
      panel.showAgentCenterDemo?.(
        'Cursor and Claude workflow',
        'Say “ask Cursor to inspect the repository” or “ask Claude to explain this project.” Responses are simulated and never edit files.'
      );
      this.setStatus('Agent Center Demo');
      return true;
    }

    if (/\b(pair|connect)\s+(?:my\s+)?mac\b/.test(normalized)) {
      this.specsApi?.setExplicitDemoMode(false);
      const pairingCode = this.deviceRegistry?.getDeviceId() || '';
      panel.showAgentPairing?.('https://arvis.space/specs/', pairingCode);
      this.setStatus('Open arvis.space/specs and enter the pairing code');
      return true;
    }

    const directAgentRequest = String(text || '').trim().match(
      /\bask\s+(cursor|claude)(?:\s+code)?\s+(?:to\s+)?(.+)$/i
    );
    if (directAgentRequest && directAgentRequest[2]) {
      const providerId =
        directAgentRequest[1].toLowerCase() === 'claude'
          ? 'claude_code'
          : 'cursor_sdk';
      const accepted =
        getSharedCodingBuddy(providerId)?.requestCodingTask?.(
          directAgentRequest[2].trim()
        ) === true;
      this.setStatus(
        accepted
          ? `Sent to ${providerId === 'claude_code' ? 'Claude' : 'Cursor'}`
          : `${providerId === 'claude_code' ? 'Claude' : 'Cursor'} is busy or unavailable`
      );
      return true;
    }

    const providerMatch = normalized.match(
      /\b(?:use|select|ask)\s+(cursor|claude)(?:\s+code)?\b/
    );
    if (providerMatch) {
      const provider = providerMatch[1] === 'claude' ? 'Claude' : 'Cursor';
      panel.showAgentProviderSelection?.(['Cursor', 'Claude'], provider);
      this.setStatus(`${provider} selected — say “ask ${provider} to…”`);
      return true;
    }

    if (/\b(show|list)\s+(repositories|repos|workspaces)\b/.test(normalized)) {
      if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
        this.setStatus('Agent repository service unavailable');
        return true;
      }
      this.specsApi.fetchAllowedAgentWorkspaces(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        (workspaces, error) => {
          if (workspaces.length === 0) {
            panel.showAgentRepositorySelection?.([]);
            this.setStatus(error || 'No approved repositories');
            return;
          }
          panel.showAgentRepositorySelection?.(
            workspaces.map(
              (workspace) =>
                `${workspace.repositoryName || workspace.workspaceName} · ${workspace.id}`
            )
          );
          this.setStatus(`${workspaces.length} approved repositories`);
        }
      );
      return true;
    }

    if (/\b(show|list)\s+models\b/.test(normalized)) {
      if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
        this.setStatus('Agent model service unavailable');
        return true;
      }
      const state = panel.getAgentCenterState?.();
      const providerId =
        state?.provider === 'claude_code' ? 'claude_code' : 'cursor_sdk';
      this.specsApi.fetchAgentModels(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        providerId,
        (models, error) => {
          if (models.length === 0) {
            panel.showAgentModelSelection?.([]);
            this.setStatus(error || 'No models available');
            return;
          }
          panel.showAgentModelSelection?.(
            models.map((model) => `${model.displayName} · ${model.id}`)
          );
          this.setStatus(`${models.length} models available`);
        }
      );
      return true;
    }

    const repositoryMatch = normalized.match(
      /\b(?:use|select)\s+(?:repository|repo|workspace)\s+(.+)$/
    );
    if (repositoryMatch && repositoryMatch[1]) {
      const repository = repositoryMatch[1].trim().toLowerCase();
      if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
        this.setStatus('Agent repository service unavailable');
        return true;
      }
      this.specsApi.fetchAllowedAgentWorkspaces(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        (workspaces, error) => {
          const selected = workspaces.find((workspace) => {
            const candidates = [
              workspace.id,
              workspace.repositoryName,
              workspace.workspaceName,
            ];
            return candidates.some(
              (candidate) => String(candidate || '').trim().toLowerCase() === repository
            );
          });
          if (!selected) {
            this.setStatus(error || `Repository is not bridge-approved: ${repository}`);
            return;
          }
          panel.showAgentRepositorySelection?.(
            [selected.repositoryName || selected.workspaceName],
            selected.id
          );
          this.setStatus(`Repository selected: ${selected.repositoryName}`);
        }
      );
      return true;
    }

    const modelMatch = normalized.match(/\b(?:use|select)\s+model\s+(.+)$/);
    if (modelMatch && modelMatch[1]) {
      const requestedModel = modelMatch[1].trim().toLowerCase();
      if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
        this.setStatus('Agent model service unavailable');
        return true;
      }
      const state = panel.getAgentCenterState?.();
      const providerId =
        state?.provider === 'claude_code' ? 'claude_code' : 'cursor_sdk';
      this.specsApi.fetchAgentModels(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        providerId,
        (models, error) => {
          const selected = models.find((model) => {
            return (
              model.id.toLowerCase() === requestedModel ||
              model.displayName.toLowerCase() === requestedModel
            );
          });
          if (!selected) {
            this.setStatus(error || `Model is not available: ${requestedModel}`);
            return;
          }
          panel.showAgentModelSelection?.([selected.displayName], selected.id);
          this.setStatus(`Model selected: ${selected.displayName}`);
        }
      );
      return true;
    }

    return false;
  }

  private tryWorkspaceResetCommand(text: string): boolean {
    if (!looksLikeWorkspaceResetCommand(text)) {
      return false;
    }
    const friend = getSharedFriendGrab();
    if (isNull(friend) || typeof friend.restartOnboardingTour !== 'function') {
      this.setStatus('Buddy reset unavailable');
      return true;
    }
    const ok = friend.restartOnboardingTour('voice-commands');
    this.setStatus(ok ? 'Restarting setup…' : 'Setup already running');
    return true;
  }

  private tryTodoCommand(text: string): boolean {
    const patterns = [
      /^todo[:\s]+(.+)$/,
      /^add todo[:\s]+(.+)$/,
      /^remember to[:\s]+(.+)$/,
      /^remind me to[:\s]+(.+)$/,
    ];

    for (let i = 0; i < patterns.length; i++) {
      const match = text.match(patterns[i]);
      if (!match || !match[1]) {
        continue;
      }

      const todoText = match[1].trim();
      if (!todoText) {
        return true;
      }

      this.createTodoDirect(todoText);
      return true;
    }

    return false;
  }

  private createTodoDirect(todoText: string): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry) || !this.deviceRegistry.isPaired()) {
      this.setStatus('Pair at arvis.space/specs to add todos by voice');
      return;
    }

    this.specsApi.createTask(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      todoText,
      (taskId, error) => {
        if (!taskId) {
          this.setStatus(`Todo failed: ${error || 'unknown'}`);
          return;
        }

        this.setStatus(`Todo added: ${todoText}`);
        const panel = this.spacePanel as unknown as SpacePanelLike;
        if (!isNull(this.spacePanel) && typeof panel.refreshPanel === 'function') {
          panel.refreshPanel();
        }
      }
    );
  }

  private tryCompleteCommand(text: string): boolean {
    if (!/\b(complete|done|finish|finished|i did)\b/.test(text)) {
      return false;
    }

    const goalPlant = PlantLifecycle.tryCompleteGoalBySpeech(text);
    if (!isNull(goalPlant)) {
      const goal = goalPlant.getGoalText() || 'goal';
      this.setStatus(`Goal grown: ${goal}`);
      return true;
    }

    this.setStatus('No matching active goal');
    return true;
  }

  private trySyncCommand(text: string): boolean {
    if (isArvisCalendarQuery(text)) {
      return false;
    }
    if (!/\b(sync|refresh)\b/.test(text)) {
      return false;
    }

    const panel = this.spacePanel as unknown as SpacePanelLike;
    if (!isNull(this.spacePanel) && typeof panel.refreshPanel === 'function') {
      panel.refreshPanel();
      this.setStatus('Syncing tasks…');
      return true;
    }

    this.setStatus('Task sync unavailable');
    return true;
  }

  private trySpaceCommand(text: string): boolean {
    const panel = this.spacePanel as unknown as SpacePanelLike;

    if (/\b(refresh|open)\s+(space|board|panel)\b/.test(text)) {
      if (!isNull(this.spacePanel) && typeof panel.showPanel === 'function') {
        panel.showPanel();
        this.setStatus('Refreshing space board');
        return true;
      }
    }

    if (/\b(next|previous|back)\s+(item|note|slide|page)\b/.test(text)) {
      if (isNull(this.spacePanel)) {
        return false;
      }
      if (/\b(next)\b/.test(text) && typeof panel.nextItem === 'function') {
        panel.nextItem();
        this.setStatus('Next space item');
        return true;
      }
      if (/\b(previous|back)\b/.test(text) && typeof panel.previousItem === 'function') {
        panel.previousItem();
        this.setStatus('Previous space item');
        return true;
      }
    }

    const notePatterns = [/^note[:\s]+(.+)$/, /^add note[:\s]+(.+)$/];
    for (let i = 0; i < notePatterns.length; i++) {
      const match = text.match(notePatterns[i]);
      if (!match || !match[1]) {
        continue;
      }
      const noteText = match[1].trim();
      if (!noteText) {
        return true;
      }
      if (!isNull(this.spacePanel) && typeof panel.appendNote === 'function') {
        panel.appendNote(noteText, (ok) => {
          this.setStatus(ok ? `Note saved: ${noteText}` : 'Could not save note');
        });
        return true;
      }
      this.setStatus('Space panel not wired');
      return true;
    }

    return false;
  }

  private trySpawnCommand(text: string): boolean {
    if (/\bpot\b/.test(text)) {
      const source = this.potSource as unknown as SpawnSourceLike;
      if (!isNull(this.potSource) && typeof source.spawnPotAtSource === 'function') {
        source.spawnPotAtSource();
        this.setStatus('Spawning pot');
        return true;
      }
    }

    return false;
  }

  private setStatus(message: string): void {
    if (!isNull(this.statusText)) {
      this.statusText.text = message;
    }
    if (this.debugLogging) {
      print(`[VoiceCommands] ${message}`);
    }
  }
}
