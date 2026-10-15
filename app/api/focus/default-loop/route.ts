// GET /api/focus/default-loop?mode=Flow
// Returns the soundscape file that belongs to a brain mode, found by looking
// at what is actually uploaded in the "focus-loops" bucket (newest matching
// "Soundscape …" file wins). This way replacing/uploading a new soundscape
// in storage is picked up without a code change.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: Record<string, { include: string[]; exclude: string[] }> = {
  "Deep Reset": { include: ["deep reset"], exclude: [] },
  Reset: { include: ["reset"], exclude: ["deep reset"] },
  Start: { include: ["start"], exclude: [] },
  "Deep Focus": { include: ["deep focus"], exclude: ["deep reset"] },
  Flow: { include: ["flow"], exclude: [] },
  Ground: { include: ["ground"], exclude: [] },
};

export async function GET(req: NextRequest) {
  try {
    await getAuthUser();
    const mode = req.nextUrl.searchParams.get("mode") || "";
    const rule = MODES[mode];
    if (!rule) return NextResponse.json({ error: "Invalid mode" }, { status: 400 });

    const supabase = createServiceClient();
    const { data: files, error } = await supabase.storage
      .from("focus-loops")
      .list("", { limit: 200 });
    if (error || !files) return NextResponse.json({ url: null });

    const candidates = files
      .filter((f) => /\.(mp3|wav|m4a|ogg)$/i.test(f.name))
      .filter((f) => {
        const n = f.name.toLowerCase();
        return (
          rule.include.some((k) => n.includes(k)) &&
          !rule.exclude.some((k) => n.includes(k))
        );
      })
      .sort((a, b) => {
        const sa = a.name.toLowerCase().includes("soundscape") ? 1 : 0;
        const sb = b.name.toLowerCase().includes("soundscape") ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return (
          new Date(b.updated_at ?? 0).getTime() -
          new Date(a.updated_at ?? 0).getTime()
        );
      });

    if (candidates.length === 0) return NextResponse.json({ url: null });

    const { data } = supabase.storage
      .from("focus-loops")
      .getPublicUrl(candidates[0].name);
    return NextResponse.json({ url: data.publicUrl });
  } catch (err: unknown) {
    const unauthorized = err instanceof Error && err.message === "Unauthorized";
    return NextResponse.json(
      { error: unauthorized ? "Unauthorized" : "Failed" },
      { status: unauthorized ? 401 : 500 },
    );
  }
}