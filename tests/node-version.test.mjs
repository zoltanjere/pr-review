import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodePlan } from '../src/node-version.mjs';

const nvmDir = '/home/me/.nvm';
const binary = '/home/me/.nvm/versions/node/v26.13.1/bin/node';

test('a new enough Node just runs', () => {
  assert.deepEqual(nodePlan({ current: 'v26.13.1', pinned: 'v26.13.1', nvmDir }), { action: 'run' });
  assert.deepEqual(nodePlan({ current: 'v27.0.0', pinned: 'v26.13.1', nvmDir }), { action: 'run' });
});

test('an older Node restarts on the pinned version from nvm, for this project only', () => {
  assert.deepEqual(nodePlan({ current: 'v22.15.1', pinned: 'v26.13.1', nvmDir, exists: (path) => path === binary }), { action: 'restart', binary });
  assert.deepEqual(nodePlan({ current: 'v22.15.1', pinned: '26.13.1', nvmDir, exists: (path) => path === binary }), { action: 'restart', binary });
});

test('without the pinned version installed, or after a failed restart, it explains what to run', () => {
  const missing = nodePlan({ current: 'v22.15.1', pinned: 'v26.13.1', nvmDir, exists: () => false });
  assert.equal(missing.action, 'fail');
  assert.match(missing.message, /needs Node 26\.13\.1 \(pinned in \.nvmrc\); this is v22\.15\.1/);
  assert.match(missing.message, /nvm install v26\.13\.1/);
  assert.equal(nodePlan({ current: 'v22.15.1', pinned: 'v26.13.1', nvmDir, exists: () => true, restarted: true }).action, 'fail');
});
