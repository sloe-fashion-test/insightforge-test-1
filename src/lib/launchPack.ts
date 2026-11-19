// Reads a launch pack file. The file is markdown with one ```json block, or
// plain JSON. The full check happens in the load-launch-pack function; this
// only finds and parses the JSON so the owner gets a clear message early.

export interface LaunchPackSource {
  url: string;
  name?: string;
  first_party?: boolean;
}

export interface LaunchPack {
  version: number;
  sources?: LaunchPackSource[];
  approve_sources?: boolean;
  schedule?: unknown[];
  [key: string]: unknown;
}

export interface ParseResult {
  ok: boolean;
  pack?: LaunchPack;
  error?: string;
}

export function parseLaunchPack(text: string): ParseResult {
  const raw = (text ?? "").trim();
  if (!raw) return { ok: false, error: "Paste the launch pack or choose the file first." };

  let candidate = raw;
  if (!raw.startsWith("{")) {
    const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(raw);
    if (!fence) {
      return { ok: false, error: "No JSON block found. The launch pack must contain one block that starts with ```json." };
    }
    candidate = fence[1].trim();
  }

  try {
    const pack = JSON.parse(candidate);
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      return { ok: false, error: "The JSON block is not an object." };
    }
    return { ok: true, pack: pack as LaunchPack };
  } catch (e) {
    return {
      ok: false,
      error: `The JSON block has a mistake: ${e instanceof Error ? e.message : "could not read it"}. Ask Claude to fix the JSON block and paste it again.`,
    };
  }
}
