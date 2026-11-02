import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, getDeviceStatus, registerDeviceStatusProvider } from '@rustra/types';
import { deviceDemo } from '../generated/commands.js';
import { DEVICE_DEMO_DEVICES } from '../generated/devices.js';

void test('device declarations surface as generated constants', () => {
  assert.deepEqual([...DEVICE_DEMO_DEVICES], ['camera', 'bluetooth']);
});

void test('declared capability status is queryable through the host provider', async () => {
  const seen: string[] = [];
  registerDeviceStatusProvider(async (capability) => {
    seen.push(capability);
    return capability === 'camera'
      ? { availability: 'available', permission: 'granted' }
      : { availability: 'unavailable', permission: 'unknown' };
  });

  const status = await getDeviceStatus('camera');
  assert.deepEqual(status, { availability: 'available', permission: 'granted' });

  const unavailable = await getDeviceStatus('bluetooth');
  assert.equal(unavailable.availability, 'unavailable');
  assert.deepEqual(seen, ['camera', 'bluetooth']);
});

void test('a device-declared command still invokes without runtime gating', async () => {
  configure({
    async invoke<T>(): Promise<T> {
      return { os: 'darwin' } as T;
    },
  });
  const out = await deviceDemo();
  assert.equal(typeof out.os, 'string');
});
