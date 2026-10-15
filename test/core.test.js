const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeName, sha256 } = require('../src/security');
const { resolveRoute, intakeHints } = require('../src/routing');
const { validateExtraction } = require('../src/extractor');
const vault = require('../src/vault');
const { MemoryStore } = require('../src/store');
const { createApp } = require('../src/app');

test('safe names remove traversal and checksum is stable', () => {
  assert.equal(safeName('../../client/secret.pdf'), '.._.._client_secret.pdf');
  assert.equal(sha256(Buffer.from('taxflow')), sha256(Buffer.from('taxflow')));
});

test('routing quarantines unresolved client or period', () => {
  const clients = [{ id: 'client-1', name: 'Acme', aliases: ['acme', '+1 555'] }];
  assert.equal(resolveRoute({ sender: 'unknown', year: 2026, month: 9 }, clients).status, 'quarantine');
  assert.equal(resolveRoute({ sender: 'acme', year: 2026 }, clients).reason, 'unknown_period');
  assert.deepEqual(resolveRoute({ sender: 'acme', year: 2026, month: 9 }, clients), { status: 'routed', clientId: 'client-1', clientName: 'Acme', year: 2026, month: 9 });
});

test('Telegram captions provide an explicit filing period without guessing', () => {
  assert.deepEqual(intakeHints({ caption: 'Invoices for September 2026' }), { clientId: undefined, telegramUsername: undefined, telegramUserId: undefined, year: 2026, month: 9 });
  assert.deepEqual(intakeHints({ caption: 'client=sharma September 2026', from: { username: 'rahul', id: 77 } }), { clientId: 'sharma', telegramUsername: 'rahul', telegramUserId: 77, year: 2026, month: 9 });
  assert.deepEqual(intakeHints({ caption: 'please send this' }), { clientId: undefined, telegramUsername: undefined, telegramUserId: undefined, year: undefined, month: undefined });
});

test('Telegram identity aliases route without guessing', () => {
  const clients = [{ id: 'client-1', name: 'Acme', telegramUsername: 'rahul_tax', telegramUserId: '77' }];
  assert.equal(resolveRoute({ sender: '@rahul_tax', telegramUsername: 'rahul_tax', year: 2026, month: 9 }, clients).clientId, 'client-1');
  assert.equal(resolveRoute({ sender: '77', telegramUserId: 77, year: 2026, month: 9 }, clients).clientId, 'client-1');
});

test('extraction contract rejects missing evidence and accepts structured source fields', () => {
  assert.throws(() => validateExtraction({ document_type: 'invoice' }));
  const value = { document_type: 'invoice', invoice_number: 'A-1', invoice_date: '2026-09-01', supplier_name: 'Acme', supplier_tax_id: null, buyer_name: 'Taxflow', currency: 'INR', taxable_value: 100, tax_rate: 18, source_evidence: [{ field: 'invoice_number', text: 'A-1', page: 1 }], confidence: { invoice_number: 0.99 } };
  assert.deepEqual(validateExtraction(value), value);
});

test('spool writes exact immutable bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taxflow-spool-'));
  const config = { intakeSpoolPath: root, encryptionKey: Buffer.alloc(32, 7).toString('base64') };
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const result = await vault.saveSpool(config, 'event-1', 'original.pdf', bytes);
  assert.notDeepEqual(await fs.readFile(result.path), bytes);
  assert.deepEqual(await vault.readSpoolFile(config, result.path), bytes);
  await assert.rejects(() => vault.saveSpool(config, 'event-1', 'original.pdf', bytes));
  await fs.rm(root, { recursive: true, force: true });
});

test('WhatsApp intake is idempotent and serves decrypted original bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taxflow-app-'));
  const config = { intakeSpoolPath: root, vaultPath: path.join(root, 'vault'), encryptionKey: Buffer.alloc(32, 8).toString('base64'), maxUploadBytes: 1024 * 1024, apiToken: '', webhookSecret: '', emailWebhookSecret: '', geminiApiKey: '', geminiModel: 'test', firmId: 'test' };
  const app = createApp({ store: new MemoryStore(), vault, extractor: require('../src/extractor'), config });
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const payload = { messages: [{ id: 'evt-1', from: 'sharma', client_id: 'sharma', year: 2026, month: 9, document: { base64: Buffer.from('hello').toString('base64'), filename: 'invoice.pdf', mime_type: 'application/pdf' } }] };
  const first = await fetch(`${url}/api/v1/integrations/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const firstBody = await first.json(); assert.equal(first.status, 202); assert.equal(firstBody.intake[0].route.status, 'routed');
  const rawFiles = await fs.readdir(path.join(root, 'vault', 'Clients', 'Sharma Traders', '2026', '09', 'Raw')); assert.equal(rawFiles.length, 1); assert.match(rawFiles[0], /invoice-[a-f0-9]{12}\.pdf/);
  const second = await fetch(`${url}/api/v1/integrations/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await second.json()).intake.length, 0);
  const content = await fetch(`${url}/api/v1/intake/events/${firstBody.intake[0].id}/content`); assert.equal(await content.text(), 'hello');
  await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
});

