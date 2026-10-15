create extension if not exists pgcrypto;

create table if not exists taxflow_integration_accounts (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  channel text not null check (channel in ('whatsapp', 'email', 'telegram')),
  provider_account_id text not null,
  encrypted_config jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  created_at timestamptz not null default now(),
  unique (firm_id, channel, provider_account_id)
);

create table if not exists taxflow_intake_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  integration_account_id uuid references taxflow_integration_accounts(id),
  provider text not null,
  provider_event_id text not null,
  sender text,
  filename text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  spool_object_key text not null,
  route_status text not null default 'quarantine' check (route_status in ('routed', 'quarantine')),
  route_reason text,
  client_id uuid references public.clients(id),
  period_year integer,
  period_month integer check (period_month between 1 and 12),
  status text not null default 'received' check (status in ('received', 'raw_persisted', 'queued', 'extracting', 'awaiting_review', 'approved', 'failed', 'acked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table if not exists taxflow_documents (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  intake_event_id uuid not null references taxflow_intake_events(id),
  client_id uuid references public.clients(id),
  document_type text not null default 'unknown',
  raw_filename text not null,
  raw_sha256 text not null,
  raw_vault_path text,
  status text not null default 'raw_persisted' check (status in ('raw_persisted', 'queued', 'extracting', 'awaiting_review', 'awaiting_publication', 'approved', 'failed', 'quarantined')),
  current_revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_event_id)
);

create table if not exists taxflow_extraction_revisions (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  document_id uuid not null references taxflow_documents(id),
  revision integer not null,
  schema_version text not null,
  provider text,
  payload jsonb not null,
  findings jsonb not null default '[]'::jsonb,
  status text not null default 'awaiting_review' check (status in ('awaiting_review', 'changes_requested', 'approved', 'superseded')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (document_id, revision)
);

create table if not exists taxflow_review_decisions (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  document_id uuid not null references taxflow_documents(id),
  revision_id uuid not null references taxflow_extraction_revisions(id),
  reviewer_id text,
  decision text not null check (decision in ('approved', 'changes_requested', 'rejected')),
  approved_checksum text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists taxflow_approved_artifacts (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  document_id uuid not null references taxflow_documents(id),
  revision_id uuid not null references taxflow_extraction_revisions(id),
  path text not null,
  checksum text not null,
  schema_version text not null,
  created_at timestamptz not null default now(),
  unique (document_id, revision_id),
  unique (path)
);

create table if not exists taxflow_communication_schedules (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  client_id uuid not null references public.clients(id),
  channel text not null check (channel in ('whatsapp', 'email')),
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null,
  consent_recorded boolean not null default false,
  status text not null default 'awaiting_approval' check (status in ('awaiting_approval', 'approved', 'paused', 'cancelled', 'sent', 'failed')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists taxflow_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  schedule_id uuid not null references taxflow_communication_schedules(id),
  client_id uuid not null references public.clients(id),
  channel text not null check (channel in ('whatsapp', 'email')),
  body text not null,
  status text not null default 'awaiting_approval' check (status in ('awaiting_approval', 'approved', 'sending', 'sent', 'failed', 'cancelled')),
  provider_message_id text,
  attempts integer not null default 0 check (attempts >= 0),
  approved_by text,
  approved_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (schedule_id)
);

create table if not exists taxflow_audit_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  actor_id uuid,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now()
);

alter table taxflow_integration_accounts enable row level security;
alter table taxflow_intake_events enable row level security;
alter table taxflow_documents enable row level security;
alter table taxflow_extraction_revisions enable row level security;
alter table taxflow_review_decisions enable row level security;
alter table taxflow_audit_events enable row level security;
alter table taxflow_approved_artifacts enable row level security;
alter table taxflow_communication_schedules enable row level security;
alter table taxflow_outbound_messages enable row level security;

drop policy if exists taxflow_integration_firm_isolation on taxflow_integration_accounts;
drop policy if exists taxflow_intake_firm_isolation on taxflow_intake_events;
drop policy if exists taxflow_documents_firm_isolation on taxflow_documents;
drop policy if exists taxflow_audit_firm_isolation on taxflow_audit_events;
drop policy if exists taxflow_revisions_firm_isolation on taxflow_extraction_revisions;
drop policy if exists taxflow_reviews_firm_isolation on taxflow_review_decisions;
drop policy if exists taxflow_artifacts_firm_isolation on taxflow_approved_artifacts;
drop policy if exists taxflow_schedule_firm_isolation on taxflow_communication_schedules;
drop policy if exists taxflow_outbound_firm_isolation on taxflow_outbound_messages;

create policy taxflow_integration_firm_isolation on taxflow_integration_accounts using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_intake_firm_isolation on taxflow_intake_events using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_documents_firm_isolation on taxflow_documents using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_audit_firm_isolation on taxflow_audit_events using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_revisions_firm_isolation on taxflow_extraction_revisions using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_reviews_firm_isolation on taxflow_review_decisions using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_artifacts_firm_isolation on taxflow_approved_artifacts using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_schedule_firm_isolation on taxflow_communication_schedules using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
create policy taxflow_outbound_firm_isolation on taxflow_outbound_messages using (firm_id::text = current_setting('app.firm_id', true)) with check (firm_id::text = current_setting('app.firm_id', true));
