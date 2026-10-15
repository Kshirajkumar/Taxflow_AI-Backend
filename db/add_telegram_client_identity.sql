alter table public.clients
  add column if not exists telegram_username text,
  add column if not exists telegram_user_id text;

create unique index if not exists clients_telegram_username_unique
  on public.clients (lower(telegram_username))
  where telegram_username is not null and telegram_username <> '';

create unique index if not exists clients_telegram_user_id_unique
  on public.clients (telegram_user_id)
  where telegram_user_id is not null and telegram_user_id <> '';
