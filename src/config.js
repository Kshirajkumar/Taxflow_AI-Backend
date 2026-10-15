const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const isProduction = process.env.NODE_ENV === 'production';

function required(name) {
  const value = process.env[name];
  if (!value && isProduction) throw new Error(`${name} is required in production`);
  return value || '';
}

const hasRemoteObjectStore = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET);
if (isProduction && !process.env.VAULT_PATH && !hasRemoteObjectStore) throw new Error('VAULT_PATH or Supabase Storage configuration is required in production');

module.exports = {
  port: Number(process.env.PORT || 5000),
  databaseUrl: required('DATABASE_URL'),
  firmId: required('TAXFLOW_FIRM_ID'),
  clientUserId: required('TAXFLOW_CLIENT_USER_ID'),
  apiToken: required('TAXFLOW_API_TOKEN'),
  intakeSpoolPath: path.resolve(process.env.INTAKE_SPOOL_PATH || path.join(process.cwd(), 'data', 'intake-spool')),
  stagingPath: path.resolve(process.env.EXTRACTION_STAGING_PATH || path.join(process.cwd(), 'data', 'staging')),
  vaultPath: process.env.VAULT_PATH ? path.resolve(process.env.VAULT_PATH) : (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? path.resolve(process.cwd(), 'data', 'remote-vault-placeholder') : ''),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'taxflow-intake',
  corsOrigins: String(process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  webhookSecret: process.env.WHATSAPP_APP_SECRET || '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramWebhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
  telegramApiBaseUrl: process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org',
  emailWebhookSecret: process.env.EMAIL_WEBHOOK_SECRET || '',
  requireWebhookSecrets: isProduction,
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  maxUploadBytes: Number(process.env.MAX_INTAKE_BYTES || 25 * 1024 * 1024),
  relayRetentionMs: Number(process.env.RELAY_RETENTION_MS || 7 * 24 * 60 * 60 * 1000),
  encryptionKey: required('INTAKE_ENCRYPTION_KEY') || Buffer.alloc(32, 0).toString('base64'),
};
