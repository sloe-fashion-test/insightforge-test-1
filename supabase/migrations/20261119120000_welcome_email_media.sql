-- One-time welcome email + video (supabase/functions/welcome-start,
-- _shared/welcome.ts). The worker renders a short MP4 and a GIF preview on
-- the owner's Claude subscription; claude-job-complete stores them here with
-- the service role and links them from the welcome email, so the bucket is
-- public-read. Only the service role writes (no user insert policy).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('welcome-media', 'welcome-media', true, 8388608, ARRAY['video/mp4', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Welcome media is publicly readable" ON storage.objects;
CREATE POLICY "Welcome media is publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'welcome-media');
