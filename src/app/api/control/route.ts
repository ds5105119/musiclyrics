import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const ACTIONS = ["toggle", "next", "previous"] as const;

type MusicAction = (typeof ACTIONS)[number];

interface MusicControlRequest {
  action: MusicAction;
}

// ESP32 → API → Redis
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
    console.error("Music control POST error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Failed to enqueue music command",
      },
      { status: 500 },
    );
  }
}

// Mac daemon → API → Redis
export async function GET() {
  try {
    const action = await redis.lpop<string>("music:commands");

    if (action === null) {
      return NextResponse.json(
        {
          ok: true,
          action: null,
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        action,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Music control GET error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Failed to dequeue music command",
      },
      { status: 500 },
    );
  }
}
