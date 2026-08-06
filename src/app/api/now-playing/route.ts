import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";


const KEY = "now-playing";


export async function POST(req: Request) {

  const body = await req.json();

  await redis.set(KEY, {
    ...body,
    updatedAt: Date.now()
  });


  return NextResponse.json({
    success:true
  });
}



export async function GET() {

  const data = await redis.get(KEY);


  return NextResponse.json(
    data ?? {
      playing:false
    }
  );
}