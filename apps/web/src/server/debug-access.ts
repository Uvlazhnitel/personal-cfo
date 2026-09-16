import { findSession, loadDebugOverview } from '@personal-cfo/data';
import type { Database, DebugOverview } from '@personal-cfo/data';

export type DebugAccessResult =
  | Readonly<{ status: 'authorized'; overview: DebugOverview }>
  | Readonly<{ status: 'unauthorized' }>;

export async function loadAuthorizedDebugOverview(
  db: Database,
  sessionToken: string | undefined,
  clock?: Readonly<{ now: () => Date }>,
): Promise<DebugAccessResult> {
  if (sessionToken === undefined) return Object.freeze({ status: 'unauthorized' });
  const session = await findSession(db, sessionToken, clock);
  if (session === null) return Object.freeze({ status: 'unauthorized' });
  return Object.freeze({
    status: 'authorized',
    overview: await loadDebugOverview(db, session.ownerId),
  });
}
