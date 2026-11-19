// load-launch-pack
//
// Reads a launch pack (see setup-wizard/LAUNCH_PACK.md) and writes the
// strategy setup for the signed-in owner: profile, audience, hard rules,
// lanes, readers, formats, natures, jobs, SWOT, topic seeds, search topics
// and posting schedule slots.
//
// It does NOT fetch sources and does NOT queue drafts. The Launch page does
// those two steps in the browser so each step shows progress and stays under
// the edge function time limit.
//
// Safe to run twice: a table that already has rows for this user is skipped
// and reported, never overwritten. Pass { replace: true } to clear and reload
// the strategy tables first.
//
// Input : { pack: object, replace?: boolean }
// Output: { ok: true, written: {...}, skipped: [...], warnings: [...] }
//         { ok: false, errors: [...] }   (HTTP 400, nothing written)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "as_needed"];
const PLATFORMS = ["linkedin", "instagram"];
const SIDES = ["decision", "end_user"];
const QUADRANTS = ["strength", "weakness", "opportunity", "threat"];
const STAGES = ["tofu", "mofu", "bofu"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
const keyOf = (v: unknown) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// ---------- validation ----------

function validate(pack: any): string[] {
  const e: string[] = [];
  if (!pack || typeof pack !== "object") return ["The pack is empty or is not JSON."];
  if (pack.version !== 1) e.push("version must be 1.");

  const b = pack.business ?? {};
  if (!str(b.name)) e.push("business.name is required.");
  if (str(b.description).length < 40) e.push("business.description needs at least 40 characters.");
  if (!str(b.audience)) e.push("business.audience is required.");
  if (str(b.voice).length < 40) e.push("business.voice needs at least 40 characters.");
  if (b.timezone && !/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(str(b.timezone))) {
    e.push("business.timezone must be an IANA name such as America/Chicago.");
  }
  if (b.post_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(str(b.post_time))) {
    e.push("business.post_time must be HH:MM in 24-hour time, for example 09:00.");
  }

  const need = (name: string, min: number) => {
    const v = pack[name];
    if (!Array.isArray(v) || v.length < min) e.push(`${name} needs at least ${min} item(s).`);
    return Array.isArray(v) ? v : [];
  };

  const formats = need("formats", 3);
  const natures = need("natures", 4);
  const jobs = need("jobs", 3);
  const lanes = need("lanes", 2);
  const readers = need("readers", 2);
  const hardRules = need("hard_rules", 3);
  const schedule = need("schedule", 3);
  const seeds = need("seeds", 12);

  const keys = (list: any[], label: string) => {
    const seen = new Set<string>();
    for (const it of list) {
      const k = keyOf(it?.key ?? it?.name);
      if (!k) { e.push(`${label}: every item needs a key or name.`); continue; }
      if (seen.has(k)) e.push(`${label}: duplicate key "${k}".`);
      seen.add(k);
    }
    return seen;
  };
  const fk = keys(formats, "formats");
  const nk = keys(natures, "natures");
  const jk = keys(jobs, "jobs");
  const lk = keys(lanes, "lanes");
  const rk = keys(readers, "readers");

  for (const f of formats) {
    if (!str(f.name)) e.push(`formats: "${f.key}" needs a name.`);
    if (!PLATFORMS.includes(str(f.platform))) e.push(`formats: "${f.key}" platform must be linkedin or instagram.`);
    if (str(f.definition).length < 20) e.push(`formats: "${f.key}" needs a definition of at least 20 characters.`);
    const lo = Number(f.min_words), hi = Number(f.max_words);
    if (f.min_words != null && f.max_words != null && !(lo > 0 && hi >= lo)) {
      e.push(`formats: "${f.key}" min_words and max_words are not valid.`);
    }
  }
  for (const n of natures) {
    if (str(n.move).length < 20) e.push(`natures: "${n.key ?? n.name}" needs a move of at least 20 characters.`);
  }
  for (const j of jobs) {
    if (j.funnel_stage && !STAGES.includes(str(j.funnel_stage))) e.push(`jobs: "${j.key ?? j.name}" funnel_stage must be tofu, mofu or bofu.`);
  }
  for (const r of readers) {
    if (r.side && !SIDES.includes(str(r.side))) e.push(`readers: "${r.key ?? r.role}" side must be decision or end_user.`);
    if (!Array.isArray(r.questions) || r.questions.length < 2) e.push(`readers: "${r.key ?? r.role}" needs at least 2 questions.`);
  }
  for (const s of pack.swot ?? []) {
    if (!QUADRANTS.includes(str(s.quadrant))) e.push(`swot: quadrant must be one of ${QUADRANTS.join(", ")}.`);
  }
  for (const [i, s] of schedule.entries()) {
    const n = `schedule[${i + 1}]`;
    if (!fk.has(keyOf(s.format))) e.push(`${n}: format "${s.format}" is not in formats.`);
    if (!nk.has(keyOf(s.nature))) e.push(`${n}: nature "${s.nature}" is not in natures.`);
    if (!jk.has(keyOf(s.job))) e.push(`${n}: job "${s.job}" is not in jobs.`);
    if (s.lane && !lk.has(keyOf(s.lane))) e.push(`${n}: lane "${s.lane}" is not in lanes.`);
    if (s.reader && !rk.has(keyOf(s.reader))) e.push(`${n}: reader "${s.reader}" is not in readers.`);
    if (!Number.isInteger(s.day_of_week) || s.day_of_week < 0 || s.day_of_week > 6) e.push(`${n}: day_of_week must be 0 (Sunday) to 6 (Saturday).`);
    if (!FREQUENCIES.includes(str(s.frequency || "weekly"))) e.push(`${n}: frequency must be one of ${FREQUENCIES.join(", ")}.`);
    if (s.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(str(s.time))) e.push(`${n}: time must be HH:MM.`);
  }
  // 12 drafts need enough weekly occurrences in the next few weeks.
  const perWeek = schedule.filter((s: any) => (s.frequency || "weekly") === "weekly").length;
  if (perWeek < 2) e.push("schedule needs at least 2 weekly slots so 12 posts are queued within about 6 weeks.");

  for (const s of seeds) {
    if (str(s?.premise).length < 25) { e.push("seeds: every premise needs at least 25 characters."); break; }
  }
  for (const r of hardRules) {
    if (str(r).length < 10) { e.push("hard_rules: every rule needs at least 10 characters."); break; }
  }
  const srcs = pack.sources ?? [];
  if (!Array.isArray(srcs) || srcs.length < 5) e.push("sources needs at least 5 items.");
  for (const s of Array.isArray(srcs) ? srcs : []) {
    try {
      const u = new URL(str(s?.url));
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
    } catch { e.push(`sources: "${s?.url}" is not a valid web address.`); break; }
  }
  return e;
}

// ---------- write helpers ----------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, errors: ["Use POST."] });

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const auth = req.headers.get("Authorization");
    if (!url || !serviceKey) return json(500, { ok: false, errors: ["Server configuration error."] });
    if (!auth) return json(401, { ok: false, errors: ["Sign in first."] });

    const asUser = createClient(url, serviceKey, { global: { headers: { Authorization: auth } } });
    const { data: { user }, error: authErr } = await asUser.auth.getUser();
    if (authErr || !user) return json(401, { ok: false, errors: ["Your sign-in expired. Sign in again."] });
    const uid = user.id;
    const db = createClient(url, serviceKey);

    const body = await req.json().catch(() => ({}));
    const pack = body?.pack;
    const replace = body?.replace === true;

    const errors = validate(pack);
    if (errors.length) return json(400, { ok: false, errors });

    const written: Record<string, number> = {};
    const skipped: string[] = [];
    const warnings: string[] = [];

    const count = async (table: string) => {
      const { count: c } = await db.from(table).select("id", { count: "exact", head: true }).eq("user_id", uid);
      return c ?? 0;
    };

    if (replace) {
      // Children first. Drafts, cards and feeds are never touched.
      for (const t of ["content_schedules", "reader_questions", "readers", "swot_items", "seeds", "hard_rules", "lanes", "jobs", "natures", "formats"]) {
        const { error } = await db.from(t).delete().eq("user_id", uid);
        if (error) return json(500, { ok: false, errors: [`Could not clear ${t}: ${error.message}`] });
      }
    }

    // ----- profile -----
    const b = pack.business;
    const profilePatch: Record<string, unknown> = {
      business_name: str(b.name),
      business_description: str(b.description),
      target_audience: str(b.audience),
      brand_voice: str(b.voice),
    };
    if (b.timezone) profilePatch.default_timezone = str(b.timezone);
    if (b.post_time) profilePatch.default_post_time = `${str(b.post_time)}:00`;
    const colors = b.colors ?? {};
    if (/^#[0-9a-fA-F]{6}$/.test(str(colors.primary))) profilePatch.primary_color = str(colors.primary);
    if (/^#[0-9a-fA-F]{6}$/.test(str(colors.secondary))) profilePatch.secondary_color = str(colors.secondary);
    if (/^#[0-9a-fA-F]{6}$/.test(str(colors.accent))) profilePatch.accent_color = str(colors.accent);

    const { data: prof } = await db.from("profiles").select("id").eq("user_id", uid).maybeSingle();
    const profRes = prof
      ? await db.from("profiles").update(profilePatch).eq("user_id", uid)
      : await db.from("profiles").insert({ user_id: uid, email: user.email, ...profilePatch });
    if (profRes.error) return json(500, { ok: false, errors: [`Could not save the profile: ${profRes.error.message}`] });
    written.profile = 1;

    // ----- audience -----
    const a = pack.audience ?? {};
    const audiencePatch = {
      thesis: str(a.thesis) || null,
      fit_criteria: arr(a.fit_criteria),
      institution_type: str(a.institution_type) || null,
      asset_range: str(a.asset_range) || null,
      core_systems: str(a.core_systems) || null,
      language_use: arr(a.language_use),
      language_avoid: arr(a.language_avoid),
      channels: arr(a.channels),
      discovery_topics: arr(a.discovery_topics).slice(0, 8),
    };
    const { data: aud } = await db.from("audience_profile").select("id").eq("user_id", uid).maybeSingle();
    const audRes = aud
      ? await db.from("audience_profile").update(audiencePatch).eq("user_id", uid)
      : await db.from("audience_profile").insert({ user_id: uid, ...audiencePatch });
    if (audRes.error) return json(500, { ok: false, errors: [`Could not save the audience: ${audRes.error.message}`] });
    written.audience = 1;

    // ----- strategy library -----
    const insertAll = async (table: string, rows: any[], select = "id, key") => {
      if (!rows.length) return [] as any[];
      if (!replace && (await count(table)) > 0) {
        skipped.push(`${table} already has rows`);
        const { data } = await db.from(table).select(select).eq("user_id", uid);
        return data ?? [];
      }
      const { data, error } = await db.from(table).insert(rows).select(select);
      if (error) throw new Error(`${table}: ${error.message}`);
      written[table] = rows.length;
      return data ?? [];
    };

    const formatRows = await insertAll("formats", pack.formats.map((f: any, i: number) => ({
      user_id: uid, key: keyOf(f.key ?? f.name), name: str(f.name), platform: str(f.platform),
      definition: str(f.definition), min_words: f.min_words ?? null, max_words: f.max_words ?? null,
      is_active: true, sort_order: i,
    })));
    const natureRows = await insertAll("natures", pack.natures.map((n: any, i: number) => ({
      user_id: uid, key: keyOf(n.key ?? n.name), name: str(n.name), move: str(n.move),
      evidence_type: str(n.evidence_type) || null, fit: str(n.fit) || null, is_active: true, sort_order: i,
    })));
    const jobRows = await insertAll("jobs", pack.jobs.map((j: any, i: number) => ({
      user_id: uid, key: keyOf(j.key ?? j.name), name: str(j.name), description: str(j.description) || null,
      funnel_stage: str(j.funnel_stage) || "tofu", kind: "engine_job", is_active: true, sort_order: i,
    })));
    const laneRows = await insertAll("lanes", pack.lanes.map((l: any, i: number) => ({
      user_id: uid, key: keyOf(l.key ?? l.name), name: str(l.name), is_wedge: l.is_wedge === true,
      description: str(l.description) || null, vocabulary: arr(l.vocabulary), is_active: true, sort_order: i,
    })));
    const readerRows = await insertAll("readers", pack.readers.map((r: any, i: number) => ({
      user_id: uid, key: keyOf(r.key ?? r.role), role: str(r.role), who: str(r.who) || null,
      side: str(r.side) || "decision", lane_scope: str(r.lane_scope) || null,
      avatar_initials: str(r.role).split(/\s+/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase() || null,
      is_active: true, sort_order: i,
    })));

    // reader questions
    if (written.readers) {
      const qRows: any[] = [];
      for (const r of pack.readers) {
        const row = readerRows.find((x: any) => x.key === keyOf(r.key ?? r.role));
        if (!row) continue;
        arr(r.questions).forEach((q, i) => qRows.push({ user_id: uid, reader_id: row.id, question: q, sort_order: i }));
      }
      if (qRows.length) {
        const { error } = await db.from("reader_questions").insert(qRows);
        if (error) warnings.push(`Reader questions not saved: ${error.message}`);
        else written.reader_questions = qRows.length;
      }
    }

    // hard rules, swot, seeds
    if (!replace && (await count("hard_rules")) > 0) skipped.push("hard_rules already has rows");
    else {
      const { error } = await db.from("hard_rules").insert(arr(pack.hard_rules).map((body: string, i: number) => ({
        user_id: uid, body, is_active: true, sort_order: i,
      })));
      if (error) throw new Error(`hard_rules: ${error.message}`);
      written.hard_rules = arr(pack.hard_rules).length;
    }
    if ((pack.swot ?? []).length) {
      if (!replace && (await count("swot_items")) > 0) skipped.push("swot_items already has rows");
      else {
        const { error } = await db.from("swot_items").insert(pack.swot.map((s: any, i: number) => ({
          user_id: uid, quadrant: str(s.quadrant), body: str(s.body),
          threat_class: str(s.quadrant) === "threat" ? (str(s.threat_class) === "triggered" ? "triggered" : "standing") : null,
          sort_order: i,
        })));
        if (error) warnings.push(`SWOT not saved: ${error.message}`);
        else written.swot_items = pack.swot.length;
      }
    }
    if (!replace && (await count("seeds")) > 0) skipped.push("seeds already has rows");
    else {
      const { error } = await db.from("seeds").insert(pack.seeds.map((s: any, i: number) => ({
        user_id: uid, premise: str(s.premise), category: str(s.category) || null,
        suggested_nature_key: s.nature ? keyOf(s.nature) : null, lane_scope: str(s.lane) || null,
        is_active: true, sort_order: i,
      })));
      if (error) throw new Error(`seeds: ${error.message}`);
      written.seeds = pack.seeds.length;
    }

    // ----- schedule slots -----
    const idOf = (rows: any[], k: unknown) => rows.find((r: any) => r.key === keyOf(k))?.id ?? null;
    if (!replace && (await count("content_schedules")) > 0) {
      skipped.push("content_schedules already has rows");
    } else {
      const tz = str(b.timezone) || "America/New_York";
      const slotRows = pack.schedule.map((s: any) => {
        const freq = str(s.frequency) || "weekly";
        const fmt = pack.formats.find((f: any) => keyOf(f.key ?? f.name) === keyOf(s.format));
        return {
          user_id: uid,
          format_id: idOf(formatRows, s.format), nature_id: idOf(natureRows, s.nature), job_id: idOf(jobRows, s.job),
          lane_id: s.lane ? idOf(laneRows, s.lane) : null, reader_id: s.reader ? idOf(readerRows, s.reader) : null,
          day_of_week: s.day_of_week, frequency: freq, anchor: freq === "weekly" || freq === "as_needed" ? null : (s.anchor ?? null),
          time_of_day: `${str(s.time) || str(b.post_time) || "09:00"}:00`, timezone: tz,
          platform: str(fmt?.platform) || "linkedin", is_active: true, requires_child: false,
        };
      });
      if (slotRows.some((r: any) => !r.format_id || !r.nature_id || !r.job_id)) {
        throw new Error("content_schedules: a slot points at a format, nature or job that is not saved. The account already has its own strategy rows. Run the load again with Replace my setup turned on.");
      }
      const { error } = await db.from("content_schedules").insert(slotRows);
      if (error) throw new Error(`content_schedules: ${error.message}`);
      written.content_schedules = slotRows.length;
    }

    return json(200, { ok: true, written, skipped, warnings });
  } catch (err) {
    console.error("load-launch-pack failed", err);
    return json(500, { ok: false, errors: [err instanceof Error ? err.message : "Unknown error"] });
  }
});
