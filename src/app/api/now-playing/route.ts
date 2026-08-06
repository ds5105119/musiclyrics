import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const KEY = "now-playing";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const data = {
      title: body.title ?? null,
      artist: body.artist ?? null,
      album: body.album ?? null,

      // playback
      position: body.position ?? 0,
      duration: body.duration ?? 0,
      playing: body.playing ?? false,

      // timestamp
      updatedAt: Date.now(),
    };

    await redis.set(KEY, data);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("now-playing POST error:", error);

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
        playing: false,
        title: null,
        artist: null,
        album: null,
        position: 0,
        duration: 0,
      },
    );
  } catch (error) {
    console.error("now-playing GET error:", error);

    return NextResponse.json(
      {
        playing: false,
        error: "redis error",
      },
      {
        status: 500,
      },
    );
  }
}
