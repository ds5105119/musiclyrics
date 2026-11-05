import { after, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "@/lib/r2";

export const runtime = "nodejs";
export const maxDuration = 30;

const BUCKET = process.env.R2_BUCKET!;
const R2_TIMEOUT_MS = 3500;
const MAX_LYRICS_BYTES = 512 * 1024;

function metadataKey(title: string, artist: string) {
  // Preserve Hangul/CJK instead of collapsing Korean-only tracks to '-'.
  const canonical = [artist, title].map((s) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase());
  return `lyrics/meta-v2-${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}.ttml`;
}

function cacheKeys(title: string, artist: string, appleId: string | null, persistentId: string | null) {
  const keys = [metadataKey(title, artist)];
  if (appleId) keys.push(`lyrics/apple-${appleId}.ttml`);
  if (persistentId) keys.push(`lyrics/persistent-${persistentId}.ttml`);
  const folded = [artist, title].map((s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""));
  const legacy = folded.map((s) => s.replace(/[^a-z0-9]/g, ""));
  // Read existing Latin metadata keys, never ambiguous stripped CJK keys.
  if (folded.every((s) => !/[^\x00-\x7f]/.test(s)) && legacy.every(Boolean)) keys.push(`lyrics/${legacy[0]}-${legacy[1]}.ttml`);
  return [...new Set(keys)];
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
  return Buffer.byteLength(body, "utf8") <= MAX_LYRICS_BYTES && /<(?:[\w.-]+:)?tt(?:\s|>)/.test(body);
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

async function readCache(keys: string[], failed: () => void) {
  try {
    // Return the first hit without waiting for another key's slow miss.
    return await deadline("R2 read", R2_TIMEOUT_MS, (signal) => Promise.any(keys.map(async (key) => {
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

async function fetchJSON(url: string, milliseconds: number, headers?: Record<string, string>): Promise<unknown> {
  return deadline("lyrics upstream", milliseconds, async (signal) => {
    const response = await fetch(url, { headers, signal, cache: "no-store" });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream HTTP ${response.status}`);
    }
    return response.json();
  });
}

type AppleSearch = { results?: { hasTimeSyncedLyrics?: boolean; playParams?: { id?: string } }[] };
type AppleLyrics = { type?: string; content?: string };
type LRCLyrics = { syncedLyrics?: string; instrumental?: boolean };

export async function GET(req: Request) {
  const started = performance.now();
  const timings: string[] = [];
  let unavailable = false;
  let cacheFailed = false;
  async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try { return await work(); }
    finally { timings.push(`${name};dur=${(performance.now() - at).toFixed(1)}`); }
  }
  const reply = (body: string, source: string, cache: string, status = 200, contentType = "application/ttml+xml") => {
    const total = performance.now() - started;
    console.info(`[lyrics] status=${status} source=${source} cache=${cache} total=${total.toFixed(0)}ms ${timings.join(" ")}`);
    return new NextResponse(body, { status, headers: {
      "Content-Type": contentType,
      "Cache-Control": status === 200 ? "public,max-age=3600" : "no-store",
      "X-Lyrics-Source": source,
      "X-Lyrics-Cache": cache,
      "Server-Timing": [...timings, `total;dur=${total.toFixed(1)}`].join(", "),
    } });
  };
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title")?.trim();
  const artist = searchParams.get("artist")?.trim();
  const appleId = searchParams.get("appleId")?.trim() || null;
  const persistentId = searchParams.get("persistentId")?.trim() || null;
  if (!title || !artist || title.length > 256 || artist.length > 256 ||
      (appleId && appleId.length > 128) || (persistentId && persistentId.length > 128)) {
    return reply(JSON.stringify({ error: "valid title and artist required" }), "none", "none", 400, "application/json");
  }

  const keys = cacheKeys(title, artist, appleId, persistentId);
  const hit = await timed("r2", () => readCache(keys, () => { cacheFailed = true; }));
  if (hit) return reply(hit.text, "r2", "hit");

  const token = process.env.PAXSENIX_API_TOKEN;
  let resolvedId = appleId;
  if (token) {
    const headers = { Authorization: `Bearer ${token}`, accept: "application/json" };
    try {
      if (!resolvedId) {
        const search = await timed("apple_search", () => fetchJSON(
          `https://api.paxsenix.org/apple-music/search?q=${encodeURIComponent(`${title} ${artist}`)}`, 4000, headers)) as AppleSearch | null;
        if (search && !Array.isArray(search.results)) throw new Error("invalid Apple search response");
        resolvedId = search?.results?.find((item) => item.hasTimeSyncedLyrics)?.playParams?.id || null;
      }
      if (resolvedId) {
        const resolvedKey = `lyrics/apple-${resolvedId}.ttml`;
        // Migrate old Apple-only bucket objects to the keys this client knows.
        if (!keys.includes(resolvedKey)) {
          const resolvedHit = await timed("r2_resolved", () => readCache([resolvedKey], () => { cacheFailed = true; }));
          keys.push(resolvedKey);
          if (resolvedHit) {
            storeAliases(keys.filter((key) => key !== resolvedKey), resolvedHit.text);
            return reply(resolvedHit.text, "r2", "hit-after-id");
          }
        }
        const apple = await timed("apple_lyrics", () => fetchJSON(
          `https://lyrics.paxsenix.org/apple-music/lyrics?id=${encodeURIComponent(resolvedId)}&ttml=true&skip_cache=false&v=1`,
          5000, headers)) as AppleLyrics | null;
        if (apple?.type === "TTML" && typeof apple.content === "string" && isTTML(apple.content)) {
          storeAliases(keys, apple.content);
          return reply(apple.content, "apple", cacheFailed ? "bypass" : "miss");
        }
      }
    } catch (error) {
      unavailable = true;
      console.warn("[lyrics] Apple lookup failed", error instanceof Error ? error.message : "unknown");
    }
  }

  try {
    const lrc = await timed("lrclib", () => fetchJSON(
      `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`, 4000)) as LRCLyrics | null;
    if (typeof lrc?.syncedLyrics === "string" && lrc.syncedLyrics.length > 0 &&
        Buffer.byteLength(lrc.syncedLyrics, "utf8") <= MAX_LYRICS_BYTES) {
      return reply(JSON.stringify({ type: "lrc", lyric: lrc.syncedLyrics }), "lrclib", cacheFailed ? "bypass" : "miss", 200, "application/json");
    }
    if (lrc?.instrumental) return reply(JSON.stringify({ instrumental: true }), "lrclib", "miss", 200, "application/json");
  } catch (error) {
    unavailable = true;
    console.warn("[lyrics] LRCLIB lookup failed", error instanceof Error ? error.message : "unknown");
  }
  if (unavailable || cacheFailed) {
    return reply(JSON.stringify({ error: "lyrics service temporarily unavailable" }), "none", cacheFailed ? "bypass" : "miss", 503, "application/json");
  }
  return reply(JSON.stringify({ found: false }), "none", "miss", 404, "application/json");
}
