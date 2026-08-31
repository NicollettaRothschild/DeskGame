#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  isExplicitMacRequest,
  parseArvisEmailDraftIntent,
  parseArvisMacOpenAppIntent,
} from '../Assets/Scripts/ArvisEmailDraftIntent';
import { shouldAcceptTranscriptUpdate } from '../Assets/Scripts/ArvisWakePhrase';
import { SpecsEditorMock } from '../Assets/Scripts/SpecsEditorMock';
import { AgentCenterStateStore } from '../Assets/Scripts/AgentCenterStateStore';
import { formatSpecsPairingText3D } from '../Assets/Scripts/SpecsPairingDisplay';

type MockStorageData = Record<string, string | boolean>;
const mockStorageData: MockStorageData = {};
const mockStore = {
  getString(key: string): string {
    return String(mockStorageData[key] || '');
  },
  putString(key: string, value: string): void {
    mockStorageData[key] = value;
  },
  getBool(key: string): boolean {
    return mockStorageData[key] === true;
  },
  putBool(key: string, value: boolean): void {
    mockStorageData[key] = value;
  },
  getInt(key: string): number {
    return Number(mockStorageData[key] || 0);
  },
  putInt(key: string, value: number): void {
    mockStorageData[key] = value;
  },
  remove(key: string): void {
    delete mockStorageData[key];
  },
};

(globalThis as unknown as {
  global: { persistentStorageSystem: { store: typeof mockStore } };
  isNull: (value: unknown) => boolean;
}).global = { persistentStorageSystem: { store: mockStore } };
(globalThis as unknown as { isNull: (value: unknown) => boolean }).isNull =
  (value) => value == null;

const email = parseArvisEmailDraftIntent(
  'On my Mac, draft an email to person@example.com about the bridge test'
);
assert.equal(email?.recipient, 'person@example.com');
assert.equal(email?.topic, 'the bridge test');
assert.equal(isExplicitMacRequest('open Safari on my Mac'), true);
assert.equal(isExplicitMacRequest('tell my Mac to open Safari'), true);
assert.equal(isExplicitMacRequest('draft an email to person@example.com'), false);
assert.equal(shouldAcceptTranscriptUpdate(false, false, false), true);
assert.equal(shouldAcceptTranscriptUpdate(true, false, false), false);
assert.equal(shouldAcceptTranscriptUpdate(true, true, false), true);
assert.equal(shouldAcceptTranscriptUpdate(true, false, true), true);

const openApp = parseArvisMacOpenAppIntent('open Safari on my Mac');
assert.equal(openApp?.applicationName, 'Safari');
assert.equal(
  parseArvisMacOpenAppIntent('tell my Mac to launch Visual Studio Code')?.applicationName,
  'Visual Studio Code'
);
assert.equal(parseArvisMacOpenAppIntent('open Safari'), null);
assert.equal(formatSpecsPairingText3D('SPEC-TEST', true), '');
assert.match(formatSpecsPairingText3D('SPEC-TEST', false), /arvis\.space/);

SpecsEditorMock.clearPaired();
SpecsEditorMock.markPaired();
const queued = SpecsEditorMock.queueBridgeCommand(
  'prepare_coding_task',
  'editor-round-trip',
  '/Users/test/Documents/GitHub/Sessio'
);
assert.equal(queued.status, 'pending');
const statuses = [
  SpecsEditorMock.fetchBridgeCommandStatus(queued.commandId)?.status,
  SpecsEditorMock.fetchBridgeCommandStatus(queued.commandId)?.status,
  SpecsEditorMock.fetchBridgeCommandStatus(queued.commandId)?.status,
  SpecsEditorMock.fetchBridgeCommandStatus(queued.commandId)?.status,
];
assert.deepEqual(statuses, ['pending', 'claimed', 'approved', 'completed']);

const providers = SpecsEditorMock.discoverAgentProviders();
assert.deepEqual(
  providers.map((provider) => provider.id),
  ['cursor_sdk', 'claude_code']
);
assert.ok(providers.every((provider) => provider.displayName.includes('Demo/Preview')));

