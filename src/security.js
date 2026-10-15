const crypto = require('node:crypto');

function safeName(value, fallback = 'document') {
  const base = String(value || fallback).normalize('NFKC').replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return (base || fallback).slice(0, 180);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function timingSafeHexEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function verifyWhatsAppSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const value = String(signature).replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeHexEqual(expected, value);
}

function verifySecret(value, secret) {
  if (!secret || !value) return false;
  const expected = crypto.createHmac('sha256', secret).update('taxflow-email-webhook').digest('hex');
  return timingSafeHexEqual(expected, String(value).replace(/^sha256=/, ''));
}

function verifyTelegramSecret(value, secret) {
  if (!secret || !value || String(value).length !== String(secret).length) return false;
  return crypto.timingSafeEqual(Buffer.from(String(value)), Buffer.from(String(secret)));
}

function encryptionKey(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error('INTAKE_ENCRYPTION_KEY must be a base64 encoded 32-byte key');
  return key;
}

function encrypt(bytes, keyValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from('TF1'), iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(payload, keyValue) {
  if (payload.subarray(0, 3).toString() !== 'TF1') throw new Error('invalid encrypted relay object');
  const iv = payload.subarray(3, 15); const tag = payload.subarray(15, 31); const ciphertext = payload.subarray(31);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyValue), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { safeName, sha256, verifyWhatsAppSignature, verifySecret, verifyTelegramSecret, encrypt, decrypt };
