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

    // 마지막으로 Mac에서 데이터가 업데이트된 시각
    updatedAt: null,

    // GET 응답을 생성한 서버의 현재 시각
    serverTime: Date.now(),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    /*
     * updatedAt:
     * Mac에서 새로운 Now Playing 상태가 서버에 전달된 시각.
     *
     * position이 이 시점의 playback position이라고 볼 수 있다.
     */
    const updatedAt = Date.now();

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

      // 마지막 데이터 변경 시각
      updatedAt,
    };

    await redis.set(KEY, data);

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
    /*
     * Redis에서 현재 Now Playing snapshot을 가져온다.
     */
    const data = await redis.get(KEY);

    /*
     * 반드시 GET 응답을 만드는 순간에 생성한다.
     *
     * 이 값은 Redis에 저장하지 않는다.
     */
    const serverTime = Date.now();

    /*
     * 데이터가 없으면 빈 상태를 반환한다.
     */
    if (!data) {
      return NextResponse.json({
        ...emptyNowPlaying(),
        serverTime,
      });
    }

    /*
     * serverTime은 현재 GET 요청에 대한 서버 시각이다.
     *
     * updatedAt은 Redis에 저장된 마지막 snapshot의 시각이다.
     */
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