test('Telegram intake verifies secret, preserves media bytes, and is idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taxflow-telegram-'));
  const config = { intakeSpoolPath: root, vaultPath: path.join(root, 'vault'), encryptionKey: Buffer.alloc(32, 9).toString('base64'), maxUploadBytes: 1024 * 1024, apiToken: '', webhookSecret: '', emailWebhookSecret: '', telegramWebhookSecret: 'telegram-secret', telegramBotToken: '', geminiApiKey: '', geminiModel: 'test', firmId: 'test' };
  const app = createApp({ store: new MemoryStore(), vault, extractor: require('../src/extractor'), config });
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const payload = { update_id: 77, message: { message_id: 9, from: { username: 'sharma' }, document: { file_id: 'unused-with-inline-content', file_name: 'telegram-invoice.pdf', mime_type: 'application/pdf', content: Buffer.from('telegram-bytes').toString('base64') }, client_id: 'sharma', year: 2026, month: 9 } };
  const headers = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'telegram-secret' };
  const first = await fetch(`${url}/api/v1/integrations/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const firstBody = await first.json(); assert.equal(first.status, 202); assert.equal(firstBody.intake[0].route.status, 'routed');
  const rawFiles = await fs.readdir(path.join(root, 'vault', 'Clients', 'Sharma Traders', '2026', '09', 'Raw')); assert.equal(rawFiles.length, 1); assert.match(rawFiles[0], /telegram-invoice-[a-f0-9]{12}\.pdf/);
  const content = await fetch(`${url}/api/v1/intake/events/${firstBody.intake[0].id}/content`); assert.equal(await content.text(), 'telegram-bytes');
  const second = await fetch(`${url}/api/v1/integrations/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await second.json()).duplicate, true);
  await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
});

test('approved extraction is published by the server and keeps the Raw original', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taxflow-approval-'));
  const config = { intakeSpoolPath: root, vaultPath: path.join(root, 'vault'), encryptionKey: Buffer.alloc(32, 6).toString('base64'), maxUploadBytes: 1024 * 1024, apiToken: '', webhookSecret: '', emailWebhookSecret: '', telegramWebhookSecret: '', telegramBotToken: '', geminiApiKey: '', geminiModel: 'test', firmId: 'test' };
  const store = new MemoryStore();
  const spool = await vault.saveSpool(config, 'approval-event', 'invoice.pdf', Buffer.from('raw'));
  const raw = await vault.publishRaw(config, { clientId: 'sharma', clientName: 'Sharma Traders', year: 2026, month: 9 }, 'invoice.pdf', Buffer.from('raw'));
  const intake = store.addIntake({ firmId: 'test', provider: 'telegram', providerEventId: 'approval-event', sender: 'sharma', filename: 'invoice.pdf', mimeType: 'application/pdf', checksum: sha256(Buffer.from('raw')), bytes: 3, spoolPath: spool.path, route: { status: 'routed', clientId: 'sharma', clientName: 'Sharma Traders', year: 2026, month: 9 }, status: 'raw_persisted' });
  const document = store.addDocument({ firmId: 'test', intakeId: intake.id, clientId: 'sharma', clientName: 'Sharma Traders', year: 2026, month: 9, documentType: 'invoice', filename: 'invoice.pdf', mimeType: 'application/pdf', rawChecksum: intake.checksum, rawVaultPath: raw.relativePath, status: 'awaiting_review' });
  const data = { document_type: 'invoice', invoice_number: 'A-1', invoice_date: '2026-09-01', supplier_name: 'Acme', supplier_tax_id: null, buyer_name: 'Taxflow', currency: 'INR', taxable_value: 100, tax_rate: 18, source_evidence: [{ field: 'invoice_number', text: 'A-1', page: 1 }], confidence: { invoice_number: 0.99 } };
  const revision = store.addRevision({ firmId: 'test', documentId: document.id, schemaVersion: 'invoice.v1', provider: 'test', data, findings: [], actor: 'reviewer' });
  store.updateDocument(document.id, { status: 'awaiting_review', currentRevision: revision.revision });
  const app = createApp({ store, vault, extractor: require('../src/extractor'), config });
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const approve = await fetch(`${url}/api/v1/documents/${document.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revisionId: revision.id, reviewerId: 'ca-1' }) });
  assert.equal(approve.status, 200);
  const publish = await fetch(`${url}/api/v1/documents/${document.id}/publish-ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revisionId: revision.id, reviewerId: 'ca-1', artifactChecksum: 'client-controlled-value' }) });
  const publishedBody = await publish.json(); assert.equal(publish.status, 200); assert.notEqual(publishedBody.artifact.checksum, 'client-controlled-value');
  const extracted = await fs.readdir(path.join(root, 'vault', 'Clients', 'Sharma Traders', '2026', '09', 'Extracted')); assert.equal(extracted.length, 1);
  const original = await fetch(`${url}/api/v1/documents/${document.id}/raw`); assert.equal(original.status, 200); assert.equal(await original.text(), 'raw');
  assert.equal(store.getDocument(document.id).status, 'approved'); assert.equal(store.latestRevision(document.id).status, 'approved'); assert.equal(store.auditEvents.length, 2);
  await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
});

