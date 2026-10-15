const { createApp } = require('./app');
const { config } = require('./runtime');
const { MemoryStore, PgStore } = require('./store');
const vault = require('./vault');
const extractor = require('./extractor');

if (!config.databaseUrl && process.env.ALLOW_MEMORY_STORE !== 'true') {
  console.error('DATABASE_URL is required. Set ALLOW_MEMORY_STORE=true only for local development/tests.');
  process.exit(1);
}

const store = config.databaseUrl ? new PgStore(config.databaseUrl, config.firmId, config.clientUserId) : new MemoryStore();
const app = createApp({ store, vault, extractor, config });
app.listen(config.port, () => console.log(`Taxflow intake service listening on ${config.port}`));
