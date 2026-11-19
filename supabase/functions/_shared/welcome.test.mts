// Run: node --experimental-strip-types --test supabase/functions/_shared/welcome.test.mts
// Welcome email + video: fact-built checklist, word-contract validation, media
// signature checks, and the completion round trip with a fake Db (no network).
import test from "node:test"; import assert from "node:assert/strict";
(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };
const { buildWelcomeJob, setupChecklist, validateWelcomeScript, decodeMedia, completeWelcomeJob, welcomeEmailHtml } =
  await import("./welcome.ts");

const facts = {
  businessName: "ReRev Labs", businessDescription: "Automation for startups", audience: "Founders",
  voice: "Direct", platforms: ["LinkedIn"], activeSchedules: 0, cadence: "not set yet",
  connections: [] as { platform: string; label: string | null }[],
  appUrl: "https://example.github.io/app/", renewalDue: "2027-11-19", visualsEnabled: true,
};
const profile = { business_name: "ReRev Labs", visual_studio_config: {
  color_background: "#051C2E", color_accent: "#0CC8ED", color_highlight: "#9CF7F4",
  color_sparing_accent: "#F877AD", display_font: "Outfit", body_font: "Inter:400,500" } };
const script = {
  subject: "Your InsightForge is ready", preheader: "Here is what to expect",
  intro: "Hi.\n\nYour install is done.", expect: ["Drafts in Review", "Images in your colors", "Nothing posts without you"],
  slides: Array.from({ length: 5 }, (_, i) => ({ headline: `Slide ${i + 1}`, sub: "Short line" })),
};
const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64");
const MP4 = b64([0, 0, 0, 24, ...Buffer.from("ftypisom"), ...new Array(32).fill(0)]);
const GIF = b64([...Buffer.from("GIF89a"), ...new Array(20).fill(0)]);

test("checklist never claims LinkedIn or schedules that do not exist", () => {
  const c = setupChecklist(facts);
  assert.ok(c.some((x) => !x.ok && /Connect your LinkedIn page/.test(x.text)));
  assert.ok(c.some((x) => !x.ok && /No posting schedule is active/.test(x.text)));
  const c2 = setupChecklist({ ...facts, connections: [{ platform: "linkedin", label: "ReRev Labs" }], activeSchedules: 2, cadence: "Tue 09:00" });
  assert.ok(c2.some((x) => x.ok && /LinkedIn is connected \(ReRev Labs\)/.test(x.text)));
  assert.ok(c2.some((x) => x.ok && /2 posting slots active/.test(x.text)));
});

test("job context carries brand from Visual Studio, canvas and checklist", () => {
  const j = buildWelcomeJob(profile, facts);
  assert.deepEqual(j.context.canvas, { w: 1280, h: 720 });
  assert.equal(j.context.brand.background, "#051C2E");
  assert.equal(j.context.brand.body_font, "Inter");
  assert.match(j.prompt, /\[pending\] Connect your LinkedIn page/);
});

test("brand reads visual_studio_config stored as a JSON text column", () => {
  const asText = { ...profile, visual_studio_config: JSON.stringify(profile.visual_studio_config) };
  const j = buildWelcomeJob(asText, facts);
  assert.equal(j.context.brand.background, "#051C2E");
  assert.equal(j.context.brand.sparing_accent, "#F877AD");
  assert.equal(j.context.brand.display_font, "Outfit");
  const broken = buildWelcomeJob({ ...profile, visual_studio_config: "{not json" }, facts);
  assert.equal(broken.context.brand.background, "#111827");
});

test("word contract: exact keys and limits", () => {
  assert.equal(validateWelcomeScript(script).ok, true);
  assert.equal(validateWelcomeScript({ ...script, html: "<b>x</b>" }).ok, false);
  assert.equal(validateWelcomeScript({ ...script, slides: script.slides.slice(0, 4) }).ok, false);
  assert.equal(validateWelcomeScript({ ...script, subject: "x".repeat(91) }).ok, false);
});

