import { stringifySnapshot } from '@personal-cfo/data';
import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';

import { SESSION_COOKIE } from '../../server/auth.js';
import { databaseContext } from '../../server/database.js';
import { loadAuthorizedDebugOverview } from '../../server/debug-access.js';
import { ConnectBankButton } from './connect-bank-button.js';

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
  const access = await loadAuthorizedDebugOverview(databaseContext().db, token);
  if (access.status === 'unauthorized') redirect('/login');
  const overview = access.overview;
  return (
    <main>
      <h1>Internal financial state</h1>
      <p>Persisted deterministic outputs only. No formulas run in this view.</p>
      <ConnectBankButton />
      <Section title="Current input version" value={overview.currentInputVersion} />
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
      <Section title="Telegram integration" value={overview.telegram} />
    </main>
  );
}
