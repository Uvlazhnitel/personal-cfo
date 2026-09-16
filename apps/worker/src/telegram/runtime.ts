import type { PgBoss } from 'pg-boss';
import {
  claimTelegramDelivery,
  claimTelegramUpdate,
  completeTelegramDelivery,
  configureTelegramOwnerLink,
  expireTelegramState,
  loadTelegramPollOffset,
  persistTelegramUpdatePage,
  setTelegramIntegrationStatus,
} from '@personal-cfo/data';
import type { Database } from '@personal-cfo/data';
import {
  TelegramApiError,
  TelegramBotApiClient,
  normalizeTelegramUpdate,
} from '@personal-cfo/integrations';
import type { TelegramApi } from '@personal-cfo/integrations';

import type { WorkerEventLogger } from '../job-handlers.js';
import { telegramConfiguration } from './config.js';
import type { TelegramConfiguration } from './config.js';
import { processTelegramUpdate } from './processor.js';

type Sleeper = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const sleep: Sleeper = (milliseconds, signal) =>
  new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    const cancel = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener('abort', cancel, { once: true });
  });

export type TelegramRuntime = Readonly<{
  enabled: boolean;
  stop: () => Promise<void>;
}>;

export type TelegramRuntimeOptions = Readonly<{
  configuration?: TelegramConfiguration;
  api?: TelegramApi;
  clock?: Readonly<{ now: () => string }>;
  sleeper?: Sleeper;
}>;

export async function startTelegramRuntime(
  db: Database,
  boss: PgBoss,
  log: WorkerEventLogger,
  options: TelegramRuntimeOptions = {},
): Promise<TelegramRuntime> {
  const configuration = options.configuration ?? telegramConfiguration();
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  if (!configuration.enabled) {
    await setTelegramIntegrationStatus(db, {
      enabled: false,
      sourceKey: null,
      status: 'disabled',
      now: clock.now(),
    });
    log('telegram.disabled');
    return Object.freeze({ enabled: false, stop: () => Promise.resolve() });
  }
  const enabledConfiguration = configuration;
  await configureTelegramOwnerLink(db, {
    sourceKey: enabledConfiguration.sourceKey,
    telegramUserId: enabledConfiguration.allowedUserId,
    ownerId: enabledConfiguration.ownerId,
    now: clock.now(),
  });
  await setTelegramIntegrationStatus(db, {
    enabled: true,
    sourceKey: enabledConfiguration.sourceKey,
    status: 'starting',
    now: clock.now(),
  });
  const api = options.api ?? new TelegramBotApiClient(enabledConfiguration.token);
  const wait = options.sleeper ?? sleep;
  const controller = new AbortController();
  let failureCount = 0;

  async function drainUpdates(): Promise<void> {
    while (!controller.signal.aborted) {
      const update = await claimTelegramUpdate(db, enabledConfiguration.sourceKey, clock.now());
      if (update === null) return;
      await processTelegramUpdate(db, boss, update, clock, log);
    }
  }

  async function drainDeliveries(): Promise<void> {
    while (!controller.signal.aborted) {
      const delivery = await claimTelegramDelivery(db, enabledConfiguration.sourceKey, clock.now());
      if (delivery === null) return;
      try {
        const sent = await api.sendMessage({
          chatId: delivery.chatId,
          text: delivery.text,
          replyToMessageId: delivery.replyToMessageId,
          signal: controller.signal,
        });
        await completeTelegramDelivery(db, {
          delivery,
          outcome: 'sent',
          botMessageId: sent.messageId,
          now: clock.now(),
        });
      } catch (error) {
        const apiError = error instanceof TelegramApiError ? error : null;
        const uncertain = apiError?.category === 'network_uncertain';
        const retryable =
          !uncertain &&
          delivery.attemptCount < 3 &&
          (apiError?.category === 'rate_limited' || apiError?.category === 'provider_error');
        await completeTelegramDelivery(db, {
          delivery,
          outcome: uncertain ? 'uncertain' : retryable ? 'retryable' : 'failed',
          errorCategory: apiError?.category ?? 'delivery_internal',
          now: clock.now(),
        });
        log('telegram.delivery.failed', {
          deliveryId: delivery.id,
          category: apiError?.category ?? 'delivery_internal',
        });
      }
    }
  }

  const loop = (async () => {
    log('telegram.started');
    while (!controller.signal.aborted) {
      try {
        await expireTelegramState(db, enabledConfiguration.sourceKey, clock.now());
        await drainUpdates();
        await drainDeliveries();
        const offset = await loadTelegramPollOffset(db, enabledConfiguration.sourceKey);
        const updates = await api.getUpdates({
          offset,
          timeoutSeconds: 25,
          signal: controller.signal,
        });
        const normalized = updates.map(normalizeTelegramUpdate);
        await persistTelegramUpdatePage(db, {
          sourceKey: enabledConfiguration.sourceKey,
          ownerId: enabledConfiguration.ownerId,
          allowedUserId: enabledConfiguration.allowedUserId,
          updates: normalized,
          now: clock.now(),
        });
        await setTelegramIntegrationStatus(db, {
          enabled: true,
          sourceKey: enabledConfiguration.sourceKey,
          status: 'running',
          now: clock.now(),
        });
        failureCount = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        failureCount += 1;
        const category =
          error instanceof TelegramApiError ? error.category : 'telegram_runtime_internal';
        await setTelegramIntegrationStatus(db, {
          enabled: true,
          sourceKey: enabledConfiguration.sourceKey,
          status: 'degraded',
          errorCategory: category,
          now: clock.now(),
        });
        log('telegram.poll.failed', { category });
        await wait(Math.min(30_000, 1000 * 2 ** Math.min(failureCount - 1, 5)), controller.signal);
      }
    }
    log('telegram.stopped');
  })();

  return Object.freeze({
    enabled: true,
    stop: async () => {
      controller.abort();
      await loop;
    },
  });
}
