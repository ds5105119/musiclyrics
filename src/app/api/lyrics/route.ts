import { NextResponse } from "next/server";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { r2 } from "@/lib/r2";

const BUCKET = process.env.R2_BUCKET!;

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

function makeKey(title: string, artist: string, appleId?: string | null, persistentId?: string | null) {
  if (appleId) {
    return `lyrics/apple-${appleId}.ttml`;
  }

  if (persistentId) {
    return `lyrics/persistent-${persistentId}.ttml`;
  }

  return `lyrics/${normalize(artist)}-${normalize(title)}.ttml`;
}

async function getR2(Key: string) {
  try {
    const obj = await r2.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key,
      }),
    );

    if (!obj.Body) return null;

    return await obj.Body.transformToString();
  } catch {
    return null;
  }
}

async function putR2(Key: string, body: string) {
  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,

        Key,

        Body: body,

        ContentType: "application/ttml+xml",

        CacheControl: "public,max-age=31536000",
      }),
    );

    console.log("R2 uploaded", Key);
  } catch (e) {
    console.error("R2 upload failed", e);
  }
}

async function fetchAppleTTML(title: string, artist: string) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`);

    const search = await fetch(`https://api.paxsenix.org/apple-music/search?q=${query}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAXSENIX_API_TOKEN}`,
      },
    });

    if (!search.ok) return null;

    const searchJson = await search.json();

    const track = searchJson.results?.find((item: any) => item.hasTimeSyncedLyrics);

    if (!track) return null;

    const id = track.playParams?.id;

    if (!id) return null;

    const lyric = await fetch(`https://lyrics.paxsenix.org/apple-music/lyrics?id=${id}&ttml=true&skip_cache=false&v=1`, {
      headers: {
        accept: "application/json",

        Authorization: `Bearer ${process.env.PAXSENIX_API_TOKEN}`,
      },
    });

    if (!lyric.ok) return null;

    const json = await lyric.json();

    if (json.type !== "TTML" || !json.content) return null;

    const ttml = json.content;

    if (!ttml.includes("<tt")) return null;

    return {
      ttml,
      appleId: id,
    };
  } catch (e) {
    console.error("Apple error", e);

    return null;
  }
}

async function fetchLRCLIB(title: string, artist: string) {
  try {
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;

    const res = await fetch(url);

    if (!res.ok) return null;

    const json = await res.json();

    return json.syncedLyrics ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const title = searchParams.get("title");

  const artist = searchParams.get("artist");

  const album = searchParams.get("album");

  const appleId = searchParams.get("appleId");

  const persistentId = searchParams.get("persistentId");

  const duration = searchParams.get("duration");

  /*
    title + artist 필수
  */

  if (!title || !artist) {
    return NextResponse.json(
      {
        error: "title and artist required",
      },
      {
        status: 400,
      },
    );
  }

  const Key = makeKey(title, artist, appleId, persistentId);

  /*
    1. R2
  */

  const cached = await getR2(Key);

  if (cached) {
    return new NextResponse(cached, {
      headers: {
        "Content-Type": "application/ttml+xml",

        "Cache-Control": "public,max-age=31536000",
      },
    });
  }

  /*
    2. Apple Music
  */

  const apple = await fetchAppleTTML(title, artist);

  if (apple) {
    const finalKey = makeKey(title, artist, apple.appleId, persistentId);

    await putR2(finalKey, apple.ttml);

    return new NextResponse(apple.ttml, {
      headers: {
        "Content-Type": "application/ttml+xml",
      },
    });
  }

  /*
    3. LRCLIB
  */

  const lrc = await fetchLRCLIB(title, artist);

  if (lrc) {
    return NextResponse.json({
      type: "lrc",

      lyric: lrc,
    });
  }

  return NextResponse.json(
    {
      found: false,
    },
    {
      status: 404,
    },
  );
}
