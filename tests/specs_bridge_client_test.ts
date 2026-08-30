#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  isExplicitMacRequest,
  parseArvisEmailDraftIntent,
  parseArvisMacOpenAppIntent,
} from '../Assets/Scripts/ArvisEmailDraftIntent';
import { SpecsEditorMock } from '../Assets/Scripts/SpecsEditorMock';

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

const openApp = parseArvisMacOpenAppIntent('open Safari on my Mac');
assert.equal(openApp?.applicationName, 'Safari');
assert.equal(
  parseArvisMacOpenAppIntent('tell my Mac to launch Visual Studio Code')?.applicationName,
  'Visual Studio Code'
);
assert.equal(parseArvisMacOpenAppIntent('open Safari'), null);

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

console.log('Specs bridge client checks passed');
