import { findSession, loadDebugOverview, stringifySnapshot } from '@personal-cfo/data';
import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';

import { SESSION_COOKIE } from '../../server/auth.js';
import { databaseContext } from '../../server/database.js';

function Section({ title, value }: Readonly<{ title: string; value: unknown }>) {
  return (
    <section>
      <h2>{title}</h2>
      <pre>{stringifySnapshot(value)}</pre>
    </section>
  );
}

export default async function DebugPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token === undefined ? null : await findSession(databaseContext().db, token);
  if (session === null) redirect('/login');
  const overview = await loadDebugOverview(databaseContext().db, session.ownerId);
  return (
    <main>
      <h1>Internal financial state</h1>
      <p>Persisted deterministic outputs only. No formulas run in this view.</p>
      <Section title="Latest engine run" value={overview.latestRun} />
      <Section title="Canonical entity counts" value={overview.entityCounts} />
      <Section title="Metric snapshots" value={overview.metrics} />
      <Section title="Pay Cycles" value={overview.payCycles} />
      <Section title="Sinking requirements" value={overview.sinkingRequirements} />
      <Section title="Active ambiguities" value={overview.ambiguities} />
      <Section
        title="Cash reconciliations"
        value={{
          reconciliations: overview.reconciliations,
          resolutions: overview.reconciliationResolutions,
        }}
      />
      <Section
        title="Audit and recalculation"
        value={{ audit: overview.audit, recalculations: overview.recalculations }}
      />
      <Section title="Durable jobs" value={overview.jobs} />
    </main>
  );
}
