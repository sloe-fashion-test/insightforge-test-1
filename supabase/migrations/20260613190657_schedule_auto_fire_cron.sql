-- Auto-fire cron. Daily at 13:00 UTC, call the fire-due-schedules edge function, which
-- selects every active slot due today and hands each to execute-autopilot-template.
-- The anon key (public) lets the request through the functions gateway; the real auth
-- check is the x-cron-secret the function verifies against automation_config.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'fire-due-schedules-daily',
  '0 13 * * *',
  format(
    $cmd$select net.http_post(
      url := 'https://unconfigured.invalid/functions/v1/fire-due-schedules',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'template-key-not-configured',
        'Authorization', 'Bearer template-key-not-configured',
        'x-cron-secret', %L
      ),
      body := '{}'::jsonb
    );$cmd$,
    (SELECT value FROM public.automation_config WHERE key = 'cron_fire_secret')
  )
);
