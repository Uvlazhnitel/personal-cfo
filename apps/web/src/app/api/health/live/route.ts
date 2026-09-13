import { NextResponse } from 'next/server.js';

export function GET(): NextResponse {
  return NextResponse.json(
    { status: 'ok' },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
