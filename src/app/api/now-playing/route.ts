import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const KEY = "now-playing";

function emptyNowPlaying() {
  return {
    title: null,
    artist: null,
    album: null,

    albumArtist: null,
    composer: null,
    genre: null,

    trackNumber: null,
    discNumber: null,

    persistentId: null,
    appleId: null,

    artwork: null,

    position: 0,
    duration: 0,

    playing: false,

    updatedAt: null,
    serverTime: Date.now(),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const updatedAt = Date.now();

    const data = {
      title: body.title ?? null,
      artist: body.artist ?? null,
      album: body.album ?? null,

      albumArtist: body.albumArtist ?? null,
      composer: body.composer ?? null,
      genre: body.genre ?? null,

      trackNumber: body.trackNumber ?? null,
      discNumber: body.discNumber ?? null,

      persistentId: body.persistentId ?? null,
      appleId: body.appleId ?? null,

      artwork: body.artwork ?? null,

      position: Number(body.position ?? 0),
      duration: Number(body.duration ?? 0),
      playing: Boolean(body.playing),

      updatedAt,
    };

    await redis.set(KEY, JSON.stringify(data));

    return NextResponse.json({
      success: true,
      updatedAt,
    });
  } catch (error) {
    console.error("now-playing POST error", error);

    return NextResponse.json(
      {
        success: false,
        error: "invalid payload",
      },
      {
        status: 400,
      },
    );
  }
}

export async function GET() {
  try {
    const raw = await redis.get(KEY);
    const serverTime = Date.now();

    if (!raw) {
      return NextResponse.json({
        ...emptyNowPlaying(),
        serverTime,
      });
    }

    const data = JSON.parse(raw);

    return NextResponse.json({
      ...data,
      serverTime,
    });
  } catch (error) {
    console.error("now-playing GET error", error);

    return NextResponse.json(
      {
        error: "redis error",
      },
      {
        status: 500,
      },
    );
  }
}
