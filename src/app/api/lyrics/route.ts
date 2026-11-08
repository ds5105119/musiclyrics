import { after, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "@/lib/r2";
import { catalogId, lookupCountries, mergeTracks, metadataText, parseCatalogResults,
  rankTracks, searchQueries, type CatalogTrack, type TrackIdentity } from "@/lib/lyrics-match";

export const runtime = "nodejs";
export const maxDuration = 30;

const BUCKET = process.env.R2_BUCKET!;
const R2_TIMEOUT_MS = 3500;
const MAX_LYRICS_BYTES = 512 * 1024;

// v2 metadata aliases were written without checking which song was selected.
// Keep old objects intact, but reuse only verified catalog-ID objects or v3
// metadata aliases that include album/duration and the explicit ID context.
function metadataKey(track: TrackIdentity, appleId?: string) {
  const context = [track.artist, track.title, track.album || ""].map(metadataText);
  return `lyrics/meta-v3-${createHash("sha256").update(JSON.stringify([
    ...context, track.duration ? Math.round(track.duration * 1000) : null, appleId || null,
  ])).digest("hex")}.ttml`;
}

async function deadline<T>(label: string, milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${milliseconds}ms`));
      controller.abort();
    }, milliseconds);
  });
  try {
    // Covers response-body consumption, not just receiving headers.
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function isTTML(body: string) {
  return Buffer.byteLength(body, "utf8") <= MAX_LYRICS_BYTES && /<(?:[\w.-]+:)?tt(?:\s|>)/.test(body) && /<(?:[\w.-]+:)?p(?:\s|>)/.test(body);
}

function isMissingObject(error: unknown) {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

async function readR2(key: string, signal: AbortSignal) {
  const obj = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: signal });
  if (!obj.Body) return null;
  const body = obj.Body;
  const stream = body as typeof body & { destroy?: () => void };
  const abort = () => stream.destroy?.();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) { abort(); return null; }
    const text = await body.transformToString();
    if (!isTTML(text)) {
      console.warn("[lyrics] ignoring invalid cached TTML", key);
      return null;
    }
    return { key, text };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readCache(keys: string[], failed: () => void, milliseconds = R2_TIMEOUT_MS) {
  try {
    // Return the first hit without waiting for another key's slow miss.
    return await deadline("R2 read", milliseconds, (signal) => Promise.any(keys.map(async (key) => {
      try {
        const hit = await readR2(key, signal);
        if (hit) return hit;
      } catch (error) {
        if (!signal.aborted && !isMissingObject(error)) {
          failed();
          console.warn("[lyrics] R2 read failed", key, error instanceof Error ? error.name : "unknown");
        }
      }
      throw new Error("cache miss");
    })));
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      failed();
      console.warn("[lyrics] R2 lookup deadline", error instanceof Error ? error.message : "unknown");
    }
    return null;
  }
}

function storeAliases(keys: string[], text: string) {
  // Keep cache PUT latency out of the device's response time. after() keeps
  // the work alive on Vercel; an unawaited promise alone would not do so.
  after(async () => {
    await Promise.allSettled([...new Set(keys)].map(async (key) => {
      try {
        await deadline("R2 write", R2_TIMEOUT_MS, (signal) => r2.send(new PutObjectCommand({
          Bucket: BUCKET, Key: key, Body: text,
          ContentType: "application/ttml+xml", CacheControl: "public,max-age=31536000",
        }), { abortSignal: signal }));
      } catch (error) {
        console.warn("[lyrics] R2 alias write failed", key, error instanceof Error ? error.name : "unknown");
      }
    }));
  });
}

class UpstreamError extends Error {
  constructor(readonly status: number) { super(`upstream HTTP ${status}`); }
}
async function fetchJSON(url: string, milliseconds: number, headers?: Record<string, string>): Promise<unknown> {
  return deadline("catalog upstream", milliseconds, async (signal) => {
    const response = await fetch(url, { headers, signal, cache: "no-store" });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(response.status);
    }
    return response.json();
  });
}
async function fetchAppleLyrics(id: string, milliseconds: number, headers: Record<string, string>) {
  return deadline("Apple lyrics", milliseconds, async (signal) => {
    const response = await fetch(
      `https://lyrics.paxsenix.org/apple-music/lyrics?id=${encodeURIComponent(id)}&ttml=true&skip_cache=false&v=1`,
      { headers, signal, cache: "no-store" });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status); }
    const body = await response.text();
    if (isTTML(body)) return body;
    const payload = JSON.parse(body) as { type?: string; content?: unknown; error?: unknown; ok?: boolean };
    if (payload.error || payload.ok === false) throw new UpstreamError(502);
    return payload.type?.toUpperCase() === "TTML" && typeof payload.content === "string" && isTTML(payload.content)
      ? payload.content : null;
  });
}

// A busy proxy must not receive three more lyric requests for alternate IDs
// on every device retry. R2 and catalog search remain available during backoff.
let appleLyricsRetryAt = 0;
const REQUEST_BUDGET_MS = 25000; // Leave time for after() writes within maxDuration.
const MAX_APPLE_ATTEMPTS = 3;
type LRCLyrics = { syncedLyrics?: string; instrumental?: boolean };

