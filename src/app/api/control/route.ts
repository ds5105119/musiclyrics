import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const ACTIONS = ["toggle", "next", "previous"] as const;

type MusicAction = (typeof ACTIONS)[number];

interface MusicControlRequest {
  action: MusicAction;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MusicControlRequest;

    if (!ACTIONS.includes(body.action)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid action",
        },
        { status: 400 },
      );
    }

    await redis.rpush("music:commands", body.action);

    return NextResponse.json(
      {
        ok: true,
        action: body.action,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("Music control error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Failed to enqueue music command",
      },
      { status: 500 },
    );
  }
}
