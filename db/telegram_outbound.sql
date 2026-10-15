alter table public.clients
  add column if not exists telegram_chat_id text,
  add column if not exists telegram_linked_at timestamptz,
  add column if not exists telegram_consent_at timestamptz;

create unique index if not exists clients_telegram_chat_id_unique
  on public.clients (telegram_chat_id)
  where telegram_chat_id is not null and telegram_chat_id <> '';

alter table public.taxflow_communication_schedules
  drop constraint if exists taxflow_communication_schedules_channel_check;
alter table public.taxflow_communication_schedules
  add constraint taxflow_communication_schedules_channel_check
  check (channel in ('whatsapp', 'email', 'telegram'));

alter table public.taxflow_outbound_messages
  drop constraint if exists taxflow_outbound_messages_channel_check;
alter table public.taxflow_outbound_messages
  add constraint taxflow_outbound_messages_channel_check
  check (channel in ('whatsapp', 'email', 'telegram'));

alter table public.taxflow_outbound_messages
  add column if not exists next_attempt_at timestamptz,
  add column if not exists sending_started_at timestamptz;

create table if not exists public.taxflow_telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);

alter table public.taxflow_telegram_link_tokens enable row level security;
drop policy if exists taxflow_telegram_link_firm_isolation on public.taxflow_telegram_link_tokens;
create policy taxflow_telegram_link_firm_isolation on public.taxflow_telegram_link_tokens
  using (firm_id::text = current_setting('app.firm_id', true))
  with check (firm_id::text = current_setting('app.firm_id', true));

create index if not exists taxflow_telegram_link_tokens_client_idx
  on public.taxflow_telegram_link_tokens (client_id, expires_at)
  where consumed_at is null;
