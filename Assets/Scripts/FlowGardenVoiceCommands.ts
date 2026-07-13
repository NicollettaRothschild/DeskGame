import { hasWakeFollowUp, parseArvisWakePhrase } from './ArvisWakePhrase';
import { getSharedArvisAgentChat } from './FlowGardenServiceRegistry';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';

type TaskBerryManagerLike = {
  forceSyncTasks?: () => void;
  completeBerryBySpeech?: (spokenText: string) => boolean;
  createVoiceTodo?: (text: string, onDone?: (ok: boolean) => void) => void;
};

type SpacePanelLike = {
  refreshPanel?: () => void;
  appendNote?: (text: string, onDone?: (ok: boolean) => void) => void;
  showPanel?: () => void;
  nextItem?: () => void;
  previousItem?: () => void;
};

type SpawnSourceLike = {
  spawnSeedAtSource?: () => SceneObject | null;
  spawnWaterAtSource?: () => SceneObject | null;
  spawnPotAtSource?: () => SceneObject | null;
};

@component
export class FlowGardenVoiceCommands extends BaseScriptComponent {
  @input
  @allowUndefined
  speechRecognition!: SpeechRecognition;

  @input
  @allowUndefined
  taskBerryManager!: ScriptComponent;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  seedSource!: ScriptComponent;

  @input
  @allowUndefined
  waterSource!: ScriptComponent;

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
  debugLogging: boolean = true;

  private lastProcessedFinal = '';

  onAwake(): void {
    this.createEvent('UpdateEvent').bind(() => this.pollTranscript());
  }

  private pollTranscript(): void {
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

    const finalText = String(this.speechRecognition.finalTranscript || '').trim().toLowerCase();
    if (!finalText || finalText === this.lastProcessedFinal) {
      return;
    }

    if (this.speechRecognition.isCoolingDown()) {
      return;
    }

    this.lastProcessedFinal = finalText;
    this.speechRecognition.clearFinalTranscript();
    this.handleUtterance(finalText);
    this.speechRecognition.markCommandHandled();
  }

  private handleUtterance(text: string): void {
    if (this.debugLogging) {
      print(`[VoiceCommands] Processing: ${text}`);
    }

    const wake = parseArvisWakePhrase(text);
    if (wake.triggered) {
      this.tryAgentWake(wake.message, text);
      return;
    }

    if (this.tryTodoCommand(text)) {
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

    if (this.debugLogging) {
      print(`[VoiceCommands] Transcript only (no wake phrase): ${text}`);
    }
  }

  private tryAgentWake(message: string, rawUtterance: string): void {
    const agent = getSharedArvisAgentChat();
    if (isNull(agent)) {
      this.setStatus('Agent not wired');
      return;
    }

    if (hasWakeFollowUp(message)) {
      const trimmed = String(message || '').trim();
      if (this.debugLogging) {
        print(`[VoiceCommands] Wake phrase — agent: ${trimmed}`);
      }
      agent.sendUtterance(trimmed);
      return;
    }

    if (this.debugLogging) {
      print(`[VoiceCommands] Wake phrase only — opening agent talk (${rawUtterance})`);
    }
    agent.beginWakeListening();
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

      const manager = this.taskBerryManager as unknown as TaskBerryManagerLike;
      if (!isNull(this.taskBerryManager) && typeof manager.createVoiceTodo === 'function') {
        manager.createVoiceTodo(todoText, (ok) => {
          this.setStatus(ok ? `Todo added: ${todoText}` : `Could not add todo`);
        });
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
        const manager = this.taskBerryManager as unknown as TaskBerryManagerLike;
        if (!isNull(this.taskBerryManager) && typeof manager.forceSyncTasks === 'function') {
          manager.forceSyncTasks();
        }
      }
    );
  }

  private tryCompleteCommand(text: string): boolean {
    if (!/\b(complete|done|finish)\b/.test(text)) {
      return false;
    }

    const manager = this.taskBerryManager as unknown as TaskBerryManagerLike;
    if (isNull(this.taskBerryManager) || typeof manager.completeBerryBySpeech !== 'function') {
      this.setStatus('No berries to complete');
      return true;
    }

    const remainder = text
      .replace(/\b(complete|done|finish|the|task|todo|berry)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const ok = manager.completeBerryBySpeech(remainder);
    this.setStatus(ok ? 'Berry completed' : 'No matching berry found');
    return true;
  }

  private trySyncCommand(text: string): boolean {
    if (!/\b(sync|refresh)\b/.test(text)) {
      return false;
    }

    const manager = this.taskBerryManager as unknown as TaskBerryManagerLike;
    if (!isNull(this.taskBerryManager) && typeof manager.forceSyncTasks === 'function') {
      manager.forceSyncTasks();
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
    if (/\b(seed|plant)\b/.test(text)) {
      const source = this.seedSource as unknown as SpawnSourceLike;
      if (!isNull(this.seedSource) && typeof source.spawnSeedAtSource === 'function') {
        source.spawnSeedAtSource();
        this.setStatus('Spawning seed');
        return true;
      }
    }

    if (/\bwater\b/.test(text)) {
      const source = this.waterSource as unknown as SpawnSourceLike;
      if (!isNull(this.waterSource) && typeof source.spawnWaterAtSource === 'function') {
        source.spawnWaterAtSource();
        this.setStatus('Spawning water');
        return true;
      }
    }

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
