-- Newsletter health: gives "a newsletter" an identity with memory. Reference
-- cards are per-article; this rolls them up per sender so a recurring pattern
-- (this sender keeps producing low-relevance cards) is visible and actionable,
-- not just individually scored and forgotten.
CREATE TABLE IF NOT EXISTS public.newsletter_health (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  sender_address text NOT NULL,
  card_count integer NOT NULL DEFAULT 0,
  avg_score numeric(4,2),
  last_score integer,
  recommendation text NOT NULL DEFAULT 'healthy' CHECK (recommendation IN ('healthy','watch','unsubscribe')),
  reason text,
  last_scanned_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  UNIQUE (user_id, sender_address)
);

ALTER TABLE public.newsletter_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own newsletter_health" ON public.newsletter_health;
CREATE POLICY "Users manage own newsletter_health" ON public.newsletter_health
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Weekly scan cron. Same shared-secret pattern as fire-due-schedules-daily:
-- the value lives in automation_config, readable only by service role, and
-- is handed to pg_cron here. Reuses the same secret key/value, since it's
-- the same trust boundary (internal cron -> edge function), not a new one.
SELECT cron.schedule(
  'scan-newsletter-health-weekly',
  '0 13 * * 1',
  format(
    $cmd$select net.http_post(
      url := 'https://unconfigured.invalid/functions/v1/scan-newsletter-health',
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
