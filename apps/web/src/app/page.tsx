import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';

import { SESSION_COOKIE } from '../server/auth.js';
import { loadAuthorizedDashboard } from '../server/dashboard-access.js';
import { databaseContext } from '../server/database.js';
import { DashboardView } from './dashboard-view.js';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const access = await loadAuthorizedDashboard(
    databaseContext().db,
    token,
    new Date().toISOString(),
  );
  if (access.status === 'unauthorized') redirect('/login');
  return <DashboardView overview={access.overview} />;
}
