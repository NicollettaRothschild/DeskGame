import { ArvisAgentChat } from './ArvisAgentChat';
import { ArvisGhostBlob } from './ArvisGhostBlob';
import { FlowGardenSpacePanel } from './FlowGardenSpacePanel';
import { FlowGardenTTS } from './FlowGardenTTS';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';

let speechRecognition: SpeechRecognition | null = null;
let specsApi: SpecsApiClient | null = null;
let deviceRegistry: SpecsDeviceRegistry | null = null;
let spacePanel: FlowGardenSpacePanel | null = null;
let agentTts: FlowGardenTTS | null = null;
let arvisAgentChat: ArvisAgentChat | null = null;
let arvisGhostBlob: ArvisGhostBlob | null = null;
let friendGrab: FriendGrabLike | null = null;
const codingBuddies: { [providerId: string]: CodingBuddyLike } = {};

export type FriendGrabLike = {
  restartOnboardingTour?: (reason?: string) => boolean;
  showSpeech?: (text: string, speak?: boolean) => void;
};

export type CodingBuddyLike = {
  cancelCurrentSession?: () => boolean;
  requestCodingTask?: (prompt: string) => boolean;
};

export function registerCodingBuddy(
  providerId: string,
  instance: CodingBuddyLike
): void {
  const key = String(providerId || '').trim().toLowerCase();
  if (key) {
    codingBuddies[key] = instance;
  }
}

export function unregisterCodingBuddy(
  providerId: string,
  instance: CodingBuddyLike
): void {
  const key = String(providerId || '').trim().toLowerCase();
  if (key && codingBuddies[key] === instance) {
    delete codingBuddies[key];
  }
}

export function getSharedCodingBuddy(providerId: string): CodingBuddyLike | null {
  const key = String(providerId || '').trim().toLowerCase();
  return key && codingBuddies[key] ? codingBuddies[key] : null;
}

export function registerSpeechRecognition(instance: SpeechRecognition): void {
  speechRecognition = instance;
}

export function unregisterSpeechRecognition(instance: SpeechRecognition): void {
  if (speechRecognition === instance) {
    speechRecognition = null;
  }
}

export function getSharedSpeechRecognition(): SpeechRecognition | null {
  return speechRecognition;
}

export function registerSpecsApi(instance: SpecsApiClient): void {
  specsApi = instance;
}

export function unregisterSpecsApi(instance: SpecsApiClient): void {
  if (specsApi === instance) {
    specsApi = null;
  }
}

export function getSharedSpecsApi(): SpecsApiClient | null {
  return specsApi;
}

export function registerSpecsDeviceRegistry(instance: SpecsDeviceRegistry): void {
  deviceRegistry = instance;
}

export function unregisterSpecsDeviceRegistry(instance: SpecsDeviceRegistry): void {
  if (deviceRegistry === instance) {
    deviceRegistry = null;
  }
}

export function getSharedSpecsDeviceRegistry(): SpecsDeviceRegistry | null {
  return deviceRegistry;
}

export function registerFlowGardenSpacePanel(instance: FlowGardenSpacePanel): void {
  spacePanel = instance;
}

export function unregisterFlowGardenSpacePanel(instance: FlowGardenSpacePanel): void {
  if (spacePanel === instance) {
    spacePanel = null;
  }
}

export function getSharedFlowGardenSpacePanel(): FlowGardenSpacePanel | null {
  return spacePanel;
}

export function registerFlowGardenTts(instance: FlowGardenTTS): void {
  agentTts = instance;
}

export function unregisterFlowGardenTts(instance: FlowGardenTTS): void {
  if (agentTts === instance) {
    agentTts = null;
  }
}

export function getSharedFlowGardenTts(): FlowGardenTTS | null {
  return agentTts;
}

export function registerArvisAgentChat(instance: ArvisAgentChat): void {
  arvisAgentChat = instance;
}

export function unregisterArvisAgentChat(instance: ArvisAgentChat): void {
  if (arvisAgentChat === instance) {
    arvisAgentChat = null;
  }
}

export function getSharedArvisAgentChat(): ArvisAgentChat | null {
  return arvisAgentChat;
}

export function registerArvisGhostBlob(instance: ArvisGhostBlob): void {
  arvisGhostBlob = instance;
}

export function unregisterArvisGhostBlob(instance: ArvisGhostBlob): void {
  if (arvisGhostBlob === instance) {
    arvisGhostBlob = null;
  }
}

export function getSharedArvisGhostBlob(): ArvisGhostBlob | null {
  return arvisGhostBlob;
}

export function registerFriendGrab(instance: FriendGrabLike): void {
  friendGrab = instance;
}

export function unregisterFriendGrab(instance: FriendGrabLike): void {
  if (friendGrab === instance) {
    friendGrab = null;
  }
}

export function getSharedFriendGrab(): FriendGrabLike | null {
  return friendGrab;
}
