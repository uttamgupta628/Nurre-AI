// GET /api/calibration/clip/:alias
// Streams a calibration clip WITHOUT exposing its real file name to the
// browser. Requires a signed-in user. Supports Range requests (audio seeking).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { resolveAlias } from "@/lib/calibration/clip-alias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signed URLs are valid for 300 s; reuse them for 240 s so repeat requests
// skip the extra Supabase round-trip.
const signedUrlCache = new Map<string, { url: string; exp: number }>();

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

    // If the clips were renamed to their alias (scripts/rename-calibration-clips.mjs)
    // even the redirect target reveals nothing about the mode.
    // CALIBRATION_CLIP_FORMAT=mp3 → use the small compressed copies made by
    // scripts/compress-calibration-clips.mjs (~10x smaller, starts much faster).
    const ext = process.env.CALIBRATION_CLIP_FORMAT === "mp3" ? "mp3" : "wav";
    const objectPath =
      ext === "mp3" || process.env.CALIBRATION_CLIPS_RENAMED === "true"
        ? `${alias}.${ext}`
        : `${trackId}.${ext}`;

    let signedUrl: string;
    const cached = signedUrlCache.get(alias);
    if (cached && cached.exp > Date.now()) {
      signedUrl = cached.url;
    } else {
      const supabase = createServiceClient();
      const { data, error } = await supabase.storage
        .from("calibration-tracks")
        .createSignedUrl(objectPath, 300);
      if (error || !data?.signedUrl) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      signedUrl = data.signedUrl;
      if (signedUrlCache.size > 200) signedUrlCache.clear();
      signedUrlCache.set(alias, { url: signedUrl, exp: Date.now() + 240_000 });
    }

    // FAST PATH (default): send the browser straight to Supabase's CDN.
    // Streaming ~10 MB WAV files through a serverless function was the cause
    // of the 10-12 s delays. Set CALIBRATION_CLIP_DELIVERY=proxy to stream
    // through the server again (slower).
    if (process.env.CALIBRATION_CLIP_DELIVERY !== "proxy") {
      const res = NextResponse.redirect(signedUrl, 302);
      res.headers.set("Cache-Control", "private, max-age=240");
      return res;
    }

    const range = req.headers.get("range");
    const upstream = await fetch(signedUrl, {
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