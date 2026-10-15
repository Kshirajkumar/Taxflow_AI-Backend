const express = require('express');
const cors = require('cors');
const { config } = require('./runtime');
const { downloadWhatsAppMedia, downloadTelegramMedia } = require('./providers');
const { getTelegramBot, sendTelegramMessage } = require('./telegram');
const { resolveRoute, intakeHints } = require('./routing');

function rawBody(limit = config.maxUploadBytes) {
  return (req, res, next) => express.raw({ type: '*/*', limit })(req, res, (error) => {
    if (error) return next(error);
    try { req.rawPayload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(''); req.payload = req.rawPayload.length ? JSON.parse(req.rawPayload.toString('utf8')) : {}; req.body = req.payload; } catch { return res.status(400).json({ error: 'invalid_json' }); }
    next();
  });
}

function createApp({ store, vault, extractor, config: injectedConfig = config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: injectedConfig.corsOrigins?.length ? injectedConfig.corsOrigins : (process.env.NODE_ENV === 'production' ? false : true), methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['content-type', 'authorization', 'x-telegram-bot-api-secret-token'] }));
  app.use((req, res, next) => { res.setHeader('cache-control', 'no-store'); next(); });
  app.get('/health', async (_req, res) => { try { await store.health(); await vault.checkPaths(injectedConfig); return res.json({ ok: true, service: 'taxflow-intake', database: 'ok', vault: 'ok' }); } catch (error) { return res.status(503).json({ ok: false, service: 'taxflow-intake', error: error.message || 'dependency_unavailable' }); } });
  const requireApiAuth = (req, res, next) => {
    if (!injectedConfig.apiToken) return next();
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || token !== injectedConfig.apiToken) return res.sendStatus(401);
    return next();
  };
  const routeOnlyWhenVaultIsReady = (route) => route.status === 'routed' && !vault.storageAvailable(injectedConfig)
    ? { ...route, status: 'quarantine', reason: 'vault_not_configured' }
    : route;

  app.get('/api/v1/integrations/whatsapp/webhook', (req, res) => {
    if (req.query['hub.verify_token'] !== process.env.WHATSAPP_VERIFY_TOKEN) return res.sendStatus(403);
    return res.status(200).send(req.query['hub.challenge'] || '');
  });

  app.post('/api/v1/integrations/whatsapp/webhook', rawBody(injectedConfig.maxUploadBytes), async (req, res, next) => {
    try {
      if (injectedConfig.requireWebhookSecrets && (!injectedConfig.webhookSecret || !require('./security').verifyWhatsAppSignature(req.rawPayload, req.headers['x-hub-signature-256'], injectedConfig.webhookSecret))) return res.sendStatus(401);
      const payload = req.payload;
      const messages = payload.messages || payload.entry?.flatMap((entry) => entry.changes?.flatMap((change) => change.value?.messages || []) || []) || [];
      const created = [];
      for (const message of messages) {
        const media = message.media || message.document || message.image || message.file;
        if (!media) continue;
        const eventId = String(message.id || `${payload.id || 'whatsapp'}:${message.timestamp || Date.now()}`);
        if (await store.findIntake('whatsapp', eventId)) continue;
        const bytes = await downloadWhatsAppMedia(media, injectedConfig);
        if (!bytes || bytes.length > injectedConfig.maxUploadBytes) throw new Error('media_missing_or_too_large');
        const spool = await vault.saveSpool(injectedConfig, eventId.replace(/[^a-zA-Z0-9_-]/g, '_'), media.filename || media.name || 'inbound-file', bytes);
        const clients = store.getClients ? await store.getClients() : store.clients;
        const route = routeOnlyWhenVaultIsReady(resolveRoute({ sender: message.from, clientId: message.client_id, year: message.year, month: message.month }, clients));
        const intake = await store.addIntake({ firmId: injectedConfig.firmId, provider: 'whatsapp', providerEventId: eventId, sender: message.from, filename: spool.filename, mimeType: media.mime_type || media.mimetype || 'application/octet-stream', checksum: spool.checksum, bytes: spool.bytes, spoolPath: spool.path, route, status: route.status === 'routed' ? 'raw_persisted' : 'received' });
        if (intake.duplicate) { created.push(intake); continue; }
        const raw = route.status === 'routed' ? await vault.publishRaw(injectedConfig, route, spool.filename, bytes) : null;
        const document = await store.addDocument({ firmId: injectedConfig.firmId, intakeId: intake.id, clientId: route.clientId, clientName: route.clientName, year: route.year, month: route.month, documentType: media.document_type || 'unknown', filename: spool.filename, mimeType: intake.mimeType, rawChecksum: intake.checksum, spoolPath: spool.path, rawVaultPath: raw?.relativePath, status: route.status === 'routed' ? 'raw_persisted' : 'quarantined' });
        if (document.status === 'raw_persisted') setImmediate(() => void processExtraction(document.id).catch(() => {}));
        created.push(intake);
      }
      return res.status(202).json({ accepted: true, intake: created.map(({ id, status, route }) => ({ id, status, route })) });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/integrations/telegram/webhook', rawBody(injectedConfig.maxUploadBytes), async (req, res, next) => {
    try {
      if (!require('./security').verifyTelegramSecret(req.headers['x-telegram-bot-api-secret-token'], injectedConfig.telegramWebhookSecret)) return res.sendStatus(401);
      const update = req.payload || {};
      const message = update.message || update.edited_message || update.channel_post;
      if (!message) return res.status(202).json({ accepted: true, ignored: 'unsupported_update' });
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (text.startsWith('/start')) {
        const token = text.replace(/^\/start(?:@[^\s]+)?\s*/i, '').trim();
        if (!token) return res.status(202).json({ accepted: true, ignored: 'start_without_link_token' });
        if (message.chat?.type !== 'private' || !message.from?.id || !message.chat?.id) return res.status(202).json({ accepted: true, ignored: 'telegram_link_requires_private_chat' });
        const linked = await store.claimTelegramLink(token, message.from.id, message.chat.id);
        if (!linked) return res.status(202).json({ accepted: true, linked: false, reason: 'invalid_or_expired_link' });
        await sendTelegramMessage(injectedConfig, message.chat.id, `Your Telegram account is now connected to Taxflow for ${linked.name}. You can receive approved messages here.`);
        await store.addAuditEvent({ entityType: 'client', entityId: linked.id, action: 'telegram_account_linked', afterValue: { telegramUserId: String(message.from.id), telegramChatId: String(message.chat.id) } });
        return res.status(202).json({ accepted: true, linked: true, clientId: linked.id });
      }
      const media = message.document || (Array.isArray(message.photo) ? message.photo.at(-1) : null);
      if (!media) return res.status(202).json({ accepted: true, ignored: 'message_without_file' });
      const eventId = `telegram:${String(update.update_id ?? message.message_id ?? Date.now())}`;
      if (await store.findIntake('telegram', eventId)) return res.status(202).json({ accepted: true, duplicate: true });
      const bytes = await downloadTelegramMedia(media, injectedConfig);
      if (!bytes || bytes.length > injectedConfig.maxUploadBytes) throw new Error('telegram_media_missing_or_too_large');
      const filename = media.file_name || `telegram_${media.file_unique_id || media.file_id}.jpg`;
      const spool = await vault.saveSpool(injectedConfig, eventId.replace(/[^a-zA-Z0-9_-]/g, '_'), filename, bytes);
      const sender = message.from?.username ? `@${message.from.username}` : String(message.from?.id || message.chat?.id || 'telegram');
      const clients = store.getClients ? await store.getClients() : store.clients;
      const route = routeOnlyWhenVaultIsReady(resolveRoute({ sender, ...intakeHints(message) }, clients));
      const intake = await store.addIntake({ firmId: injectedConfig.firmId, provider: 'telegram', providerEventId: eventId, sender, filename: spool.filename, mimeType: media.mime_type || 'application/octet-stream', checksum: spool.checksum, bytes: spool.bytes, spoolPath: spool.path, route, status: route.status === 'routed' ? 'raw_persisted' : 'received' });
      if (intake.duplicate) return res.status(202).json({ accepted: true, duplicate: true });
      const raw = route.status === 'routed' ? await vault.publishRaw(injectedConfig, route, spool.filename, bytes) : null;
      const document = await store.addDocument({ firmId: injectedConfig.firmId, intakeId: intake.id, clientId: route.clientId, clientName: route.clientName, year: route.year, month: route.month, documentType: 'unknown', filename: spool.filename, mimeType: intake.mimeType, rawChecksum: intake.checksum, spoolPath: spool.path, rawVaultPath: raw?.relativePath, status: route.status === 'routed' ? 'raw_persisted' : 'quarantined' });
      if (document.status === 'raw_persisted') setImmediate(() => void processExtraction(document.id).catch(() => {}));
      return res.status(202).json({ accepted: true, intake: [{ id: intake.id, status: intake.status, route: intake.route }] });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/integrations/email/inbound', rawBody(injectedConfig.maxUploadBytes), async (req, res, next) => {
    try {
      if (injectedConfig.requireWebhookSecrets && (!injectedConfig.emailWebhookSecret || !require('./security').verifySecret(req.headers['x-email-signature'], injectedConfig.emailWebhookSecret))) return res.sendStatus(401);
      const payload = req.payload; const created = [];
      for (const attachment of payload.attachments || []) {
        const eventId = String(attachment.event_id || `${payload.message_id || 'email'}:${attachment.filename}`);
        if (await store.findIntake('email', eventId)) continue;
        const bytes = attachment.base64 ? Buffer.from(attachment.base64, 'base64') : attachment.content ? Buffer.from(attachment.content, 'base64') : null;
        if (!bytes || bytes.length > injectedConfig.maxUploadBytes) throw new Error('attachment_missing_or_too_large');
        const spool = await vault.saveSpool(injectedConfig, eventId.replace(/[^a-zA-Z0-9_-]/g, '_'), attachment.filename || 'email-attachment', bytes);
        const clients = store.getClients ? await store.getClients() : store.clients;
        const route = routeOnlyWhenVaultIsReady(resolveRoute({ sender: payload.from, clientId: payload.client_id, year: payload.year, month: payload.month }, clients));
        const intake = await store.addIntake({ firmId: injectedConfig.firmId, provider: 'email', providerEventId: eventId, sender: payload.from, filename: spool.filename, mimeType: attachment.mime_type || 'application/octet-stream', checksum: spool.checksum, bytes: spool.bytes, spoolPath: spool.path, route, status: route.status === 'routed' ? 'raw_persisted' : 'received' });
        if (intake.duplicate) { created.push(intake); continue; }
        const raw = route.status === 'routed' ? await vault.publishRaw(injectedConfig, route, spool.filename, bytes) : null;
        const document = await store.addDocument({ firmId: injectedConfig.firmId, intakeId: intake.id, clientId: route.clientId, clientName: route.clientName, year: route.year, month: route.month, documentType: attachment.document_type || 'unknown', filename: spool.filename, mimeType: intake.mimeType, rawChecksum: intake.checksum, spoolPath: spool.path, rawVaultPath: raw?.relativePath, status: route.status === 'routed' ? 'raw_persisted' : 'quarantined' });
        if (document.status === 'raw_persisted') setImmediate(() => void processExtraction(document.id).catch(() => {}));
        created.push(intake);
      }
      return res.status(202).json({ accepted: true, intake: created.map(({ id, status, route }) => ({ id, status, route })) });
    } catch (error) { return next(error); }
  });

  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/intake', requireApiAuth);
  app.use('/api/v1/documents', requireApiAuth);
  app.use('/api/v1/clients', requireApiAuth);
  app.use('/api/v1/communications', requireApiAuth);
  app.use('/api/v1/integrations', requireApiAuth);

  app.get('/api/v1/clients', async (_req, res, next) => { try { return res.json({ items: await store.getClients() }); } catch (error) { return next(error); } });
  app.post('/api/v1/clients/:id/telegram-link', async (req, res, next) => { try { const client = await store.getClient(req.params.id); if (!client) return res.sendStatus(404); const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); const link = await store.createTelegramLink(req.params.id, String(req.body?.createdBy || 'reviewer'), expiresAt); if (!link) return res.sendStatus(404); const bot = await getTelegramBot(injectedConfig); return res.status(201).json({ clientId: client.id, expiresAt: link.expiresAt, link: `https://t.me/${bot.username}?start=${encodeURIComponent(link.token)}` }); } catch (error) { return next(error); } });
  app.get('/api/v1/integrations/telegram/status', async (_req, res, next) => { try { const bot = await getTelegramBot(injectedConfig); return res.json({ connected: true, bot: { id: bot.id, username: bot.username, name: bot.first_name } }); } catch (error) { return res.status(503).json({ connected: false, error: 'telegram_provider_unavailable' }); } });
  app.get('/api/v1/communications/schedules', async (_req, res, next) => { try { return res.json({ items: await store.listSchedules() }); } catch (error) { return next(error); } });
  app.post('/api/v1/communications/schedules', async (req, res, next) => { try { const clientId = String(req.body?.clientId || ''); const channel = String(req.body?.channel || ''); const template = String(req.body?.template || '').trim(); const scheduledFor = String(req.body?.scheduledFor || ''); const body = String(req.body?.body || '').trim(); const client = await store.getClient(clientId); const telegramReady = channel !== 'telegram' || Boolean(client?.telegramChatId); if (!client || !['whatsapp', 'email', 'telegram'].includes(channel) || !template || !body || body.length > 4000 || Number.isNaN(Date.parse(scheduledFor)) || req.body?.consentRecorded !== true || !telegramReady) return res.status(422).json({ error: !telegramReady ? 'telegram_client_not_linked' : 'invalid_communication_schedule' }); const schedule = await store.addSchedule({ firmId: injectedConfig.firmId, clientId, channel, template, body, payload: { body }, scheduledFor: new Date(scheduledFor).toISOString(), consentRecorded: true, createdBy: String(req.body?.createdBy || 'reviewer') }); await store.addAuditEvent({ entityType: 'communication_schedule', entityId: schedule.id, action: 'message_drafted', afterValue: { clientId, channel, template, scheduledFor: schedule.scheduledFor, consentRecorded: true } }); return res.status(201).json({ schedule }); } catch (error) { return next(error); } });
  app.post('/api/v1/communications/schedules/:id/approve', async (req, res, next) => { try { const schedule = await store.getSchedule(req.params.id); if (!schedule) return res.sendStatus(404); if (schedule.status !== 'awaiting_approval') return res.status(409).json({ error: 'schedule_not_awaiting_approval' }); const approvedBy = String(req.body?.approvedBy || 'reviewer'); const approved = await store.approveSchedule(req.params.id, approvedBy); if (!approved) return res.status(409).json({ error: 'schedule_already_processed' }); await store.addAuditEvent({ entityType: 'communication_schedule', entityId: schedule.id, action: 'message_approved', beforeValue: { status: 'awaiting_approval' }, afterValue: { status: 'approved', approvedBy, outboundStatus: 'approved' } }); return res.json({ ok: true, ...approved, sending: schedule.channel === 'telegram', notice: schedule.channel === 'telegram' ? 'Approved and queued for Telegram delivery.' : 'Approved and queued. Provider delivery is not enabled yet.' }); } catch (error) { return next(error); } });

  const deliverOutbound = async () => {
    try {
      const due = await store.listDueOutbound();
      for (const candidate of due) {
        const message = await store.claimOutbound(candidate.id);
        if (!message) continue;
        if (message.channel !== 'telegram') continue;
        const chatId = message.telegram_chat_id || store.getClient && (await store.getClient(message.client_id || message.clientId))?.telegramChatId;
        if (!chatId) { await store.completeOutbound(message.id, { error: 'telegram_client_not_linked' }); continue; }
        try { const sent = await sendTelegramMessage(injectedConfig, chatId, message.body); await store.completeOutbound(message.id, { status: 'sent', providerMessageId: String(sent.message_id) }); }
        catch (error) { await store.completeOutbound(message.id, { error: error.message || 'telegram_delivery_failed' }); }
      }
    } catch (error) { console.error('Telegram outbound worker failed', error.message || error); }
  };
  const outboundTimer = setInterval(() => void deliverOutbound(), 2000); outboundTimer.unref?.();

  const processExtraction = async (documentId) => {
    const document = await store.getDocument(documentId);
    if (!document || document.status === 'quarantined' || document.status === 'approved') return;
    try {
      await store.updateDocument(document.id, { status: 'extracting' });
      await store.updateIntake(document.intakeId, { status: 'extracting' });
      const bytes = await vault.readSpoolFile(injectedConfig, document.spoolPath);
      const data = await extractor.extractWithGemini({ bytes, mimeType: document.mimeType, documentType: document.documentType, apiKey: injectedConfig.geminiApiKey, model: injectedConfig.geminiModel });
      const revision = await store.addRevision({ firmId: injectedConfig.firmId, documentId: document.id, rawChecksum: document.rawChecksum, schemaVersion: 'invoice.v1', provider: injectedConfig.geminiModel, data, findings: extractor.deterministicFindings(data), actor: 'system' });
      await store.updateDocument(document.id, { status: 'awaiting_review', currentRevision: revision.revision });
      await store.updateIntake(document.intakeId, { status: 'awaiting_review' });
      return revision;
    } catch (error) {
      await store.updateDocument(document.id, { status: 'failed' });
      await store.updateIntake(document.intakeId, { status: 'failed' });
      throw error;
    }
  };

  app.get('/api/v1/intake/events', async (_req, res, next) => { try { const items = await store.listPending(); return res.json({ items: items.map((item) => ({ ...item, spoolPath: undefined })) }); } catch (error) { return next(error); } });
  app.get('/api/v1/intake/events/:id/content', async (req, res, next) => { try { const item = await store.getIntake(req.params.id); if (!item) return res.sendStatus(404); const bytes = await vault.readSpoolFile(injectedConfig, item.spoolPath); res.type(item.mimeType).send(bytes); } catch (error) { next(error); } });
  app.post('/api/v1/intake/events/:id/ack', async (req, res, next) => { try { const item = await store.getIntake(req.params.id); if (!item) return res.sendStatus(404); if (!req.body?.checksum || req.body.checksum !== item.checksum) return res.status(422).json({ error: 'raw_checksum_mismatch' }); const row = await store.updateIntake(req.params.id, { status: 'acked', localPath: req.body.localPath, localChecksum: req.body.checksum }); const document = await store.getDocumentByIntake(req.params.id); if (document && document.status === 'raw_persisted') setImmediate(() => void processExtraction(document.id).catch(() => {})); return res.json({ ok: true, intake: row }); } catch (error) { return next(error); } });
  app.post('/api/v1/intake/events/:id/route', async (req, res, next) => { try { const clientId = String(req.body?.clientId || ''); const year = Number(req.body?.year); const month = Number(req.body?.month); const clients = store.getClients ? await store.getClients() : store.clients; const client = clients.find((candidate) => String(candidate.id) === clientId); if (!client || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return res.status(422).json({ error: 'invalid_manual_route' }); if (!vault.storageAvailable(injectedConfig)) return res.status(503).json({ error: 'vault_not_configured' }); const item = await store.getIntake(req.params.id); if (!item) return res.sendStatus(404); const existing = await store.getDocumentByIntake(req.params.id); const route = { status: 'routed', clientId, clientName: client.name, year, month }; const bytes = await vault.readSpoolFile(injectedConfig, item.spoolPath); const raw = existing?.rawVaultPath ? { relativePath: existing.rawVaultPath } : await vault.publishRaw(injectedConfig, route, item.filename, bytes); const routed = await store.routeIntake(req.params.id, route); if (routed.document) { await store.updateDocument(routed.document.id, { rawVaultPath: raw.relativePath }); routed.document.rawVaultPath = raw.relativePath; setImmediate(() => void processExtraction(routed.document.id).catch(() => {})); } return res.json({ ok: true, ...routed }); } catch (error) { return next(error); } });

  app.get('/api/v1/documents', async (_req, res, next) => { try { const documents = await store.listDocuments(); return res.json({ items: await Promise.all(documents.map(async (document) => ({ ...document, revision: await store.latestRevision(document.id) }))) }); } catch (error) { return next(error); } });
  app.get('/api/v1/documents/:id/raw', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); if (!document) return res.sendStatus(404); let bytes; try { bytes = await vault.readSpoolFile(injectedConfig, document.spoolPath); } catch (spoolError) { if (!document.rawVaultPath) throw spoolError; bytes = await vault.readVaultFile(injectedConfig, document.rawVaultPath); } res.type(document.mimeType).send(bytes); } catch (error) { next(error); } });
  app.get('/api/v1/documents/:id/review', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); if (!document) return res.sendStatus(404); return res.json({ document, revision: await store.latestRevision(document.id) }); } catch (error) { return next(error); } });
  app.post('/api/v1/documents/:id/extract', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); if (!document) return res.sendStatus(404); const revision = await processExtraction(document.id); return res.status(201).json({ document: await store.getDocument(document.id), revision }); } catch (error) { return next(error); } });
  app.patch('/api/v1/documents/:id/revisions/:revisionId', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); const current = await store.latestRevision(req.params.id); if (!document || !current || current.id !== req.params.revisionId) return res.status(409).json({ error: 'stale_revision' }); const data = extractor.validateExtraction(req.body.data); const revision = await store.addRevisionFrom({ ...current, findings: extractor.deterministicFindings(data) }, data, req.body.actor || 'reviewer'); document.currentRevisionId = revision.id; document.status = 'awaiting_review'; await store.updateDocument(document.id, { status: 'awaiting_review', currentRevision: revision.revision }); return res.status(201).json({ document, revision }); } catch (error) { next(error); } });
  app.post('/api/v1/documents/:id/approve', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); const current = await store.latestRevision(req.params.id); if (!document || !current) return res.sendStatus(404); if (req.body.revisionId !== current.id) return res.status(409).json({ error: 'stale_revision' }); if (document.status !== 'awaiting_review') return res.status(409).json({ error: 'document_not_awaiting_review' }); if ((current.findings || []).some((finding) => finding.severity === 'blocking')) return res.status(422).json({ error: 'blocking_validation_errors' }); if ((current.findings || []).some((finding) => finding.severity === 'warning') && req.body.warningsAcknowledged !== true) return res.status(422).json({ error: 'warnings_must_be_acknowledged' }); const reviewerId = req.body.reviewerId || 'reviewer'; document.status = 'awaiting_publication'; await store.updateDocument(document.id, { status: 'awaiting_publication' }); await store.addAuditEvent({ entityType: 'document', entityId: document.id, action: 'review_approved_for_publication', beforeValue: { status: 'awaiting_review', revisionId: current.id }, afterValue: { status: 'awaiting_publication', revisionId: current.id, reviewerId } }); return res.json({ ok: true, publicationRequired: true, document, revision: current }); } catch (error) { next(error); } });
  app.post('/api/v1/documents/:id/publish-ack', async (req, res, next) => { try { const document = await store.getDocument(req.params.id); const current = await store.latestRevision(req.params.id); if (!document || !current || req.body.revisionId !== current.id) return res.status(409).json({ error: 'stale_revision' }); if (document.status !== 'awaiting_publication') return res.status(409).json({ error: 'document_not_awaiting_publication' }); const existing = await store.findArtifact(document.id, current.id); if (existing) return res.json({ ok: true, idempotent: true, artifact: existing, document, revision: current }); const artifact = Buffer.from(JSON.stringify({ schema_version: 'taxflow.extraction.v1', document_id: document.id, revision_id: current.id, revision: current.revision, source_document_checksum: document.rawChecksum, data: current.data, findings: current.findings || [] }, null, 2)); const route = { clientId: document.clientId, clientName: document.clientName || document.clientId, year: document.year, month: document.month }; const published = await vault.publishApproved(injectedConfig, route, `${document.id}-revision-${current.revision}.json`, artifact, 'Extracted'); const reviewerId = req.body.reviewerId || 'reviewer'; await store.addArtifact({ documentId: document.id, revisionId: current.id, path: published.relativePath, checksum: published.checksum, schemaVersion: 'taxflow.extraction.v1' }); await store.addApproval({ documentId: document.id, revisionId: current.id, reviewerId, rawChecksum: document.rawChecksum, artifactChecksum: published.checksum, localPath: published.relativePath }); await store.updateRevision(current.id, { status: 'approved' }); document.status = 'approved'; await store.updateDocument(document.id, { status: 'approved' }); await store.updateIntake(document.intakeId, { status: 'approved' }); await store.addAuditEvent({ entityType: 'document', entityId: document.id, action: 'artifact_published_and_approved', beforeValue: { status: 'awaiting_publication', revisionId: current.id }, afterValue: { status: 'approved', revisionId: current.id, artifactPath: published.relativePath, artifactChecksum: published.checksum, reviewerId } }); return res.json({ ok: true, artifact: { path: published.relativePath, checksum: published.checksum }, document, revision: { ...current, status: 'approved' } }); } catch (error) { next(error); } });

  app.use((error, _req, res, _next) => { console.error(error); res.status(error.statusCode || 500).json({ error: error.message || 'internal_error' }); });
  return app;
}

module.exports = { createApp };
