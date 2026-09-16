import { jobInfrastructureReady } from '@personal-cfo/data';
import { NextResponse } from 'next/server.js';

import { databaseContext } from '../../../../server/database.js';
import { webJobBoss } from '../../../../server/jobs.js';

export async function GET(): Promise<NextResponse> {
  let database: 'ok' | 'unavailable' = 'unavailable';
  let jobs: 'ok' | 'unavailable' = 'unavailable';
  try {
    await databaseContext().pool.query('select 1');
    database = 'ok';
    await webJobBoss();
    jobs = (await jobInfrastructureReady(databaseContext().db)) ? 'ok' : 'unavailable';
  } catch {
    // Readiness intentionally exposes only bounded status categories.
  }
  const ready = database === 'ok' && jobs === 'ok';
  return NextResponse.json(
    { status: ready ? 'ok' : 'not-ready', checks: { runtime: 'ok', database, jobs } },
    { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
