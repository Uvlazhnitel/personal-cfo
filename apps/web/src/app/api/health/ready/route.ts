import { NextResponse } from 'next/server.js';

export function GET(): NextResponse {
  return NextResponse.json(
    {
      checks: {
        database: 'not-configured',
        runtime: 'ok',
      },
      status: 'ok',
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
