// lib/calibration/clip-alias.ts
// SERVER ONLY.
// Calibration clip file names contain mode names ("… Reset Mode …"), which
// would reveal the clip → brain-mode mapping. The browser is only ever given
// an opaque alias; the real file name is resolved on the server.
//
// Aliases are an HMAC of the track id, so they are stable (no DB or storage
// rename needed) but cannot be reversed or guessed without the secret.

import { createHmac } from "crypto";
import { TRACK_IDS } from "@/types/calibration";

function secret(): string {
  const s =
    process.env.CALIBRATION_ALIAS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) {
    throw new Error(
      "Set CALIBRATION_ALIAS_SECRET (or SUPABASE_SERVICE_ROLE_KEY) on the server",
    );
  }
  return s;
}

export function aliasFor(trackId: string): string {
  return createHmac("sha256", secret()).update(trackId).digest("hex").slice(0, 24);
}

/** Returns the real track id for an alias, or null if unknown. */
export function resolveAlias(alias: string): string | null {
  for (const id of Object.values(TRACK_IDS)) {
    if (aliasFor(id) === alias) return id;
  }
  return null;
}