const setup = SpecsEditorMock.fetchAgentSetupState();
assert.equal(setup.paired, true);
assert.equal(setup.bridgeConnected, false);
assert.equal(setup.mode, 'demo_preview');

const workspaces = SpecsEditorMock.fetchAllowedAgentWorkspaces();
assert.deepEqual(workspaces[0]?.providerIds, ['cursor_sdk', 'claude_code']);
assert.equal(workspaces[0]?.id, 'demo-workspace');

for (const providerId of ['cursor_sdk', 'claude_code']) {
  const models = SpecsEditorMock.fetchAgentModels(providerId);
  assert.equal(models[0]?.providerId, providerId);
  assert.equal(models[0]?.isDefault, true);

  const session = SpecsEditorMock.startAgentSession(
    providerId,
    'demo-workspace',
    'auto',
    'Inspect the selected repository'
  );
  assert.equal(session.providerId, providerId);
  assert.equal(session.status, 'queued');
  assert.match(session.progress, /Demo\/Preview/);

  const running = SpecsEditorMock.fetchAgentSessionStatus(session.sessionId);
  assert.equal(running?.status, 'running');
  SpecsEditorMock.fetchAgentSessionStatus(session.sessionId);
  const completed = SpecsEditorMock.fetchAgentSessionStatus(session.sessionId);
  assert.equal(completed?.status, 'completed');
  assert.match(completed?.result || '', /no files were accessed or changed/i);
  assert.deepEqual(
    SpecsEditorMock.fetchAgentSessionHistory(session.sessionId).map((entry) => entry.role),
    ['user', 'assistant']
  );
}

const cancellable = SpecsEditorMock.startAgentSession(
  'claude_code',
  'demo-workspace',
  'auto',
  'Prepare a cancellation test'
);
const cancelled = SpecsEditorMock.cancelAgentSession(cancellable.sessionId);
assert.equal(cancelled?.status, 'cancelled');
assert.match(cancelled?.result || '', /no files were accessed or changed/i);
assert.equal(
  SpecsEditorMock.fetchAgentSessionStatus(cancellable.sessionId)?.status,
  'cancelled'
);
assert.equal(SpecsEditorMock.cancelAgentSession('missing-session'), null);

const sanitized = SpecsEditorMock.startAgentSession(
  'cursor_sdk',
  'demo-workspace',
  'auto',
  'Inspect /Users/judge/private/repo with api_key=do-not-display'
);
const sanitizedPrompt =
  SpecsEditorMock.fetchAgentSessionHistory(sanitized.sessionId)[0]?.text || '';
assert.match(sanitizedPrompt, /\[local path hidden\]/);
assert.match(sanitizedPrompt, /api_key=\[hidden\]/);
assert.doesNotMatch(sanitizedPrompt, /do-not-display|\/Users\/judge/);

const followedUp = SpecsEditorMock.sendAgentFollowUp(
  sanitized.sessionId,
  'Now summarize the safe result'
);
assert.equal(followedUp?.status, 'running');
assert.deepEqual(
  SpecsEditorMock.fetchAgentSessionHistory(sanitized.sessionId).map(
    (entry) => entry.role
  ),
  ['user', 'user']
);
assert.equal(SpecsEditorMock.sendAgentFollowUp('missing-session', 'hello'), null);

AgentCenterStateStore.setWorkspace('cursor_sdk', 'cursor-workspace');
AgentCenterStateStore.setModel('cursor_sdk', 'cursor-model');
AgentCenterStateStore.setWorkspace('claude_code', 'claude-workspace');
AgentCenterStateStore.setModel('claude_code', 'claude-model');
assert.deepEqual(AgentCenterStateStore.get('cursor_sdk'), {
  providerId: 'cursor_sdk',
  workspaceId: 'cursor-workspace',
  modelId: 'cursor-model',
});
assert.deepEqual(AgentCenterStateStore.get('claude_code'), {
  providerId: 'claude_code',
  workspaceId: 'claude-workspace',
  modelId: 'claude-model',
});
assert.equal(AgentCenterStateStore.get('unknown').providerId, 'cursor_sdk');

console.log('Specs bridge client checks passed');
