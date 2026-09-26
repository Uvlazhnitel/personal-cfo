import { findSession, loadDashboardOverview } from '@personal-cfo/data';
import type { DashboardOverview, Database } from '@personal-cfo/data';

export type DashboardAccessResult =
  | Readonly<{ status: 'authorized'; overview: DashboardOverview }>
  | Readonly<{ status: 'unauthorized' }>;

export async function loadAuthorizedDashboard(
  db: Database,
  sessionToken: string | undefined,
  now: string,
  clock?: Readonly<{ now: () => Date }>,
): Promise<DashboardAccessResult> {
  if (sessionToken === undefined) return Object.freeze({ status: 'unauthorized' });
  const session = await findSession(db, sessionToken, clock);
  if (session === null) return Object.freeze({ status: 'unauthorized' });
  return Object.freeze({
    status: 'authorized',
    overview: await loadDashboardOverview(db, session.ownerId, now),
  });
}
