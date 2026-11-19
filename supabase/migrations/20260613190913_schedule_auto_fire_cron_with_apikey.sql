-- Re-schedule with the anon key so the functions gateway routes the request; the real
-- auth check is the x-cron-secret the function verifies against automation_config.
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
