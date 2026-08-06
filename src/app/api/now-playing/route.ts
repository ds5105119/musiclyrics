import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const KEY = "now-playing";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const data = {
      // music metadata

      title: body.title ?? null,

      artist: body.artist ?? null,

      album: body.album ?? null,

      albumArtist: body.albumArtist ?? null,

      composer: body.composer ?? null,

      genre: body.genre ?? null,

      trackNumber: body.trackNumber ?? null,

      discNumber: body.discNumber ?? null,

      // Apple Music identifiers

      persistentId: body.persistentId ?? null,

      appleId: body.appleId ?? null,

      // artwork

      artwork: body.artwork ?? null,

      // playback

      position: Number(body.position ?? 0),

      duration: Number(body.duration ?? 0),

      playing: Boolean(body.playing),

      // client timestamp

      updatedAt: Date.now(),
    };

    await redis.set(KEY, data);

    return NextResponse.json({
      success: true,
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
    const data = await redis.get(KEY);

    return NextResponse.json(
      data ?? {
        title: null,
        artist: null,
        album: null,

        albumArtist: null,
        composer: null,
        genre: null,

        persistentId: null,
        appleId: null,

        artwork: null,

        position: 0,
        duration: 0,

        playing: false,

        updatedAt: null,
      },
    );
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
