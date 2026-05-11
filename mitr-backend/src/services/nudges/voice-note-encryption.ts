import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENCRYPTED_FILE_MAGIC = Buffer.from('MITRVN1', 'utf8');
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export const resolveVoiceNoteEncryptionKey = (encoded?: string): Buffer | null => {
  const trimmed = encoded?.trim();
  if (!trimmed) return null;
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('VOICE_NOTES_ENCRYPTION_KEY_B64 must decode to 32 bytes');
  }
  return key;
};

export const encryptVoiceNotePayload = (plaintext: Buffer, fileName: string, key: Buffer | null): Buffer => {
  if (!key) return plaintext;

  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(fileName, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_FILE_MAGIC, iv, tag, ciphertext]);
};

export const decryptVoiceNotePayload = (stored: Buffer, fileName: string, key: Buffer | null): Buffer => {
  if (!stored.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC)) {
    return stored;
  }
  if (!key) {
    throw new Error('Voice note encryption key is required to stream this file');
  }

  const headerBytes = ENCRYPTED_FILE_MAGIC.length + AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES;
  if (stored.length < headerBytes) {
    throw new Error('Encrypted voice note is truncated');
  }

  const ivStart = ENCRYPTED_FILE_MAGIC.length;
  const tagStart = ivStart + AES_GCM_IV_BYTES;
  const ciphertextStart = tagStart + AES_GCM_TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(ivStart, tagStart));
  decipher.setAAD(Buffer.from(fileName, 'utf8'));
  decipher.setAuthTag(stored.subarray(tagStart, ciphertextStart));
  return Buffer.concat([decipher.update(stored.subarray(ciphertextStart)), decipher.final()]);
};
