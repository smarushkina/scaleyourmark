-- 009 · Плащания с карта през виртуалния ПОС на „Банка ДСК“ АД
--
-- Всяка поръчка към банката е отделен ред. Пише само Edge Function-ът
-- dsk-pay със service role; клиентът вижда своите редове, адвокатът — всички.
-- Таблицата нарочно НЕ се излага в Data API: страницата пита за статуса
-- през функцията, която първо проверява в банката.

create table if not exists app.vpos_orders (
  id                       bigint generated always as identity primary key,
  matter_id                uuid not null references app.matters(id) on delete restrict,
  user_id                  uuid not null,
  order_number             text not null unique,          -- нашият номер, 1..36 знака
  gateway_order_id         text unique,                   -- orderId / mdOrder на банката
  env                      text not null check (env in ('test','prod')),
  amount_minor             integer not null check (amount_minor > 0),
  currency                 char(3) not null default '978',
  breakdown                jsonb not null,                -- как е сметната сумата
  status                   text not null default 'created'
                           check (status in ('created','registered','approved','paid',
                                             'declined','reversed','refunded','error')),
  order_status             integer,
  action_code              integer,
  action_code_description  text,
  pan_masked               text,                          -- напр. 411111**1111; пълен номер никога
  approval_code            text,
  rrn                      text,
  error                    text,
  last_callback            jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  paid_at                  timestamptz
);

create index if not exists vpos_orders_matter on app.vpos_orders (matter_id, created_at desc);

alter table app.vpos_orders enable row level security;

drop policy if exists vpos_orders_read on app.vpos_orders;
create policy vpos_orders_read on app.vpos_orders
  for select using (user_id = auth.uid() or app.is_lawyer());
-- Политики за вписване и промяна няма: пише само service role.

-- Преписка не може да излезе от „чернова“, без да има платена поръчка.
-- Адвокатът е изключен, за да може да предава тестови и ръчно платени преписки.
create or replace function app.require_payment_on_handover()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.status::text = 'draft' and new.status::text <> 'draft' and not app.is_lawyer() then
    if not exists (select 1 from app.vpos_orders
                   where matter_id = new.id and status = 'paid') then
      raise exception 'payment_required' using errcode = 'P0001',
        hint = 'Преписката се предава след потвърдено плащане.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists t_require_payment on app.matters;
create trigger t_require_payment before update of status on app.matters
  for each row execute function app.require_payment_on_handover();

-- Проверка след пускане:
--   select count(*) from app.vpos_orders;                       -- 0
--   select tgname from pg_trigger where tgname='t_require_payment';
