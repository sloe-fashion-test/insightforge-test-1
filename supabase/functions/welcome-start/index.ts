// welcome-start - queue the one-time welcome email + video for this install.
// Two ways in (same split as check-approved-queue):
//   1. connect-install, through the database (pg_net) with the shared
//      x-cron-secret header. Sends at most once per install.
//   2. The signed-in owner from Settings ("Send again"), body {force: true}.
// The worker writes the words on the owner's Claude subscription and renders
// the video; claude-job-complete (welcome.ts) stores media and sends the email.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { enqueueInteractiveJob } from "../_shared/claude-queue.ts";
import { buildWelcomeJob, WELCOME_KIND, WELCOME_ROUTE, type WelcomeFacts } from "../_shared/welcome.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const cfg = async (key: string) =>
      (await supabase.from("automation_config").select("value").eq("key", key).maybeSingle()).data?.value ?? null;
    const setCfg = (key: string, value: string) =>
      supabase.from("automation_config").upsert({ key, value }, { onConflict: "key" });

    // Entry path: a real user JWT is the owner (force allowed); otherwise the
    // shared cron secret is required (connect-install via pg_net, no force).
    let viaUser = false;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      const tenant = Deno.env.get("TENANT_USER_ID") ?? "";
      if (user) {
        if (!tenant || user.id !== tenant) return json({ error: "Forbidden" }, 403);
        viaUser = true;
      }
    }
    if (!viaUser) {
      const presented = req.headers.get("x-cron-secret") ?? "";
      const secret = await cfg("cron_fire_secret");
      if (!secret || presented !== secret) return json({ error: "Forbidden" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    // Status read for the Settings card (owner only). automation_config also
    // holds secrets, so the client never reads that table directly.
    if (viaUser && body?.action === "status") {
      return json({
        status: await cfg("welcome_status"), sent_at: await cfg("welcome_sent_at"),
        video_url: await cfg("welcome_video_url"), gif_url: await cfg("welcome_gif_url"),
      });
    }
    const force = viaUser && body?.force === true;

    const userId = Deno.env.get("TENANT_USER_ID") ?? "";
    if (!userId) return json({ error: "TENANT_USER_ID not set; run connect-install first" }, 409);
    if (!force && (await cfg("welcome_sent_at"))) return json({ queued: false, reason: "already_sent" });

    const { data: profile } = await supabase.from("profiles")
      .select("business_name, business_description, target_audience, brand_voice, email, visual_studio_config")
      .eq("user_id", userId).maybeSingle();
    if (!profile?.email) return json({ error: "The owner's profile has no email address yet" }, 409);

    const [{ data: formats }, { data: schedules }, { data: conns }] = await Promise.all([
      supabase.from("formats").select("platform, is_active").eq("user_id", userId),
      supabase.from("content_schedules").select("platform, day_of_week, frequency, time_of_day, timezone, is_active").eq("user_id", userId),
      supabase.from("social_connections").select("platform, account_label, status").eq("user_id", userId),
    ]);
    const active = (schedules ?? []).filter((s: any) => s.is_active);
    const platforms = [...new Set([
      ...(formats ?? []).filter((f: any) => f.is_active !== false).map((f: any) => String(f.platform ?? "").toLowerCase()),
      ...active.map((s: any) => String(s.platform ?? "").toLowerCase()),
    ].filter(Boolean))].map((p) => p === "linkedin" ? "LinkedIn" : p === "instagram" ? "Instagram" : p);
    const cadence = active.length
      ? active.slice(0, 6).map((s: any) =>
          `${typeof s.day_of_week === "number" ? DAYS[s.day_of_week] : s.frequency ?? "scheduled"}${s.time_of_day ? ` ${String(s.time_of_day).slice(0, 5)}` : ""}`).join(", ")
      : "not set yet (the owner turns schedules on later)";

    const facts: WelcomeFacts = {
      businessName: profile.business_name ?? "",
      businessDescription: profile.business_description ?? "",
      audience: profile.target_audience ?? "",
      voice: profile.brand_voice ?? "",
      platforms,
      activeSchedules: active.length,
      cadence,
      connections: (conns ?? []).filter((c: any) => (c.status ?? "active") === "active")
        .map((c: any) => ({ platform: String(c.platform ?? "").toLowerCase(), label: c.account_label ?? null })),
      appUrl: (await cfg("app_url")) ?? "",
      renewalDue: Deno.env.get("WORKER_TOKEN_EXPIRES_AT") ?? null,
      visualsEnabled: (Deno.env.get("VISUALS_ENABLED") ?? "").toLowerCase() === "true",
    };
    const built = buildWelcomeJob(profile, facts);
    const handle = await enqueueInteractiveJob(supabase, {
      userId, route: WELCOME_ROUTE, kind: WELCOME_KIND,
      prompt: built.prompt, system: built.system, context: built.context,
      // One welcome per install; a forced re-send gets its own key.
      idempotencyKey: force ? `resend-${Date.now()}` : "install-v1",
    });
    await setCfg("welcome_status", "queued");
    return json({ queued: true, jobId: handle.jobId, created: handle.created });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
