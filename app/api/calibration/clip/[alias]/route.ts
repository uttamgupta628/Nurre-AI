// GET /api/calibration/clip/:alias
// Streams a calibration clip WITHOUT exposing its real file name to the
// browser. Requires a signed-in user. Supports Range requests (audio seeking).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { resolveAlias } from "@/lib/calibration/clip-alias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ alias: string }> },
) {
  try {
    await getAuthUser();

    const { alias } = await params;
    if (!/^[0-9a-f]{24}$/.test(alias)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const trackId = resolveAlias(alias);
    if (!trackId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.storage
      .from("calibration-tracks")
      .createSignedUrl(`${trackId}.wav`, 60);

    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const range = req.headers.get("range");
    const upstream = await fetch(data.signedUrl, {
      headers: range ? { Range: range } : undefined,
    });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("Cache-Control", "private, max-age=3600");

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    return NextResponse.json(
      { error: message === "Unauthorized" ? "Unauthorized" : "Failed" },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}