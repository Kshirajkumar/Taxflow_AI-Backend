const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('begin');
    for (const filename of ['phase1_intake.sql', 'add_telegram_client_identity.sql', 'create_taxflow_storage_bucket.sql', 'telegram_outbound.sql']) {
      await pool.query(await fs.readFile(path.join(__dirname, filename), 'utf8'));
    }
    await pool.query('commit');
    console.log('Phase 1 intake, Telegram identity, and storage migrations applied');
  } catch (error) {
    await pool.query('rollback').catch(() => {});
    throw error;
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
