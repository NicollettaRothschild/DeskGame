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

export type FriendGrabLike = {
  restartOnboardingTour?: (reason?: string) => boolean;
};

export function registerSpeechRecognition(instance: SpeechRecognition): void {
  speechRecognition = instance;
}

export function getSharedSpeechRecognition(): SpeechRecognition | null {
  return speechRecognition;
}

export function registerSpecsApi(instance: SpecsApiClient): void {
  specsApi = instance;
}

export function getSharedSpecsApi(): SpecsApiClient | null {
  return specsApi;
}

export function registerSpecsDeviceRegistry(instance: SpecsDeviceRegistry): void {
  deviceRegistry = instance;
}

export function getSharedSpecsDeviceRegistry(): SpecsDeviceRegistry | null {
  return deviceRegistry;
}

export function registerFlowGardenSpacePanel(instance: FlowGardenSpacePanel): void {
  spacePanel = instance;
}

export function getSharedFlowGardenSpacePanel(): FlowGardenSpacePanel | null {
  return spacePanel;
}

export function registerFlowGardenTts(instance: FlowGardenTTS): void {
  agentTts = instance;
}

export function getSharedFlowGardenTts(): FlowGardenTTS | null {
  return agentTts;
}

export function registerArvisAgentChat(instance: ArvisAgentChat): void {
  arvisAgentChat = instance;
}

export function getSharedArvisAgentChat(): ArvisAgentChat | null {
  return arvisAgentChat;
}

export function registerArvisGhostBlob(instance: ArvisGhostBlob): void {
  arvisGhostBlob = instance;
}

export function getSharedArvisGhostBlob(): ArvisGhostBlob | null {
  return arvisGhostBlob;
}

export function registerFriendGrab(instance: FriendGrabLike): void {
  friendGrab = instance;
}

export function getSharedFriendGrab(): FriendGrabLike | null {
  return friendGrab;
}