test("media signatures", () => {
  assert.ok(decodeMedia(MP4, "mp4") instanceof Uint8Array);
  assert.equal(decodeMedia(GIF, "mp4"), "mp4 signature invalid");
  assert.ok(decodeMedia(GIF, "gif") instanceof Uint8Array);
  assert.equal(decodeMedia("!!", "gif"), "gif not base64");
});

test("email html escapes model words", () => {
  const h = welcomeEmailHtml({ script: { ...script, intro: "<script>x</script>" }, brand: profile.visual_studio_config as any,
    checklist: setupChecklist(facts), videoUrl: "https://v/x.mp4", gifUrl: "https://v/x.gif", appUrl: facts.appUrl, renewalDue: null });
  assert.ok(!h.includes("<script>x"));
  assert.ok(h.includes("&lt;script&gt;"));
});

function fakeDb(sendOk = true) {
  const cfg: Record<string, string> = { alert_from_email: "onboarding@resend.dev" };
  const sent: any[] = []; const uploads: string[] = []; let job: any = { status: "completing" };
  return { cfg, sent, uploads, get job() { return job; },
    async updateJobWhere(_id: string, f: any, fields: any) { if (job.status !== f.status) return null; job = { ...job, ...fields }; return job; },
    async getAutomationConfig(k: string) { return cfg[k] ?? null; },
    async setAutomationConfig(k: string, v: string) { cfg[k] = v; },
    async getProfileEmail() { return "owner@example.com"; },
    async uploadWelcomeMedia(p: string) { uploads.push(p); return { url: `https://cdn/${p}` }; },
    async sendEmail(a: any) { sent.push(a); return sendOk ? { ok: true, status: 200 } : { ok: false, status: 403, error: "domain" }; },
  };
}
const jobRow = (ctx: any) => ({ user_id: "u1", input_snapshot: { interactiveKind: "welcome-video", context: ctx } });
const ctx = { ...buildWelcomeJob(profile, facts).context };

test("completion stores media, sends once, records status", async () => {
  const db = fakeDb();
  const r = await completeWelcomeJob(db as any, { jobId: "j1", job: jobRow(ctx), output: script, mp4Base64: MP4, gifBase64: GIF, now: new Date() });
  assert.equal(r.status, 200);
  assert.equal(db.sent.length, 1);
  assert.equal(db.sent[0].from, "InsightForge <onboarding@resend.dev>");
  assert.deepEqual(db.uploads, ["u1/welcome-j1.mp4", "u1/welcome-j1.gif"]);
  assert.equal(db.cfg.welcome_status, "sent");
  assert.equal(db.job.status, "completed");
  // replay of the same job never re-sends
  const db2 = fakeDb(); db2.cfg.welcome_sent_job = "j1";
  await completeWelcomeJob(db2 as any, { jobId: "j1", job: jobRow(ctx), output: script, mp4Base64: MP4, gifBase64: GIF, now: new Date() });
  assert.equal(db2.sent.length, 0);
});

test("bad words or media fail the job with a reason, no email", async () => {
  const db = fakeDb();
  const r = await completeWelcomeJob(db as any, { jobId: "j2", job: jobRow(ctx), output: { ...script, extra: 1 }, mp4Base64: MP4, gifBase64: GIF, now: new Date() });
  assert.equal(r.status, 422); assert.equal(db.sent.length, 0); assert.equal(db.job.status, "failed");
  const db3 = fakeDb();
  const r3 = await completeWelcomeJob(db3 as any, { jobId: "j3", job: jobRow(ctx), output: script, mp4Base64: GIF, gifBase64: GIF, now: new Date() });
  assert.equal(r3.status, 422); assert.match(db3.cfg.welcome_status, /mp4 signature invalid/);
});

test("email provider failure is recorded, job still completes with media", async () => {
  const db = fakeDb(false);
  const r = await completeWelcomeJob(db as any, { jobId: "j4", job: jobRow(ctx), output: script, mp4Base64: MP4, gifBase64: GIF, now: new Date() });
  assert.equal(r.status, 200);
  assert.match(db.cfg.welcome_status, /^email_failed \(403/);
  assert.equal(db.cfg.welcome_sent_at, undefined);
});
