import { NextResponse } from "next/server";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { r2 } from "@/lib/r2";

const BUCKET = process.env.R2_BUCKET!;

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function key(title: string, artist: string) {
  return `${normalize(artist)}-${normalize(title)}.ttml`;
}

async function getR2(Key: string) {
  try {
    const obj = await r2.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key,
      }),
    );

    return await obj.Body?.transformToString();
  } catch {
    return null;
  }
}

async function putR2(Key: string, body: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,

      Key,

      Body: body,

      ContentType: "application/ttml+xml",
    }),
  );
}

async function appleMusic(title: string, artist: string) {
  const q = encodeURIComponent(`${title} ${artist}`);

  const search = await fetch(`https://api.paxsenix.org/apple-music/search?q=${q}`, {
    headers: {
      Authorization: `Bearer ${process.env.PAXSENIX_API_TOKEN}`,
    },
  });

  if (!search.ok) return null;

  const data = await search.json();

  const track = data.results?.[0];

  if (!track) return null;

  if (!track.hasTimeSyncedLyrics) return null;

  const id = track.playParams.id;

  const lyric = await fetch(`https://api.paxsenix.org/lyrics/applemusic?id=${id}`, {
    headers: {
      Authorization: `Bearer ${process.env.PAXSENIX_API_TOKEN}`,
    },
  });

  if (!lyric.ok) return null;

  const json = await lyric.json();

  return json.ttmlContent ?? null;
}

async function lrclib(title: string, artist: string) {
  const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;

  const res = await fetch(url);

  if (!res.ok) return null;

  const data = await res.json();

  return data.syncedLyrics ?? null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const title = searchParams.get("title");

  const artist = searchParams.get("artist");

  if (!title || !artist) {
    return NextResponse.json(
      {
        error: "missing params",
      },
      {
        status: 400,
      },
    );
  }

  const Key = key(title, artist);

  // 1. R2 cache

  const cached = await getR2(Key);

  if (cached) {
    return new NextResponse(cached, {
      headers: {
        "Content-Type": "application/ttml+xml",
      },
    });
  }

  // 2. Apple Music

  const ttml = await appleMusic(title, artist);

  if (ttml) {
    await putR2(Key, ttml);

    return new NextResponse(ttml, {
      headers: {
        "Content-Type": "application/ttml+xml",
      },
    });
  }

  // 3. LRCLIB

  const lrc = await lrclib(title, artist);

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
