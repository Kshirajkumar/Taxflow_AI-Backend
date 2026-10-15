const fs = require('node:fs/promises');
const path = require('node:path');
const { safeName, sha256, encrypt, decrypt } = require('./security');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function remoteEnabled(config) {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey && config.supabaseStorageBucket);
}

function objectUrl(config, key) {
  const base = String(config.supabaseUrl).replace(/\/$/, '');
  const encoded = String(key).split('/').map(encodeURIComponent).join('/');
  return `${base}/storage/v1/object/${encodeURIComponent(config.supabaseStorageBucket)}/${encoded}`;
}

async function uploadObject(config, key, bytes) {
  const response = await fetch(objectUrl(config, key), { method: 'POST', headers: { authorization: `Bearer ${config.supabaseServiceRoleKey}`, apikey: config.supabaseServiceRoleKey, 'content-type': 'application/octet-stream', 'x-upsert': 'false' }, body: bytes });
  if (!response.ok) throw new Error(`object_upload_failed_${response.status}`);
  return key;
}

async function downloadObject(config, key) {
  const response = await fetch(objectUrl(config, key), { headers: { authorization: `Bearer ${config.supabaseServiceRoleKey}`, apikey: config.supabaseServiceRoleKey } });
  if (!response.ok) throw new Error(`object_download_failed_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function writeImmutable(dir, filename, bytes) {
  await ensureDir(dir);
  const name = safeName(filename);
  const target = path.join(dir, name);
  try { await fs.access(target); throw new Error('target already exists'); } catch (error) { if (error.message === 'target already exists') throw error; }
  const temp = `${target}.${process.pid}.${Date.now()}.part`;
  await fs.writeFile(temp, bytes, { flag: 'wx' });
  await fs.rename(temp, target);
  return { path: target, filename: name, bytes: bytes.length, checksum: sha256(bytes) };
}

async function saveSpool(config, intakeId, filename, bytes) {
  const dir = path.join(config.intakeSpoolPath, intakeId);
  const encrypted = encrypt(bytes, config.encryptionKey);
  if (remoteEnabled(config)) {
    const objectKey = `spool/${safeName(intakeId)}/${safeName(filename)}.enc`;
    await uploadObject(config, objectKey, encrypted);
    return { path: objectKey, filename: safeName(filename), bytes: bytes.length, checksum: sha256(bytes) };
  }
  const result = await writeImmutable(dir, `${safeName(filename)}.enc`, encrypted);
  return { ...result, filename: safeName(filename), checksum: sha256(bytes) };
}

async function readSpool(config, relativePath) {
  const root = path.resolve(config.intakeSpoolPath);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid spool path');
  return decrypt(await fs.readFile(target), config.encryptionKey);
}

async function readSpoolFile(config, storedPath) {
  if (remoteEnabled(config)) return decrypt(await downloadObject(config, storedPath), config.encryptionKey);
  const root = path.resolve(config.intakeSpoolPath);
  const relative = path.relative(root, path.resolve(storedPath));
  return readSpool(config, relative);
}

async function removeSpool(config, storedPath) {
  const root = path.resolve(config.intakeSpoolPath);
  const target = path.resolve(storedPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid spool path');
  await fs.rm(path.dirname(target), { recursive: true, force: true });
}

async function readVaultFile(config, relativePath) {
  if (remoteEnabled(config)) return decrypt(await downloadObject(config, relativePath), config.encryptionKey);
  if (!config.vaultPath) throw new Error('VAULT_PATH is not configured');
  const root = path.resolve(config.vaultPath);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid vault path');
  return fs.readFile(target);
}

async function checkPaths(config) {
  if (remoteEnabled(config)) {
    const response = await fetch(`${String(config.supabaseUrl).replace(/\/$/, '')}/storage/v1/bucket/${encodeURIComponent(config.supabaseStorageBucket)}`, { headers: { authorization: `Bearer ${config.supabaseServiceRoleKey}`, apikey: config.supabaseServiceRoleKey } });
    if (!response.ok) throw new Error(`storage_bucket_unavailable_${response.status}`);
    return true;
  }
  await fs.access(path.resolve(config.intakeSpoolPath));
  if (config.vaultPath) await fs.access(path.resolve(config.vaultPath));
  return true;
}

function storageAvailable(config) {
  return remoteEnabled(config) || Boolean(config.vaultPath);
}

function periodFolder(year, month) {
  return `${String(month).padStart(2, '0')}`;
}

function publishedName(filename, checksum) {
  const original = safeName(filename);
  const extension = path.extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;
  return `${stem}-${checksum.slice(0, 12)}${extension}`;
}

async function publishApproved(config, route, filename, bytes, bucket) {
  const client = safeName(route.clientName || route.clientId);
  const year = Number(route.year);
  const month = Number(route.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('Invalid vault period');
  const relativePath = path.join('Clients', client, String(year), periodFolder(year, month), bucket, safeName(filename)).split(path.sep).join('/');
  if (remoteEnabled(config)) {
    const objectKey = `vault/${relativePath}`;
    await uploadObject(config, objectKey, encrypt(bytes, config.encryptionKey));
    return { bytes: bytes.length, checksum: sha256(bytes), relativePath: objectKey };
  }
  if (!config.vaultPath) throw new Error('VAULT_PATH or Supabase Storage is required for publication');
  const root = path.resolve(config.vaultPath);
  const dir = path.join(root, 'Clients', client, String(year), periodFolder(year, month), bucket);
  const result = await writeImmutable(dir, filename, bytes);
  return { ...result, relativePath: path.relative(root, result.path) };
}

async function publishRaw(config, route, filename, bytes) {
  const checksum = sha256(bytes);
  return publishApproved(config, route, publishedName(filename, checksum), bytes, 'Raw');
}

module.exports = { ensureDir, saveSpool, readSpool, readSpoolFile, removeSpool, readVaultFile, checkPaths, storageAvailable, publishApproved, publishRaw };
