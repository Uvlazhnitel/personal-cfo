import { createJobBoss, requireDatabaseUrl } from '@personal-cfo/data';

const globalJobs = globalThis as typeof globalThis & {
  personalCfoWebBoss?: ReturnType<typeof createJobBoss>;
};

export function webJobBoss(): ReturnType<typeof createJobBoss> {
  globalJobs.personalCfoWebBoss ??= createJobBoss(requireDatabaseUrl(), 3);
  return globalJobs.personalCfoWebBoss;
}
