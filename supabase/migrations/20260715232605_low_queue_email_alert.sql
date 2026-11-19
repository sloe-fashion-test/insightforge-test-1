-- Low-queue email alert: when the approved, ready-to-publish queue drops
-- below a per-user threshold (default 3), a daily cron emails the user so
-- they go approve more drafts. This is the email counterpart to the
-- Dashboard banner (min_approved_threshold, default 12): the banner is the
-- soft goal you see when you visit, this is the loud alarm that reaches you
-- when you have not visited.
--
-- low_queue_alert_active is a latch so one dip sends one email, not one
-- email every day: set when the alert is sent, cleared automatically the
-- first time the queue recovers to or above the threshold. The next dip
-- re-arms it.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS low_queue_email_threshold integer NOT NULL DEFAULT 3;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS low_queue_alert_active boolean NOT NULL DEFAULT false;

-- App URL used in alert emails for the "Go to Review" link. Lives in
-- automation_config so a template deployment only changes data, not code.
INSERT INTO public.automation_config (key, value)
SELECT 'app_url', ''
WHERE NOT EXISTS (SELECT 1 FROM public.automation_config WHERE key = 'app_url');

-- Daily check, one hour after fire-due-schedules-daily (13:00 UTC) so the
-- count reflects anything that just got consumed by today's publishing.
-- Same shared-secret pattern as the other two cron jobs.
SELECT cron.schedule(
  'check-approved-queue-daily',
  '0 14 * * *',
  format(
    $cmd$select net.http_post(
      url := 'https://unconfigured.invalid/functions/v1/check-approved-queue',
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
