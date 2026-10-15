const crypto = require('node:crypto');

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function hashToken(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

class MemoryStore {
  constructor() {
    this.intakes = new Map(); this.documents = new Map(); this.revisions = new Map(); this.approvals = []; this.artifacts = new Map(); this.auditEvents = []; this.schedules = new Map(); this.outbox = new Map();
    this.clients = [
      { id: 'sharma', name: 'Sharma Traders', aliases: ['sharma', '+91 98100 00101'] },
      { id: 'mehta', name: 'Mehta Textiles Pvt Ltd', aliases: ['mehta', '+91 98250 00102'] },
      { id: 'iyer', name: 'Iyer & Sons Pharma', aliases: ['iyer', '+91 98400 00103'] },
      { id: 'nova', name: 'Nova Digital FZ-LLC', aliases: ['nova', '+971 50 000 0106'] },
      { id: 'kapoor', name: 'Kapoor Jewellers', aliases: ['kapoor', '+91 98290 00108'] },
    ];
  }
  findIntake(provider, eventId) { return [...this.intakes.values()].find((x) => x.provider === provider && x.providerEventId === eventId); }
  addIntake(value) { const row = { id: id('int'), status: 'received', createdAt: new Date().toISOString(), ...value }; this.intakes.set(row.id, row); return row; }
  listPending() { return [...this.intakes.values()].filter((x) => x.status !== 'acked' || x.route?.status === 'quarantine').sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  updateIntake(idValue, patch) { const row = this.intakes.get(idValue); if (!row) throw new Error('Intake not found'); Object.assign(row, patch); return row; }
  getIntake(idValue) { return this.intakes.get(idValue); }
  addDocument(value) { const row = { id: id('doc'), status: 'raw_persisted', createdAt: new Date().toISOString(), ...value }; this.documents.set(row.id, row); return row; }
  getDocument(idValue) { return this.documents.get(idValue); }
  getDocumentByIntake(intakeId) { return [...this.documents.values()].find((row) => row.intakeId === intakeId); }
  routeIntake(idValue, route) { const intake = this.intakes.get(idValue); if (!intake) throw new Error('Intake not found'); intake.route = route; intake.status = 'raw_persisted'; const document = this.getDocumentByIntake(idValue); if (document) Object.assign(document, { clientId: route.clientId, clientName: route.clientName, year: route.year, month: route.month, status: 'raw_persisted' }); return { intake, document }; }
  updateDocument(idValue, patch) { const row = this.documents.get(idValue); if (!row) throw new Error('Document not found'); Object.assign(row, patch); return row; }
  listDocuments() { return [...this.documents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getClients() { return this.clients.map((client) => ({ ...client })); }
  getClient(idValue) { return this.clients.find((client) => client.id === idValue) || null; }
  createTelegramLink(clientId, createdBy, expiresAt) { const token = crypto.randomBytes(32).toString('base64url'); this.telegramLinks ||= new Map(); this.telegramLinks.set(hashToken(token), { clientId, expiresAt, createdBy }); return { token, expiresAt }; }
  claimTelegramLink(token, telegramUserId, telegramChatId) { const link = this.telegramLinks?.get(hashToken(token)); if (!link || new Date(link.expiresAt) <= new Date()) return null; this.telegramLinks.delete(hashToken(token)); const client = this.getClient(link.clientId); if (!client) return null; client.telegramUserId = String(telegramUserId); client.telegramChatId = String(telegramChatId); client.telegramLinkedAt = new Date().toISOString(); client.telegramConsentAt = client.telegramLinkedAt; return client; }
  health() { return true; }
  addRevision(value) { const row = { id: id('rev'), revision: 1, status: 'awaiting_review', createdAt: new Date().toISOString(), ...value }; this.revisions.set(row.id, row); return row; }
  latestRevision(documentId) { return [...this.revisions.values()].filter((x) => x.documentId === documentId).sort((a, b) => b.revision - a.revision)[0]; }
  addRevisionFrom(previous, data, actor) { return this.addRevision({ ...previous, id: id('rev'), revision: previous.revision + 1, data, actor, createdAt: new Date().toISOString(), status: 'awaiting_review' }); }
  updateRevision(idValue, patch) { const row = this.revisions.get(idValue); if (!row) throw new Error('Revision not found'); Object.assign(row, patch); return row; }
  addApproval(value) { this.approvals.push({ id: id('approval'), createdAt: new Date().toISOString(), ...value }); return this.approvals.at(-1); }
  addArtifact(value) { const row = { id: id('artifact'), createdAt: new Date().toISOString(), ...value }; this.artifacts.set(row.id, row); return row; }
  findArtifact(documentId, revisionId) { return [...this.artifacts.values()].find((row) => row.documentId === documentId && row.revisionId === revisionId); }
  addAuditEvent(value) { const row = { id: id('audit'), createdAt: new Date().toISOString(), ...value }; this.auditEvents.push(row); return row; }
  addSchedule(value) { const row = { id: id('schedule'), status: 'awaiting_approval', createdAt: new Date().toISOString(), ...value }; this.schedules.set(row.id, row); return row; }
  listSchedules() { return [...this.schedules.values()].sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor))); }
  getSchedule(idValue) { return this.schedules.get(idValue) || null; }
  approveSchedule(idValue, approvedBy) { const row = this.schedules.get(idValue); if (!row) return null; row.status = 'approved'; row.approvedBy = approvedBy; const message = { id: id('outbox'), scheduleId: row.id, firmId: row.firmId, clientId: row.clientId, channel: row.channel, body: row.body, status: 'approved', approvedBy, approvedAt: new Date().toISOString(), attempts: 0 }; this.outbox.set(message.id, message); return { schedule: row, message }; }
  listDueOutbound() { return [...this.outbox.values()].filter((row) => { const schedule = this.schedules.get(row.scheduleId); return row.channel === 'telegram' && schedule && new Date(schedule.scheduledFor) <= new Date() && (row.status === 'approved' || (row.status === 'sending' && new Date(row.sendingStartedAt || 0).getTime() < Date.now() - 120000)); }); }
  claimOutbound(idValue) { const row = this.outbox.get(idValue); if (!row || !['approved', 'sending'].includes(row.status)) return null; row.status = 'sending'; row.sendingStartedAt = new Date().toISOString(); row.attempts = Number(row.attempts || 0) + 1; return row; }
  completeOutbound(idValue, result) { const row = this.outbox.get(idValue); if (!row) return null; Object.assign(row, result); return row; }
}

class PgStore {
  constructor(databaseUrl, firmId, clientUserId) { const { Pool } = require('pg'); this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30000 }); this.firmId = firmId; this.clientUserId = clientUserId; }
  async query(sql, params = []) { const client = await this.pool.connect(); try { await client.query("select set_config('app.firm_id', $1, true)", [this.firmId]); return await client.query(sql, params); } finally { client.release(); } }
  async health() { const result = await this.query('select 1 as ok'); return result.rows[0]?.ok === 1; }
  async findIntake(provider, eventId) { const result = await this.query('select * from taxflow_intake_events where provider=$1 and provider_event_id=$2', [provider, eventId]); return result.rows[0] || null; }
  async addIntake(v) { const result = await this.query('insert into taxflow_intake_events (firm_id,provider,provider_event_id,sender,filename,mime_type,byte_size,sha256,spool_object_key,route_status,route_reason,client_id,period_year,period_month,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict (provider,provider_event_id) do nothing returning *', [v.firmId,v.provider,v.providerEventId,v.sender,v.filename,v.mimeType,v.bytes,v.checksum,v.spoolPath,v.route.status,v.route.reason||null,v.route.clientId||null,v.route.year||null,v.route.month||null,v.status||'received']); if (!result.rows[0]) return { ...(await this.findIntake(v.provider, v.providerEventId)), duplicate: true }; return this.intakeRow(result.rows[0], v); }
  intakeRow(row, original = {}) { return { ...row, id: String(row.id), route: original.route || { status: row.route_status, reason: row.route_reason, clientId: row.client_id, year: row.period_year, month: row.period_month }, spoolPath: row.spool_object_key || original.spoolPath, mimeType: row.mime_type || original.mimeType, bytes: Number(row.byte_size || original.bytes), checksum: row.sha256 || original.checksum }; }
  async listPending() { const result = await this.query("select * from taxflow_intake_events where status <> 'acked' or route_status='quarantine' order by created_at asc"); return result.rows.map((row) => this.intakeRow(row)); }
  async getIntake(idValue) { const result = await this.query('select * from taxflow_intake_events where id=$1', [idValue]); return result.rows[0] ? this.intakeRow(result.rows[0]) : null; }
  async updateIntake(idValue, patch) { const result = await this.query('update taxflow_intake_events set status=coalesce($2,status),updated_at=now() where id=$1 returning *', [idValue, patch.status || null]); return result.rows[0]; }
  async routeIntake(idValue, route) { const result = await this.query('update taxflow_intake_events set route_status=\'routed\',route_reason=null,client_id=$2,period_year=$3,period_month=$4,updated_at=now() where id=$1 returning *', [idValue, route.clientId, route.year, route.month]); await this.query('update taxflow_documents set client_id=$2,status=\'raw_persisted\',updated_at=now() where intake_event_id=$1', [idValue, route.clientId]); return { intake: this.intakeRow(result.rows[0], { route }), document: await this.getDocumentByIntake(idValue) }; }
  async getClients() {
    if (!this.clientUserId) throw new Error('TAXFLOW_CLIENT_USER_ID is required for database client access');
    const result = await this.query(`select id::text as id, name,
      nullif(telegram_username, '') as \"telegramUsername\",
      nullif(telegram_user_id, '') as \"telegramUserId\",
      nullif(telegram_chat_id, '') as \"telegramChatId\",
      telegram_linked_at as \"telegramLinkedAt\",
      telegram_consent_at as \"telegramConsentAt\",
      array_remove(array[
        nullif(name, ''), nullif(phone, ''), nullif(email, ''),
        nullif(pan, ''), nullif(gstin, '')
      ]::text[], null) as aliases
      from public.clients
      where user_id=$1
      order by name`, [this.clientUserId]);
    return result.rows;
  }
  async getClient(idValue) {
    if (!this.clientUserId) throw new Error('TAXFLOW_CLIENT_USER_ID is required for database client access');
    const result = await this.query(`select id::text as id, name,
      nullif(telegram_username, '') as \"telegramUsername\",
      nullif(telegram_user_id, '') as \"telegramUserId\",
      nullif(telegram_chat_id, '') as \"telegramChatId\",
      telegram_linked_at as \"telegramLinkedAt\",
      telegram_consent_at as \"telegramConsentAt\",
      array_remove(array[
        nullif(name, ''), nullif(phone, ''), nullif(email, ''),
        nullif(pan, ''), nullif(gstin, '')
      ]::text[], null) as aliases
      from public.clients
      where id=$1::uuid and user_id=$2`, [idValue, this.clientUserId]);
    return result.rows[0] || null;
  }
  documentRow(row) { return row ? { ...row, id: String(row.id), intakeId: String(row.intake_event_id), clientId: row.client_id, documentType: row.document_type, filename: row.raw_filename, rawChecksum: row.raw_sha256, rawVaultPath: row.raw_vault_path, status: row.status, currentRevisionId: row.current_revision ? String(row.current_revision) : undefined, spoolPath: row.spool_object_key, mimeType: row.mime_type } : null; }
  async addDocument(v) { const result = await this.query('insert into taxflow_documents (firm_id,intake_event_id,client_id,document_type,raw_filename,raw_sha256,raw_vault_path,status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *', [v.firmId,v.intakeId,v.clientId||null,v.documentType,v.filename,v.rawChecksum,v.rawVaultPath||null,v.status]); return { ...v, ...this.documentRow(result.rows[0]) }; }
  async getDocument(idValue) { const result = await this.query('select d.*,e.spool_object_key,e.mime_type,e.period_year as year,e.period_month as month,c.name as client_name from taxflow_documents d join taxflow_intake_events e on e.id=d.intake_event_id left join public.clients c on c.id=d.client_id where d.id=$1', [idValue]); return this.documentRow(result.rows[0]); }
  async getDocumentByIntake(intakeId) { const result = await this.query('select d.*,e.spool_object_key,e.mime_type,e.period_year as year,e.period_month as month,c.name as client_name from taxflow_documents d join taxflow_intake_events e on e.id=d.intake_event_id left join public.clients c on c.id=d.client_id where d.intake_event_id=$1', [intakeId]); return this.documentRow(result.rows[0]); }
  async listDocuments() { const result = await this.query('select d.*,e.spool_object_key,e.mime_type,e.period_year as year,e.period_month as month,c.name as client_name from taxflow_documents d join taxflow_intake_events e on e.id=d.intake_event_id left join public.clients c on c.id=d.client_id order by d.created_at desc'); return result.rows.map((row) => this.documentRow(row)); }
  async updateDocument(idValue, patch) { const result = await this.query('update taxflow_documents set status=coalesce($2,status),current_revision=coalesce($3,current_revision),raw_vault_path=coalesce($4,raw_vault_path),updated_at=now() where id=$1 returning *', [idValue,patch.status||null,patch.currentRevision||null,patch.rawVaultPath||null]); return result.rows[0]; }
  revisionRow(row, original = {}) { return row ? { ...original, ...row, id: String(row.id), documentId: String(row.document_id), revision: row.revision, data: row.payload, findings: row.findings } : null; }
  async addRevision(v) { const result = await this.query('insert into taxflow_extraction_revisions (firm_id,document_id,revision,schema_version,provider,payload,findings,status,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *', [v.firmId || this.firmId,v.documentId,v.revision||1,v.schemaVersion,v.provider||null,JSON.stringify(v.data),JSON.stringify(v.findings||[]),v.status||'awaiting_review',v.actor||'system']); return this.revisionRow(result.rows[0], v); }
  async latestRevision(documentId) { const result = await this.query('select * from taxflow_extraction_revisions where document_id=$1 order by revision desc limit 1', [documentId]); return this.revisionRow(result.rows[0]); }
  async addRevisionFrom(previous, data, actor) { return this.addRevision({ ...previous, revision: previous.revision + 1, data, actor, status: 'awaiting_review' }); }
  async updateRevision(idValue, patch) { const result = await this.query('update taxflow_extraction_revisions set status=$2 where id=$1 returning *', [idValue, patch.status]); return this.revisionRow(result.rows[0]); }
  async addApproval(v) { const result = await this.query("insert into taxflow_review_decisions (firm_id,document_id,revision_id,reviewer_id,decision,approved_checksum,notes) values ($1,$2,$3,$4,'approved',$5,$6) returning *", [this.firmId,v.documentId,v.revisionId,v.reviewerId||null,v.artifactChecksum||v.rawChecksum,v.localPath||null]); return result.rows[0]; }
  async addArtifact(v) { const result = await this.query('insert into taxflow_approved_artifacts (firm_id,document_id,revision_id,path,checksum,schema_version) values ($1,$2,$3,$4,$5,$6) returning *', [this.firmId,v.documentId,v.revisionId,v.path,v.checksum,v.schemaVersion]); return result.rows[0]; }
  async findArtifact(documentId, revisionId) { const result = await this.query('select * from taxflow_approved_artifacts where document_id=$1 and revision_id=$2 limit 1', [documentId, revisionId]); return result.rows[0] || null; }
  async addAuditEvent(v) { const result = await this.query('insert into taxflow_audit_events (firm_id,actor_id,entity_type,entity_id,action,before_value,after_value) values ($1,$2,$3,$4,$5,$6,$7) returning *', [this.firmId,v.actorId||null,v.entityType,v.entityId,v.action,v.beforeValue?JSON.stringify(v.beforeValue):null,v.afterValue?JSON.stringify(v.afterValue):null]); return result.rows[0]; }
  async createTelegramLink(clientId, createdBy, expiresAt) { const token = crypto.randomBytes(32).toString('base64url'); const client = await this.getClient(clientId); if (!client) return null; await this.query('insert into public.taxflow_telegram_link_tokens (firm_id,client_id,token_hash,expires_at,created_by) values ($1,$2,$3,$4,$5)', [this.firmId, clientId, hashToken(token), expiresAt, createdBy]); return { token, expiresAt }; }
  async claimTelegramLink(token, telegramUserId, telegramChatId) { const client = await this.pool.connect(); try { await client.query('begin'); await client.query("select set_config('app.firm_id',$1,true)",[this.firmId]); const link = (await client.query("select t.*, c.user_id from public.taxflow_telegram_link_tokens t join public.clients c on c.id=t.client_id where t.token_hash=$1 and t.consumed_at is null and t.expires_at > now() and c.user_id=$2 for update", [hashToken(token), this.clientUserId])).rows[0]; if (!link) { await client.query('rollback'); return null; } const conflict = (await client.query('select id from public.clients where telegram_chat_id=$1 and id<>$2 limit 1', [String(telegramChatId), link.client_id])).rows[0]; if (conflict) { await client.query('rollback'); const error = new Error('telegram_chat_already_linked'); error.statusCode = 409; throw error; } await client.query('update public.taxflow_telegram_link_tokens set consumed_at=now() where id=$1', [link.id]); const result = (await client.query('update public.clients set telegram_user_id=$2,telegram_chat_id=$3,telegram_linked_at=now(),telegram_consent_at=now() where id=$1 returning id::text as id,name', [link.client_id, String(telegramUserId), String(telegramChatId)])).rows[0]; await client.query('commit'); return result; } catch (error) { await client.query('rollback').catch(() => {}); throw error; } finally { client.release(); } }
  async addSchedule(v) { const result = await this.query('insert into taxflow_communication_schedules (firm_id,client_id,channel,template,payload,scheduled_for,consent_recorded,status,created_by) values ($1,$2,$3,$4,$5,$6,$7,\'awaiting_approval\',$8) returning *', [this.firmId,v.clientId,v.channel,v.template,JSON.stringify(v.payload||{}),v.scheduledFor,v.consentRecorded,v.createdBy]); return result.rows[0]; }
  async listSchedules() { const result = await this.query('select * from taxflow_communication_schedules order by scheduled_for asc'); return result.rows; }
  async getSchedule(idValue) { const result = await this.query('select * from taxflow_communication_schedules where id=$1', [idValue]); return result.rows[0] || null; }
  async approveSchedule(idValue, approvedBy) { const client = await this.pool.connect(); try { await client.query('begin'); await client.query("select set_config('app.firm_id',$1,true)",[this.firmId]); const schedule = (await client.query("update taxflow_communication_schedules set status='approved',updated_at=now() where id=$1 and status='awaiting_approval' returning *", [idValue])).rows[0]; if (!schedule) { await client.query('rollback'); return null; } const message = (await client.query("insert into taxflow_outbound_messages (firm_id,schedule_id,client_id,channel,body,status,approved_by,approved_at,next_attempt_at) values ($1,$2,$3,$4,$5,'approved',$6,now(),now()) returning *", [this.firmId,schedule.id,schedule.client_id,schedule.channel,schedule.payload?.body || schedule.template,approvedBy])).rows[0]; await client.query('commit'); return { schedule, message }; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } }
  async listDueOutbound() { const result = await this.query("select o.*, c.telegram_chat_id from public.taxflow_outbound_messages o join public.clients c on c.id=o.client_id join public.taxflow_communication_schedules s on s.id=o.schedule_id where o.channel='telegram' and s.scheduled_for <= now() and ((o.status='approved' and (o.next_attempt_at is null or o.next_attempt_at <= now())) or (o.status='sending' and o.sending_started_at < now() - interval '2 minutes')) order by o.created_at for update skip locked"); return result.rows; }
  async claimOutbound(idValue) { const result = await this.query("update public.taxflow_outbound_messages set status='sending',attempts=attempts+1,sending_started_at=now() where id=$1 and (status='approved' or (status='sending' and sending_started_at < now() - interval '2 minutes')) returning *", [idValue]); return result.rows[0] || null; }
  async completeOutbound(idValue, result) { const query = result.status === 'sent' ? 'update public.taxflow_outbound_messages set status=\'sent\',provider_message_id=$2,sent_at=now(),last_error=null where id=$1 returning *' : 'update public.taxflow_outbound_messages set status=\'failed\',last_error=$2,next_attempt_at=now()+interval \'5 minutes\' where id=$1 returning *'; const response = await this.query(query, [idValue, result.providerMessageId || result.error || 'telegram_delivery_failed']); return response.rows[0] || null; }
}

module.exports = { MemoryStore, PgStore };