test('communication schedules require consent and approval before queueing', async () => {
  const store = new MemoryStore();
  const app = createApp({ store, vault, extractor: require('../src/extractor'), config: { intakeSpoolPath: os.tmpdir(), vaultPath: os.tmpdir(), encryptionKey: Buffer.alloc(32, 4).toString('base64'), maxUploadBytes: 1024 * 1024, apiToken: '', webhookSecret: '', emailWebhookSecret: '', telegramWebhookSecret: '', telegramBotToken: '', geminiApiKey: '', geminiModel: 'test', firmId: 'test' } });
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const base = { clientId: 'sharma', channel: 'whatsapp', template: 'missing_documents', body: 'Please send the September invoices.', scheduledFor: '2026-10-20T10:00:00Z' };
  const denied = await fetch(`${url}/api/v1/communications/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base) }); assert.equal(denied.status, 422);
  const created = await fetch(`${url}/api/v1/communications/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, consentRecorded: true }) }); const createdBody = await created.json(); assert.equal(created.status, 201);
  const approved = await fetch(`${url}/api/v1/communications/schedules/${createdBody.schedule.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'ca-1' }) }); const approvedBody = await approved.json(); assert.equal(approved.status, 200); assert.equal(approvedBody.sending, false); assert.equal(approvedBody.message.status, 'approved'); assert.match(approvedBody.notice, /not enabled/);
  await new Promise((resolve) => server.close(resolve));
});

test('Telegram client link is one-time and approved message is delivered through the Bot API', async () => {
  const telegramRequests = [];
  const telegramServer = await new Promise((resolve) => {
    const value = require('node:http').createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      telegramRequests.push({ path: req.url, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/getMe')) return res.end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, first_name: 'Taxflow', username: 'taxflow_pipeline_test_bot' } }));
      return res.end(JSON.stringify({ ok: true, result: { message_id: telegramRequests.length, chat: { id: JSON.parse(body || '{}').chat_id } } }));
    }).listen(0, () => resolve(value));
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taxflow-outbound-'));
  const store = new MemoryStore(); store.clients[0].telegramChatId = '777';
  const config = { intakeSpoolPath: root, vaultPath: path.join(root, 'vault'), encryptionKey: Buffer.alloc(32, 3).toString('base64'), maxUploadBytes: 1024 * 1024, apiToken: '', webhookSecret: '', emailWebhookSecret: '', telegramWebhookSecret: 'telegram-secret', telegramBotToken: 'test-token', telegramApiBaseUrl: `http://127.0.0.1:${telegramServer.address().port}`, geminiApiKey: '', geminiModel: 'test', firmId: 'test' };
  const app = createApp({ store, vault, extractor: require('../src/extractor'), config });
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const linkResponse = await fetch(`${url}/api/v1/clients/sharma/telegram-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ createdBy: 'ca-1' }) });
  assert.equal(linkResponse.status, 201); const link = await linkResponse.json(); const token = new URL(link.link).searchParams.get('start'); assert.ok(token);
  const webhook = await fetch(`${url}/api/v1/integrations/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'telegram-secret' }, body: JSON.stringify({ update_id: 101, message: { message_id: 1, chat: { id: 778, type: 'private' }, from: { id: 778, username: 'client' }, text: `/start ${token}` } }) });
  assert.equal(webhook.status, 202); assert.equal((await webhook.json()).linked, true); assert.equal(store.getClient('sharma').telegramChatId, '778');
  const reused = await fetch(`${url}/api/v1/integrations/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'telegram-secret' }, body: JSON.stringify({ update_id: 102, message: { message_id: 2, chat: { id: 778, type: 'private' }, from: { id: 778 }, text: `/start ${token}` } }) });
  assert.equal((await reused.json()).linked, false);
  const created = await fetch(`${url}/api/v1/communications/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'sharma', channel: 'telegram', template: 'direct_message', body: 'Please send the document.', scheduledFor: new Date().toISOString(), consentRecorded: true }) });
  assert.equal(created.status, 201); const schedule = await created.json();
  const approved = await fetch(`${url}/api/v1/communications/schedules/${schedule.schedule.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'ca-1' }) }); assert.equal(approved.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.ok(telegramRequests.some((request) => request.path.endsWith('/sendMessage') && request.body.chat_id === '778' && request.body.text === 'Please send the document.'), JSON.stringify(telegramRequests));
  await new Promise((resolve) => server.close(resolve)); await new Promise((resolve) => telegramServer.close(resolve)); await fs.rm(root, { recursive: true, force: true });
});
