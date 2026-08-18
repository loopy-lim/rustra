import assert from 'node:assert/strict';
import test from 'node:test';
import { rustraPlugin } from './vite.js';

test('rustraPlugin returns vite plugin with name and hooks', () => {
  const plugin = rustraPlugin({
    backendDir: 'custom-backend',
    generatedDir: 'custom-gen',
  });

  assert.equal(plugin.name, 'vite-plugin-rustra');
  assert.equal(typeof plugin.buildStart, 'function');
  assert.equal(typeof plugin.handleHotUpdate, 'function');
});

test('rustraPlugin handles buildStart gracefully when directory is absent', async () => {
  const plugin = rustraPlugin({
    backendDir: 'non-existent-dir-1234',
  });

  await assert.doesNotReject(async () => {
    await plugin.buildStart();
  });
});
