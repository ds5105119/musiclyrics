import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const KEY = "now-playing";

const MAX_CAPTURE_AGE_MS = 30_000;

type NowPlayingData = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  composer: string | null;
  genre: string | null;

  trackNumber: number | null;
  discNumber: number | null;

  persistentId: string | null;
  appleId: string | null;

  artwork: string | null;

  position: number;
  duration: number;
  playbackRate: number;
  playing: boolean;

  app: string | null;

  positionCapturedAt: number | null;
  captureAgeMs: number | null;

  /**
   * position이 이 시각의 위치를 의미한다.
   *
   * 즉:
   *
   * position = positionCapturedAt에서 측정된 원본 position
   *            + captureAgeMs 동안 재생된 양
   *
   * 따라서 ESP32는 updatedAt을 기준으로 position을 사용할 수 있다.
   */
  updatedAt: number | null;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value;
}

function emptyNowPlaying(serverTime: number): NowPlayingData & {
  serverTime: number;
} {
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
    playbackRate: 0,
    playing: false,

    app: null,

    positionCapturedAt: null,
    captureAgeMs: null,

    updatedAt: null,

    serverTime,
  };
}

export async function POST(req: Request) {
  try {
    /*
     * ------------------------------------------------------
     * 서버가 요청을 실제로 처리하기 시작한 시각.
     * ------------------------------------------------------
     */
    const receivedAt = Date.now();

    /*
     * ------------------------------------------------------
     * Request body
     * ------------------------------------------------------
     */
    const body = await req.json();

    /*
     * ------------------------------------------------------
     * Mac에서 측정한 원본 playback 정보
     * ------------------------------------------------------
     */
    const rawPosition = Math.max(0, toFiniteNumber(body.position, 0));

    const duration = Math.max(0, toFiniteNumber(body.duration, 0));

    const playbackRate = Math.max(0, toFiniteNumber(body.playbackRate, 0));

    const playing = Boolean(body.playing);

    /*
     * Mac에서 MediaRemote position을 읽은 시각.
     *
     * Python daemon이:
     *
     *   time.time() * 1000
     *
     * 으로 만들어서 보낸다.
     */
    const positionCapturedAt = toFiniteNumber(body.positionCapturedAt, receivedAt);

    /*
     * ------------------------------------------------------
     * Capture → Vercel delay
     * ------------------------------------------------------
     *
     * 정상적인 경우:
     *
     * positionCapturedAt
     *        ↓
     *     network
     *        ↓
     * receivedAt
     *
     * 그 사이 음악이 재생되었으므로
     * position도 증가시켜야 한다.
     */
    const rawCaptureAgeMs = receivedAt - positionCapturedAt;

    /*
     * 미래 timestamp 또는 너무 오래된 timestamp는
     * 정상적인 capture timestamp로 취급하지 않는다.
     */
    const validCaptureAge = rawCaptureAgeMs >= 0 && rawCaptureAgeMs <= MAX_CAPTURE_AGE_MS;

    const captureAgeMs = validCaptureAge ? rawCaptureAgeMs : 0;

    /*
     * ------------------------------------------------------
     * Vercel receivedAt 기준 position 계산
     * ------------------------------------------------------
     *
     * 예:
     *
     * Mac:
     *
     *   position = 100.000
     *   captured = T
     *
     * Vercel:
     *
     *   received = T + 250ms
     *
     * playbackRate = 1
     *
     * 결과:
     *
     *   position = 100.250
     *
     * 이 position은 receivedAt 시각의 위치다.
     */
    let position = rawPosition;

    if (validCaptureAge && playing && playbackRate > 0) {
      position = rawPosition + (captureAgeMs / 1000) * playbackRate;
    }

    /*
     * ------------------------------------------------------
     * Duration 제한
     * ------------------------------------------------------
     */
    if (duration > 0) {
      position = clamp(position, 0, duration);
    } else {
      position = Math.max(0, position);
    }

    /*
     * ------------------------------------------------------
     * Redis에 저장할 상태
     * ------------------------------------------------------
     *
     * updatedAt = 이 position이 의미하는 기준 시각.
     *
     * 즉:
     *
     *   position
     *   ↓
     *   updatedAt
     *
     * 기준으로 playback 위치가 저장된다.
     */
    const data: NowPlayingData = {
      title: nullableString(body.title),

      artist: nullableString(body.artist),

      album: nullableString(body.album),

      albumArtist: nullableString(body.albumArtist),

      composer: nullableString(body.composer),

      genre: nullableString(body.genre),

      trackNumber: body.trackNumber == null ? null : toFiniteNumber(body.trackNumber, 0),

      discNumber: body.discNumber == null ? null : toFiniteNumber(body.discNumber, 0),

      persistentId: nullableString(body.persistentId),

      appleId: nullableString(body.appleId),

      artwork: nullableString(body.artwork),

      position,

      duration,

      playbackRate,

      playing,

      app: nullableString(body.app),

      positionCapturedAt,

      captureAgeMs,

      updatedAt: receivedAt,
    };

    /*
     * ------------------------------------------------------
     * Redis
     * ------------------------------------------------------
     */
    await redis.set(KEY, JSON.stringify(data));

    /*
     * ------------------------------------------------------
     * POST response
     *
     * Mac daemon debugging용.
     * ------------------------------------------------------
     */
    return NextResponse.json({
      success: true,

      position: data.position,
      duration: data.duration,

      playbackRate: data.playbackRate,

      playing: data.playing,

      positionCapturedAt: data.positionCapturedAt,

      captureAgeMs: data.captureAgeMs,

      updatedAt: data.updatedAt,
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
  /*
   * --------------------------------------------------------
   * GET 시작 시각
   * --------------------------------------------------------
   *
   * ESP32가 이 endpoint를 호출한다.
   *
   * serverTime은 반드시 이 요청에서 새로 생성한다.
   */
  const serverTime = Date.now();

  try {
    /*
     * ------------------------------------------------------
     * Redis
     * ------------------------------------------------------
     */
    const raw = await redis.get(KEY);

    /*
     * ------------------------------------------------------
     * 현재 재생 정보가 없는 경우
     * ------------------------------------------------------
     */
    if (!raw) {
      return NextResponse.json(emptyNowPlaying(serverTime), {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    /*
     * ------------------------------------------------------
     * Parse
     * ------------------------------------------------------
     */
    let data: NowPlayingData;

    try {
      data = JSON.parse(raw) as NowPlayingData;
    } catch {
      return NextResponse.json(
        {
          ...emptyNowPlaying(serverTime),

          error: "invalid stored state",
        },
        {
          status: 500,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        },
      );
    }

    /*
     * ------------------------------------------------------
     * GET response
     * ------------------------------------------------------
     *
     * ESP32가 동기화에 사용하는 핵심 값:
     *
     *   position
     *   updatedAt
     *   playbackRate
     *   playing
     *   serverTime
     *
     * position은 updatedAt 시점의 위치다.
     *
     * 따라서 ESP32에서는:
     *
     *   elapsed =
     *     (serverTime - updatedAt) / 1000
     *
     *   currentPosition =
     *     position +
     *     elapsed * playbackRate
     *
     * 로 계산할 수 있다.
     */
    return NextResponse.json(
      {
        title: data.title,
        artist: data.artist,
        album: data.album,

        albumArtist: data.albumArtist,

        composer: data.composer,

        genre: data.genre,

        trackNumber: data.trackNumber,

        discNumber: data.discNumber,

        persistentId: data.persistentId,

        appleId: data.appleId,

        artwork: data.artwork,

        position: data.position,

        duration: data.duration,

        playbackRate: data.playbackRate,

        playing: data.playing,

        app: data.app,

        /*
         * Mac → Vercel capture 정보.
         *
         * ESP32가 직접 사용할 필요는 없지만
         * 동기화 디버깅에 필요하므로 전달한다.
         */
        positionCapturedAt: data.positionCapturedAt,

        captureAgeMs: data.captureAgeMs,

        /*
         * 이 position의 기준 시각.
         */
        updatedAt: data.updatedAt,

        /*
         * 이 GET response를 생성한
         * Vercel 서버의 현재 Unix time.
         *
         * ESP32에서 RTT와 함께 사용한다.
         */
        serverTime,
      },
      {
        headers: {
          /*
           * ESP32가 항상 Redis의 최신 상태를
           * 받아야 하므로 CDN/browser cache를 막는다.
           */
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  } catch (error) {
    console.error("now-playing GET error", error);

    return NextResponse.json(
      {
        error: "redis error",
        serverTime,
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }
}
