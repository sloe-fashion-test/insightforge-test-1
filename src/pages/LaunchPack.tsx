import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { parseLaunchPack, type LaunchPack, type LaunchPackSource } from "@/lib/launchPack";

type StepState = "idle" | "running" | "done" | "failed";

// Launch page: load the launch pack the owner approved in Part 1.
// 1. Validate the pack and write the strategy setup (load-launch-pack).
// 2. Add each source one at a time (create-manual-source), so progress shows.
// 3. Open Schedule, which starts the first batch of 12 drafts by itself.
const LaunchPackPage = () => {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [setupState, setSetupState] = useState<StepState>("idle");
  const [setupNote, setSetupNote] = useState("");
  const [sourceState, setSourceState] = useState<StepState>("idle");
  const [sourceProgress, setSourceProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [readState, setReadState] = useState<StepState>("idle");
  const [readProgress, setReadProgress] = useState({ ready: 0, total: 0 });
  const [pack, setPack] = useState<LaunchPack | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
  };

  const readInvokeErrors = async (err: unknown): Promise<string[]> => {
    const error = err as { message?: string; context?: { json?: () => Promise<{ errors?: unknown[]; error?: unknown }> } } | null;
    try {
      const body = await error?.context?.json?.();
      if (Array.isArray(body?.errors)) return body.errors.map(String);
      if (body?.error) return [String(body.error)];
    } catch {
      // not JSON
    }
    return [error?.message || "The request failed."];
  };

  const addSources = async (p: LaunchPack): Promise<string[]> => {
    const sources: LaunchPackSource[] = Array.isArray(p.sources) ? (p.sources as LaunchPackSource[]) : [];
    const approve = p.approve_sources !== false;
    setSourceState("running");
    setSourceProgress({ done: 0, total: sources.length, failed: 0 });
    let done = 0;
    let failed = 0;
    const cardIds: string[] = [];
    for (const s of sources) {
      const firstParty = s.first_party === true;
      const { data, error } = await supabase.functions.invoke("create-manual-source", {
        body: { type: "url", url: s.url, from_company: firstParty, force_keep: firstParty },
      });
      if (error || !data?.cardId) {
        failed++;
      } else if (approve) {
        cardIds.push(data.cardId);
        // The owner approved the pack preview, so its sources count as approved.
        await supabase.from("reference_cards").update({ approved: true }).eq("id", data.cardId);
      }
      done++;
      setSourceProgress({ done, total: sources.length, failed });
    }
    setSourceState(failed === sources.length && sources.length > 0 ? "failed" : "done");
    return cardIds;
  };

  // Drafts quote the short summary of each source. Give the summaries a few
  // minutes to finish before the first drafts start. After the wait the drafts
  // start anyway, so a slow worker never blocks the install.
  const waitForSummaries = async (cardIds: string[]) => {
    if (!cardIds.length) return;
    setReadState("running");
    const deadline = Date.now() + 4 * 60 * 1000;
    let ready = 0;
    while (Date.now() < deadline) {
      const { data } = await supabase
        .from("reference_cards")
        .select("id, ai_summary, summary_state" as string)
        .in("id", cardIds);
      const rows = (data ?? []) as unknown as { id: string; ai_summary: string | null; summary_state: string | null }[];
      ready = rows.filter((r) => (r.ai_summary && String(r.ai_summary).trim()) || r.summary_state === "failed").length;
      setReadProgress({ ready, total: cardIds.length });
      if (ready >= rows.length) break;
      await new Promise((r) => setTimeout(r, 10000));
    }
    setReadState("done");
  };

  const run = async () => {
    setErrors([]);
    const parsed = parseLaunchPack(text);
    if (!parsed.ok || !parsed.pack) {
      setErrors([parsed.error ?? "The pack could not be read."]);
      return;
    }
    const loaded: LaunchPack = parsed.pack;
    setPack(loaded);
    setBusy(true);
    setSetupState("running");
    setSetupNote("");
    setSourceState("idle");

    const { data, error } = await supabase.functions.invoke("load-launch-pack", {
      body: { pack: loaded, replace },
    });
    if (error || !data?.ok) {
      const list = error ? await readInvokeErrors(error) : (data?.errors ?? ["The request failed."]);
      setErrors(list);
      setSetupState("failed");
      setBusy(false);
      return;
    }
    const skipped: string[] = data.skipped ?? [];
    setSetupNote(
      skipped.length
        ? `Saved. Kept what was already there: ${skipped.join("; ")}.`
        : "Saved profile, audience, rules, formats, natures, jobs, lanes, readers, topics and schedule."
    );
    setSetupState("done");

    const cardIds = await addSources(loaded);
    await waitForSummaries(cardIds);
    setBusy(false);
    toast.success("Launch pack loaded. Starting your first drafts.");
    navigate("/schedule?tab=cadence&autorun=12");
  };

  const icon = (s: StepState) =>
    s === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> :
    s === "done" ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
    s === "failed" ? <XCircle className="h-4 w-4 text-red-600" /> :
    <Circle className="h-4 w-4 text-muted-foreground" />;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="mr-2 h-4 w-4" />Back to dashboard
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        <h1 className="text-3xl font-bold mb-2">Load your launch pack</h1>
        <p className="text-muted-foreground mb-6">
          Use the launch pack you approved in Part 1. This page loads it, adds your sources, and starts your first 12 drafts.
        </p>

        <ul className="list-disc pl-5 mb-6 text-sm space-y-1">
          <li>Choose the insightforge-launch-pack.md file, or paste its text below.</li>
          <li>Press Load. Keep this tab open until Schedule opens.</li>
          <li>Drafts take a few minutes. They appear in Review.</li>
        </ul>

        <input
          type="file"
          accept=".md,.json,.txt"
          className="mb-3 block text-sm"
          onChange={(e) => onFile(e.target.files?.[0])}
          disabled={busy}
        />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the launch pack here"
          className="min-h-[220px] font-mono text-xs"
          disabled={busy}
        />

        <div className="flex items-center gap-2 mt-3">
          <Checkbox id="replace" checked={replace} onCheckedChange={(v) => setReplace(v === true)} disabled={busy} />
          <Label htmlFor="replace" className="text-sm">
            Replace my setup (turn on if this account already has formats, natures or a schedule)
          </Label>
        </div>

        <div className="mt-4">
          <Button onClick={run} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Load launch pack
          </Button>
        </div>

        {errors.length > 0 && (
          <div className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm">
            <p className="font-medium mb-2">Fix these items. Nothing was loaded.</p>
            <ul className="list-disc pl-5 space-y-1">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
            <p className="mt-2">Send this list to Claude with the pack. Ask it to fix the pack and give you the file again.</p>
          </div>
        )}

        {(setupState !== "idle" || sourceState !== "idle") && (
          <ul className="mt-6 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              {icon(setupState)}
              <span>Strategy setup{setupNote ? `: ${setupNote}` : ""}</span>
            </li>
            <li className="flex items-start gap-2">
              {icon(sourceState)}
              <span>
                Sources{sourceProgress.total ? `: ${sourceProgress.done} of ${sourceProgress.total}` : ""}
                {sourceProgress.failed ? ` (${sourceProgress.failed} could not be read)` : ""}
              </span>
            </li>
            <li className="flex items-start gap-2">
              {icon(readState)}
              <span>
                Reading sources{readProgress.total ? `: ${readProgress.ready} of ${readProgress.total} ready` : ""}
                {readState === "running" ? " (waits up to 4 minutes)" : ""}
              </span>
            </li>
            <li className="flex items-start gap-2">
              {icon(pack && readState === "done" ? "running" : "idle")}
              <span>First 12 drafts</span>
            </li>
          </ul>
        )}
      </main>
    </div>
  );
};

export default LaunchPackPage;
