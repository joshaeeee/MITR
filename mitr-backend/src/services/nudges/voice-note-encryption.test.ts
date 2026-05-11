import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptVoiceNotePayload,
  encryptVoiceNotePayload,
  resolveVoiceNoteEncryptionKey
} from './voice-note-encryption.js';

test('voice note encryption round-trips with filename-bound authenticated data', () => {
  const key = resolveVoiceNoteEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  const plaintext = Buffer.from('family voice note audio bytes');
  const encrypted = encryptVoiceNotePayload(plaintext, 'note-a.m4a', key);

  assert.notDeepEqual(encrypted, plaintext);
  assert.deepEqual(decryptVoiceNotePayload(encrypted, 'note-a.m4a', key), plaintext);
  assert.throws(() => decryptVoiceNotePayload(encrypted, 'note-b.m4a', key));
});

test('voice note encryption keeps plaintext compatibility when no key is configured', () => {
  const plaintext = Buffer.from('legacy local voice note');

  assert.deepEqual(encryptVoiceNotePayload(plaintext, 'legacy.m4a', null), plaintext);
  assert.deepEqual(decryptVoiceNotePayload(plaintext, 'legacy.m4a', null), plaintext);
});

test('voice note encryption rejects invalid key length', () => {
  assert.throws(() => resolveVoiceNoteEncryptionKey(Buffer.alloc(16, 1).toString('base64')), /32 bytes/);
});
