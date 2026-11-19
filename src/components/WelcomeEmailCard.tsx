import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Mail, PlayCircle } from "lucide-react";

interface WelcomeStatus {
  status: string | null;
  sent_at: string | null;
  video_url: string | null;
  gif_url: string | null;
}

// One-time welcome email + short video, written by the install's Claude
// worker and sent through Resend (supabase/functions/welcome-start).
export function WelcomeEmailCard() {
  const [info, setInfo] = useState<WelcomeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = await supabase.functions.invoke("welcome-start", { body: { action: "status" } });
    if (data && !data.error) setInfo(data as WelcomeStatus);
  };
  useEffect(() => { load(); }, []);

  const sendAgain = async () => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("welcome-start", { body: { force: true } });
    setBusy(false);
    if (error || data?.error) {
      toast.error(`Could not queue the welcome email: ${data?.error ?? error?.message ?? "unknown error"}`);
      return;
    }
    toast.success("Welcome email queued. Your Claude worker writes it and renders the video in a few minutes.");
    load();
  };

  const status = info?.status ?? null;
  const label = !status ? "Not sent yet"
    : status === "sent" ? `Sent${info?.sent_at ? ` ${new Date(info.sent_at).toLocaleString()}` : ""}`
    : status === "queued" ? "Queued: the worker is writing it now"
    : status;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" />Welcome email</CardTitle>
        <CardDescription>
          A one-time email with a short video that explains what this InsightForge is set up to do.
          It is written on your Claude subscription and sent to your login email.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm"><span className="text-muted-foreground">Status:</span> {label}</p>
        {info?.gif_url && info?.video_url && (
          <a href={info.video_url} target="_blank" rel="noreferrer" className="block max-w-md">
            <img src={info.gif_url} alt="Welcome video preview" className="rounded-lg border w-full" />
            <span className="mt-2 inline-flex items-center gap-1 text-sm text-primary">
              <PlayCircle className="h-4 w-4" />Watch the welcome video
            </span>
          </a>
        )}
        <Button variant="outline" onClick={sendAgain} disabled={busy}>
          {busy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Queueing...</> : (status ? "Send again" : "Send welcome email")}
        </Button>
      </CardContent>
    </Card>
  );
}
