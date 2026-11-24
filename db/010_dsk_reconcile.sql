-- 010 · Сверяване на плащанията с банката всяка минута
--
-- В теста банката не прати нито едно обратно известие. Затова dsk-pay
-- сама пита банката за неприключените поръчки, а за платени, но
-- непредадени преписки праща имейл на кантората (веднъж — alerted_at).

alter table app.vpos_orders add column if not exists alerted_at timestamptz;

create index if not exists vpos_orders_open
  on app.vpos_orders (env, status, created_at)
  where status in ('registered','approved','paid');

-- Задачата повтаря drain-notifications: същият адрес на проекта и същият
-- секретен ключ в заглавие apikey, само функцията и тялото са други.
-- Така ключът не се изписва тук.
select cron.unschedule('dsk-reconcile')
 where exists (select 1 from cron.job where jobname = 'dsk-reconcile');

select cron.schedule(
  'dsk-reconcile',
  '* * * * *',
  (select replace(
            replace(command, 'functions/v1/send-notifications', 'functions/v1/dsk-pay'),
            'timeout_milliseconds',
            'body:=''{"action":"reconcile"}''::jsonb, timeout_milliseconds')
     from cron.job where jobname = 'drain-notifications')
);

-- Проверка:
--   select jobname, schedule, active from cron.job order by jobid;
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname='dsk-reconcile')
--    order by start_time desc limit 5;
