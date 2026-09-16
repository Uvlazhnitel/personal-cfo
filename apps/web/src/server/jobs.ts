import { createJobBoss, requireDatabaseUrl } from '@personal-cfo/data';

const globalJobs = globalThis as typeof globalThis & {
  personalCfoWebBoss?: ReturnType<typeof createJobBoss>;
  personalCfoWebBossStart?: Promise<ReturnType<typeof createJobBoss>>;
};

export async function webJobBoss(): Promise<ReturnType<typeof createJobBoss>> {
  globalJobs.personalCfoWebBoss ??= createJobBoss(requireDatabaseUrl(), 3);
  const boss = globalJobs.personalCfoWebBoss;
  globalJobs.personalCfoWebBossStart ??= boss.start().then(() => boss);
  try {
    return await globalJobs.personalCfoWebBossStart;
  } catch (error) {
    delete globalJobs.personalCfoWebBossStart;
    throw error;
  }
}
