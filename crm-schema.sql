-- InsureFlow AI — Lead Conversion Agent · Postgres schema
-- Run this if you're self-hosting. If you're on HubSpot/Pipedrive/Zoho,
-- throw this away and map the same fields onto their objects instead —
-- don't build a CRM to hold one table.

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------
-- Leads: one row per conversation. Mirrors the JSON payload exactly.
-- ------------------------------------------------------------------
create type lead_band as enum ('QUALIFIED_HOT','NURTURE','UNQUALIFIED','SPAM');
create type routing_action as enum ('book_meeting','producer_callback_same_day','producer_callback_24h','email_pack_nurture','do_not_contact_after_request','producer_review');

create table leads (
  id                 uuid primary key default gen_random_uuid(),
  session_id         text unique not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- contact
  first_name         text,
  last_name          text,
  email              text,
  phone              text,
  best_time          text,

  -- business
  legal_name         text,
  industry           text,
  units              integer,
  states             text,
  mc_dot_authority   text check (mc_dot_authority in ('true','false','Pending','') or mc_dot_authority is null),
  current_carrier    text,

  -- need
  lines              text[] default '{}',
  renewal            text,
  urgency            text,

  -- risk
  loss_history_3yr   text,
  flags              text[] default '{}',

  -- qualification
  score              integer check (score between 0 and 100),
  band               lead_band,
  score_reasons      text[] default '{}',

  -- consent (this block is the one your lawyer cares about)
  ai_disclosure_accepted boolean not null default false,
  email_opt_in       boolean not null default false,
  sms_opt_in         boolean not null default false,
  consent_text       text,
  consent_captured_at timestamptz,
  do_not_contact     boolean not null default false,
  suppressed_at      timestamptz,

  -- routing
  routing_action     routing_action,
  owner              text,
  sla                text,

  source             text default 'website_chat',
  agent_version      text,
  duration_sec       integer
);

create index on leads (created_at desc);
create index on leads (band, created_at desc) where do_not_contact = false;
create index on leads (lower(email)) where email is not null;
create index on leads (owner, routing_action) where do_not_contact = false;

-- ------------------------------------------------------------------
-- Events: every tool call, append-only. Immutable on purpose.
-- ------------------------------------------------------------------
create table lead_events (
  id          bigserial primary key,
  lead_id     uuid references leads(id) on delete cascade,
  at          timestamptz not null default now(),
  tool        text not null,
  payload     jsonb not null default '{}'::jsonb
);
create index on lead_events (lead_id, at);

-- Append-only guard: no updates, no deletes.
create or replace function block_event_mutation() returns trigger as $$
begin raise exception 'lead_events is append-only'; end; $$ language plpgsql;
create trigger lead_events_immutable before update or delete on lead_events
  for each row execute function block_event_mutation();

-- ------------------------------------------------------------------
-- Transcript
-- ------------------------------------------------------------------
create table lead_messages (
  id          bigserial primary key,
  lead_id     uuid references leads(id) on delete cascade,
  at          timestamptz not null default now(),
  role        text not null check (role in ('user','assistant','system')),
  content     text not null,
  kb_topic    text,           -- which approved answer it used
  was_miss    boolean default false   -- true when the KB had no answer
);
create index on lead_messages (lead_id, at);

-- kb_miss is your content backlog: every row is a question you should
-- write an approved answer for, so the agent stops handing off.
create view kb_gaps as
  select content, count(*) as times_asked
  from lead_messages where was_miss group by content order by 2 desc limit 50;

-- ------------------------------------------------------------------
-- Suppression: checked before ANY outbound. Non-negotiable.
-- ------------------------------------------------------------------
create table suppression_list (
  id          bigserial primary key,
  channel     text not null check (channel in ('email','sms','all')),
  value       text not null,
  verbatim    text,          -- exactly what they said
  added_at    timestamptz not null default now(),
  unique (channel, value)
);

create or replace function is_suppressed(p_channel text, p_value text)
returns boolean as $$
  select exists (
    select 1 from suppression_list
    where value = lower(p_value) and channel in (p_channel, 'all')
  );
$$ language sql stable;

-- ------------------------------------------------------------------
-- Booking + follow-up
-- ------------------------------------------------------------------
create table meetings (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid references leads(id) on delete cascade,
  slot           timestamptz,
  timezone       text,
  calendar_event_id text,
  status         text default 'held' check (status in ('held','confirmed','completed','no_show','cancelled')),
  created_at     timestamptz not null default now()
);

create table followup_queue (
  id           bigserial primary key,
  lead_id      uuid references leads(id) on delete cascade,
  sequence     text not null,
  channel      text not null,
  send_at      timestamptz not null,
  sent_at      timestamptz,
  status       text default 'pending' check (status in ('pending','sent','cancelled','blocked_suppression')),
  consent_quote text not null   -- the sentence they agreed to; empty = don't send
);

-- The safety net: no job can ever fire for a suppressed or non-consented lead.
create or replace function guard_followup() returns trigger as $$
declare l record;
begin
  select do_not_contact, email_opt_in, sms_opt_in, email, phone into l
    from leads where id = new.lead_id;

  if l.do_not_contact
     or (new.channel = 'email' and not l.email_opt_in)
     or (new.channel = 'sms'   and not l.sms_opt_in)
     or is_suppressed(new.channel, case when new.channel = 'email' then l.email else l.phone end)
  then
    new.status := 'blocked_suppression';
    new.send_at := null;
  end if;
  return new;
end; $$ language plpgsql;

create trigger followup_guard before insert on followup_queue
  for each row execute function guard_followup();

-- ------------------------------------------------------------------
-- Reporting: the monthly scorecard you send the client
-- ------------------------------------------------------------------
create view monthly_scorecard as
select date_trunc('month', created_at) as month,
       count(*)                                                        as conversations,
       count(*) filter (where band = 'QUALIFIED_HOT')                  as hot_leads,
       count(*) filter (where routing_action = 'book_meeting')         as meetings_booked,
       count(*) filter (where routing_action like 'producer_callback%') as callbacks,
       count(*) filter (where do_not_contact)                          as opt_outs,
       round(avg(score))                                               as avg_score,
       round(avg(duration_sec))                                        as avg_seconds
from leads group by 1 order by 1 desc;
