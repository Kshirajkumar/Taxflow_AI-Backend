/*
  Consolidate the empty intake client projection into public.clients.

  This migration is intentionally fail-closed. It will stop before any DDL
  if the old intake tables contain data. Run it in Supabase SQL Editor after
  reviewing the exception, never against a database with unreviewed rows.
*/

begin;

do $$
declare
  table_name text;
  row_count bigint;
begin
  foreach table_name in array array[
    'taxflow_clients',
    'taxflow_communication_schedules',
    'taxflow_outbound_messages',
    'taxflow_intake_events',
    'taxflow_documents',
    'taxflow_extraction_revisions',
    'taxflow_review_decisions',
    'taxflow_approved_artifacts'
  ] loop
    execute format('select count(*) from public.%I', table_name) into row_count;
    if row_count <> 0 then
      raise exception 'Refusing consolidation: public.% contains % rows', table_name, row_count;
    end if;
  end loop;
end $$;

/* The old projection is empty, so no text IDs need conversion. */
alter table public.taxflow_intake_events
  alter column client_id type uuid using nullif(client_id, '')::uuid;

alter table public.taxflow_documents
  alter column client_id type uuid using nullif(client_id, '')::uuid;

alter table public.taxflow_communication_schedules
  drop constraint if exists taxflow_communication_schedules_client_id_fkey;

alter table public.taxflow_outbound_messages
  drop constraint if exists taxflow_outbound_messages_client_id_fkey;

alter table public.taxflow_communication_schedules
  alter column client_id type uuid using nullif(client_id, '')::uuid;

alter table public.taxflow_outbound_messages
  alter column client_id type uuid using nullif(client_id, '')::uuid;

alter table public.taxflow_intake_events
  drop constraint if exists taxflow_intake_events_client_id_fkey;

alter table public.taxflow_documents
  drop constraint if exists taxflow_documents_client_id_fkey;

alter table public.taxflow_intake_events
  add constraint taxflow_intake_events_client_id_fkey
  foreign key (client_id) references public.clients(id);

alter table public.taxflow_documents
  add constraint taxflow_documents_client_id_fkey
  foreign key (client_id) references public.clients(id);

alter table public.taxflow_communication_schedules
  add constraint taxflow_communication_schedules_client_id_fkey
  foreign key (client_id) references public.clients(id);

alter table public.taxflow_outbound_messages
  add constraint taxflow_outbound_messages_client_id_fkey
  foreign key (client_id) references public.clients(id);

drop table public.taxflow_clients;

commit;