export async function GET(req: Request) {
  const started = performance.now();
  const timings: string[] = [];
  let unavailable = false, cacheFailed = false;
  let matchedId: string | undefined;
  let acceptedTrack: TrackIdentity | undefined;
  const remaining = () => Math.max(0, REQUEST_BUDGET_MS - (performance.now() - started));
  const budget = (maximum: number) => {
    if (remaining() < 150) throw new Error("lyrics request budget exhausted");
    return Math.max(1, Math.min(maximum, Math.floor(remaining())));
  };
  async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try { return await work(); }
    finally { timings.push(`${name};dur=${(performance.now() - at).toFixed(1)}`); }
  }
  const reply = (body: string, source: string, cache: string, status = 200, contentType = "application/ttml+xml") => {
    const total = performance.now() - started;
    console.info(`[lyrics] status=${status} source=${source} cache=${cache} matched=${matchedId || "none"} total=${total.toFixed(0)}ms ${timings.join(" ")}`);
    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": status === 200 ? "public,max-age=3600" : "no-store",
      "X-Lyrics-Source": source,
      "X-Lyrics-Cache": cache,
      // Keep response headers bounded for the embedded HTTP client.
      "Server-Timing": [...timings.slice(-7), `total;dur=${total.toFixed(1)}`].join(", "),
    };
    if (matchedId) responseHeaders["X-Lyrics-Apple-Id"] = matchedId;
    if (status === 503) responseHeaders["Retry-After"] = "15";
    return new NextResponse(body, { status, headers: responseHeaders });
  };
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title")?.trim();
  const artist = searchParams.get("artist")?.trim();
  const album = searchParams.get("album")?.trim() || undefined;
  const rawAppleId = searchParams.get("appleId")?.trim();
  const persistentId = searchParams.get("persistentId")?.trim();
  const rawDuration = searchParams.get("duration");
  const duration = rawDuration ? Number(rawDuration) : 0;
  if (!title || !artist || title.length > 256 || artist.length > 256 || (album && album.length > 256) ||
      (rawAppleId && rawAppleId.length > 128) || (persistentId && persistentId.length > 128) ||
      !Number.isFinite(duration) || duration < 0 || duration > 86400) {
    return reply(JSON.stringify({ error: "valid title, artist, album and duration required" }), "none", "none", 400, "application/json");
  }
  const identity: TrackIdentity = { title, artist, album, duration: duration || undefined };
  const appleId = catalogId(rawAppleId);
  // A library persistent ID is not a global Apple catalog ID. Never use it as
  // the sole shared-cache identity across devices/libraries.
  const aliasKey = metadataKey(identity, appleId);
  const checkedKeys = new Set<string>();
  async function cached(key: string, stage: string) {
    if (checkedKeys.has(key)) return null;
    checkedKeys.add(key);
    return timed(stage, () => readCache([key], () => { cacheFailed = true; }, budget(R2_TIMEOUT_MS)));
  }
  try {
    const key = appleId ? `lyrics/apple-${appleId}.ttml` : aliasKey;
    const hit = await cached(key, "r2");
    if (hit) { matchedId = appleId; return reply(hit.text, "r2", "hit"); }
  } catch { unavailable = true; }

  const token = process.env.PAXSENIX_API_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}`, accept: "application/json" } : undefined;
  const attemptedIds = new Set<string>();
  let attempts = 0;
  async function tryTrack(id: string) {
    if (attemptedIds.has(id) || attempts >= MAX_APPLE_ATTEMPTS || remaining() < 250) return null;
    attemptedIds.add(id); ++attempts;
    try {
      const hit = await cached(`lyrics/apple-${id}.ttml`, `r2_song_${attempts}`);
      if (hit) {
        matchedId = id;
        storeAliases([aliasKey], hit.text);
        return reply(hit.text, "r2", "hit-after-id");
      }
      if (!headers) { unavailable = true; return null; }
      if (Date.now() < appleLyricsRetryAt) { unavailable = true; return null; }
      const ttml = await timed(`apple_lyrics_${attempts}`, () => fetchAppleLyrics(id, budget(8000), headers));
      if (ttml) {
        matchedId = id;
        // Write ONLY this matched ID, never every attempted/failed ID.
        storeAliases([aliasKey, `lyrics/apple-${id}.ttml`], ttml);
        return reply(ttml, "apple", cacheFailed ? "bypass" : "miss");
      }
    } catch (error) {
      unavailable = true;
      if (error instanceof UpstreamError && (error.status === 429 || error.status === 503)) appleLyricsRetryAt = Date.now() + 15000;
      console.warn("[lyrics] Apple lyrics failed", id, error instanceof Error ? error.message : "unknown");
    }
    return null;
  }
  if (appleId) {
    const direct = await tryTrack(appleId);
    if (direct) return direct;
  }

  const catalog = new Map<string, CatalogTrack>();
  const countries = lookupCountries(identity);
  const enriched = new Set<string>();
  const queries = searchQueries(identity);
  for (let index = 0; index < queries.length && attempts < MAX_APPLE_ATTEMPTS && remaining() > 1500; ++index) {
    const query = queries[index];
    if (headers) {
      try {
        const search = await timed(`apple_search_${index + 1}`, () => fetchJSON(
          `https://api.paxsenix.org/apple-music/search?q=${encodeURIComponent(query)}`, budget(4000), headers));
        if (search) mergeTracks(catalog, parseCatalogResults(search, "pax"));
      } catch (error) {
        unavailable = true;
        console.warn("[lyrics] Apple catalog search failed", error instanceof Error ? error.message : "unknown");
      }
    }
    // The proxy localizes names to English. Bind Korean/Japanese names to the
    // SAME catalog ID; never infer a translation from a loose title match.
    if (countries.length && catalog.size && remaining() > 500) {
      await Promise.all(countries.map(async (country) => {
        const ids = [...catalog.keys()].filter((id) => !enriched.has(`${country}:${id}`)).slice(0, 50);
        if (!ids.length) return;
        try {
          const rows = await timed(`aliases_${country}`, () => fetchJSON(
            `https://itunes.apple.com/lookup?id=${ids.join(",")}&country=${country}`, budget(2500)));
          if (rows) mergeTracks(catalog, parseCatalogResults(rows, "itunes"), true);
          for (const id of ids) enriched.add(`${country}:${id}`);
        } catch (error) {
          unavailable = true;
          console.warn("[lyrics] Localized catalog lookup failed", country, error instanceof Error ? error.message : "unknown");
        }
      }));
    }
    // Broader title retrieval is only a fallback. Every candidate still passes
    // title + artist + version-preserving comparison and duration validation.
    let ranked = rankTracks(identity, catalog.values());
    if (!ranked.length && remaining() > 1000) {
      await Promise.all((countries.length ? countries : ["us"]).map(async (country) => {
        try {
          const rows = await timed(`regional_${country}`, () => fetchJSON(
            `https://itunes.apple.com/search?${new URLSearchParams({ term: query, country, media: "music", entity: "song", limit: "25" })}`,
            budget(2500)));
          if (rows) mergeTracks(catalog, parseCatalogResults(rows, "itunes"));
        } catch (error) {
          unavailable = true;
          console.warn("[lyrics] Regional search failed", country, error instanceof Error ? error.message : "unknown");
        }
      }));
      ranked = rankTracks(identity, catalog.values());
    }
    console.info("[lyrics] catalog match", { query, candidates: catalog.size, eligible: ranked.length,
      album: identity.album || null, duration: identity.duration || null,
      top: ranked.slice(0, 3).map((r) => ({ id: r.track.id, score: r.score, durationDelta: r.durationDelta })) });
    for (const match of ranked) {
      if (!acceptedTrack) acceptedTrack = match.track.variants[0];
      const result = await tryTrack(match.track.id);
      if (result) return result;
      if (attempts >= MAX_APPLE_ATTEMPTS || remaining() < 1000) break;
    }
  }

  // Preserve the original identity on fallback. Album/duration distinguish
  // alternate recordings; do not remove every parenthesis or split band names.
  const fallbacks = [identity];
  if (acceptedTrack && (acceptedTrack.title !== title || acceptedTrack.artist !== artist)) fallbacks.push(acceptedTrack);
  for (const track of fallbacks) {
    if (remaining() < 150) { unavailable = true; break; }
    try {
      const params = new URLSearchParams({ artist_name: track.artist, track_name: track.title });
      if (track.album) params.set("album_name", track.album);
      if (track.duration) params.set("duration", String(track.duration));
      const lrc = await timed("lrclib", () => fetchJSON(`https://lrclib.net/api/get?${params}`, budget(3000))) as LRCLyrics | null;
      if (typeof lrc?.syncedLyrics === "string" && lrc.syncedLyrics.trim() &&
          Buffer.byteLength(lrc.syncedLyrics, "utf8") <= MAX_LYRICS_BYTES) {
        return reply(JSON.stringify({ type: "lrc", lyric: lrc.syncedLyrics }), "lrclib", cacheFailed ? "bypass" : "miss", 200, "application/json");
      }
      if (lrc?.instrumental && !unavailable && !cacheFailed) return reply(JSON.stringify({ instrumental: true }), "lrclib", "miss", 200, "application/json");
    } catch (error) {
      unavailable = true;
      console.warn("[lyrics] LRCLIB lookup failed", error instanceof Error ? error.message : "unknown");
    }
  }
  if (remaining() < 150) unavailable = true;
  if (unavailable || cacheFailed || !token) {
    return reply(JSON.stringify({ error: "lyrics service temporarily unavailable" }), "none", cacheFailed ? "bypass" : "miss", 503, "application/json");
  }
  return reply(JSON.stringify({ found: false }), "none", "miss", 404, "application/json");
}
