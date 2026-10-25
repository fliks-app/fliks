import assert from 'node:assert/strict';
import test from 'node:test';
import { toElectronKey } from './keymap.ts';

test('a letter becomes its lowercase key code', () => {
  assert.deepEqual(toElectronKey('F', 0), { keyCode: 'f', modifiers: [] });
});

test('modifiers ride along: Ctrl+V and Shift+Tab', () => {
  assert.deepEqual(toElectronKey('V', 0x0040), { keyCode: 'v', modifiers: ['control'] });
  assert.deepEqual(toElectronKey('Tab', 0x0001), { keyCode: 'Tab', modifiers: ['shift'] });
});

test('SDL names are translated', () => {
  assert.equal(toElectronKey('Return', 0)?.keyCode, 'Enter');
  assert.equal(toElectronKey('Page Down', 0)?.keyCode, 'PageDown');
  assert.equal(toElectronKey('AudioNext', 0)?.keyCode, 'MediaNextTrack');
  assert.equal(toElectronKey('F11', 0)?.keyCode, 'F11');
});

test('pure modifiers and unknown keys are dropped', () => {
  assert.equal(toElectronKey('Left Shift', 1), null);
  assert.equal(toElectronKey('Keypad 5', 0), null);
  assert.equal(toElectronKey('', 0), null);
});
