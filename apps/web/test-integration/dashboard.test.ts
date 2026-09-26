import { resolve } from 'node:path';

import {
  authenticate,
  createDatabaseContext,
  createLocalUser,
  engineRuns,
  ensureSyntheticOwner,
  generateUuidV7,
  loadDashboardOverview,
  metricSnapshots,
  migrateDatabase,
} from '@personal-cfo/data';
import type { DatabaseContext } from '@personal-cfo/data';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadAuthorizedDashboard } from '../src/server/dashboard-access.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;
const now = '2026-09-26T12:00:00.000Z';

function result(value: unknown, status: 'complete' | 'partial' | 'unavailable' = 'complete') {
  return {
    asOf: now,
    status,
    value,
    warnings: [],
    explanation: [],
    engineVersion: 'dashboard-test',
    settingsVersion: 'dashboard-test',
    inputWatermark: 'dashboard-test',
  };
}

suite('authenticated dashboard read model', () => {
  let context: DatabaseContext;
  let ownerId: string;
  let session: NonNullable<Awaited<ReturnType<typeof authenticate>>>;
  let safeSnapshotId: string;
  let netWorthSnapshotId: string;

  beforeEach(async () => {
    context ??= createDatabaseContext(databaseUrl!, { maxConnections: 4 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
    ownerId = await createLocalUser(
      context.db,
      { loginName: 'dashboard-owner', password: 'correct horse battery staple' },
      { now: () => new Date(now) },
    );
    const authenticated = await authenticate(
      context.db,
      'dashboard-owner',
      'correct horse battery staple',
      { now: () => new Date(now) },
    );
    if (authenticated === null) throw new Error('Dashboard authentication setup failed.');
    session = authenticated;

    const runId = generateUuidV7('dashboard-run');
    await context.db.insert(engineRuns).values({
      id: runId,
      ownerId,
      inputVersion: 0n,
      asOf: now,
      effectiveDate: '2026-09-26',
      engineVersion: 'dashboard-test',
      settingsVersion: 'dashboard-test',
      inputWatermark: 'dashboard-test',
      trigger: 'synthetic_import',
      earliestAffectedAt: null,
      startedAt: now,
      completedAt: now,
      status: 'completed',
      failureCategory: null,
      failureMessage: null,
      resultPayload: {},
    });
    const rows = [
      {
        kind: 'netWorth',
        payload: result({
          total: { amountMinor: '120000', currency: 'EUR' },
          liquidCash: { amountMinor: '80000', currency: 'EUR' },
          investmentMarketValue: { amountMinor: '40000', currency: 'EUR' },
          otherAssets: { amountMinor: '0', currency: 'EUR' },
          liabilities: { amountMinor: '0', currency: 'EUR' },
        }),
      },
      {
        kind: 'ccr',
        payload: result({ ratio: { numerator: '1', denominator: '4' } }),
      },
      {
        kind: 'safeToInvest',
        payload: result({ recommended: { amountMinor: '15000', currency: 'EUR' } }),
      },
      {
        kind: 'liquidityReserve',
        payload: result({
          currentLiquidCash: { amountMinor: '80000', currency: 'EUR' },
          comfortCash: { amountMinor: '60000', currency: 'EUR' },
        }),
      },
      {
        kind: 'currentCycleSinkingDue',
        payload: result({ totalReserved: { amountMinor: '5000', currency: 'EUR' } }),
      },
    ];
    for (const row of rows) {
      const snapshotId = generateUuidV7(`dashboard-${row.kind}`);
      if (row.kind === 'safeToInvest') safeSnapshotId = snapshotId;
      if (row.kind === 'netWorth') netWorthSnapshotId = snapshotId;
      await context.db.insert(metricSnapshots).values({
        id: snapshotId,
        ownerId,
        engineRunId: runId,
        metricKind: row.kind,
        periodKey: 'current',
        status: 'complete',
        payload: row.payload,
        asOf: now,
        engineVersion: 'dashboard-test',
        settingsVersion: 'dashboard-test',
        inputWatermark: 'dashboard-test',
        createdAt: now,
        isAuthoritative: true,
        supersededBy: null,
      });
    }
    await context.db.insert(metricSnapshots).values({
      id: generateUuidV7('dashboard-prior-net-worth'),
      ownerId,
      engineRunId: runId,
      metricKind: 'netWorth',
      periodKey: 'current',
      status: 'complete',
      payload: result({ total: { amountMinor: '100000', currency: 'EUR' } }),
      asOf: '2026-08-31T12:00:00.000Z',
      engineVersion: 'dashboard-test',
      settingsVersion: 'dashboard-test',
      inputWatermark: 'dashboard-test',
      createdAt: '2026-08-31T12:00:00.000Z',
      isAuthoritative: false,
      supersededBy: null,
    });
  });

  afterAll(async () => context?.close());

  it('rejects missing authentication and keeps reads owner-scoped', async () => {
    expect(await loadAuthorizedDashboard(context.db, undefined, now)).toEqual({
      status: 'unauthorized',
    });
    await createLocalUser(
      context.db,
      { loginName: 'other-owner', password: 'another correct horse password' },
      { now: () => new Date(now) },
    );
    const other = await authenticate(context.db, 'other-owner', 'another correct horse password', {
      now: () => new Date(now),
    });
    if (other === null) throw new Error('Other owner authentication failed.');
    const access = await loadAuthorizedDashboard(context.db, other.sessionToken, now);
    expect(access.status).toBe('authorized');
    if (access.status === 'authorized') expect(access.overview.metrics.netWorth.value).toBeNull();
  });

  it('loads exact persisted values and the prior-month comparison', async () => {
    const access = await loadAuthorizedDashboard(context.db, session.sessionToken, now);
    expect(access.status).toBe('authorized');
    if (access.status !== 'authorized') return;
    expect(access.overview.metrics.netWorth.value?.amountMinor).toBe(120_000n);
    expect(access.overview.metrics.monthlyNetWorthChange.value?.amountMinor).toBe(20_000n);
    expect(access.overview.metrics.capitalConversionRate.value).toEqual({
      numerator: 1n,
      denominator: 4n,
    });
    expect(access.overview.metrics.safeToInvest.value?.amountMinor).toBe(15_000n);
    expect(access.overview.sources.bank.state).toBe('unavailable');
  });

  it('suppresses provisional Safe to Invest and marks stale values explicitly', async () => {
    await context.pool.query(
      'update metric_snapshots set status = $1, payload = $2::jsonb where id = $3',
      [
        'partial',
        JSON.stringify(
          result({ recommended: { amountMinor: '15000', currency: 'EUR' } }, 'partial'),
        ),
        safeSnapshotId,
      ],
    );
    await context.pool.query(
      'update metric_snapshots set status = $1, payload = $2::jsonb where id = $3',
      [
        'partial',
        JSON.stringify({
          ...result(
            {
              total: { amountMinor: '120000', currency: 'EUR' },
              investmentMarketValue: { amountMinor: '40000', currency: 'EUR' },
            },
            'partial',
          ),
          warnings: [{ code: 'net_worth.stale_balance', context: {} }],
        }),
        netWorthSnapshotId,
      ],
    );
    const overview = await loadDashboardOverview(context.db, ownerId, now);
    expect(overview.metrics.safeToInvest).toMatchObject({ state: 'incomplete', value: null });
    expect(overview.metrics.netWorth).toMatchObject({ state: 'stale' });
  });

  it('labels synthetic and empty datasets without fictional values', async () => {
    const syntheticId = await ensureSyntheticOwner(context.db, now);
    const overview = await loadDashboardOverview(context.db, syntheticId, now);
    expect(overview.synthetic).toBe(true);
    expect(overview.metrics.netWorth).toMatchObject({ state: 'unavailable', value: null });
    expect(overview.metrics.safeToInvest.value).toBeNull();
  });
});
