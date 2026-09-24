import { and, eq } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { accounts, portfolioProviderBindings, users } from './schema.js';

export type PortfolioProviderId = 'sharesight' | 'portfolio-manager';

export type PortfolioProviderBinding = Readonly<{
  ownerId: string;
  investmentAccountId: string;
  provider: PortfolioProviderId;
  connectionId: string;
  providerInstanceId: string | null;
  providerPortfolioId: string | null;
}>;

export async function claimPortfolioProviderBinding(
  db: Database,
  input: PortfolioProviderBinding & Readonly<{ now: string }>,
): Promise<PortfolioProviderBinding> {
  return db.transaction(async (tx) => {
    const owner = await tx.query.users.findFirst({ where: eq(users.id, input.ownerId) });
    if (owner === undefined) {
      throw new DataInvariantError('portfolio.owner_not_found', 'Portfolio owner does not exist.');
    }
    const account = await tx.query.accounts.findFirst({
      where: and(eq(accounts.id, input.investmentAccountId), eq(accounts.ownerId, input.ownerId)),
    });
    if (
      account === undefined ||
      account.kind !== 'investment' ||
      account.valueSource !== 'portfolio_valuation' ||
      account.currency !== 'EUR' ||
      (account.payload as Record<string, unknown>)['includeInNetWorth'] !== true
    ) {
      throw new DataInvariantError(
        'portfolio.invalid_investment_account',
        'Portfolio account must be an included EUR investment account owned by the configured owner.',
      );
    }
    await tx
      .insert(portfolioProviderBindings)
      .values({
        ownerId: input.ownerId,
        investmentAccountId: input.investmentAccountId,
        provider: input.provider,
        connectionId: input.connectionId,
        providerInstanceId: input.providerInstanceId,
        providerPortfolioId: input.providerPortfolioId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing();
    const binding = await tx.query.portfolioProviderBindings.findFirst({
      where: and(
        eq(portfolioProviderBindings.ownerId, input.ownerId),
        eq(portfolioProviderBindings.investmentAccountId, input.investmentAccountId),
      ),
    });
    if (binding === undefined) {
      throw new DataConflictError(
        'portfolio.binding_unavailable',
        'Portfolio provider binding could not be acquired.',
      );
    }
    if (binding.provider !== input.provider || binding.connectionId !== input.connectionId) {
      throw new DataConflictError(
        'portfolio.binding_conflict',
        'The canonical investment account is already bound to another provider connection.',
      );
    }
    if (
      (input.providerInstanceId !== null &&
        binding.providerInstanceId !== null &&
        input.providerInstanceId !== binding.providerInstanceId) ||
      (input.providerPortfolioId !== null &&
        binding.providerPortfolioId !== null &&
        input.providerPortfolioId !== binding.providerPortfolioId)
    ) {
      throw new DataConflictError(
        'portfolio.identity_conflict',
        'The provider connection identity does not match its existing binding.',
      );
    }
    if (
      binding.providerInstanceId === null &&
      binding.providerPortfolioId === null &&
      input.providerInstanceId !== null &&
      input.providerPortfolioId !== null
    ) {
      await tx
        .update(portfolioProviderBindings)
        .set({
          providerInstanceId: input.providerInstanceId,
          providerPortfolioId: input.providerPortfolioId,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(portfolioProviderBindings.ownerId, input.ownerId),
            eq(portfolioProviderBindings.investmentAccountId, input.investmentAccountId),
          ),
        );
      return Object.freeze({
        ownerId: input.ownerId,
        investmentAccountId: input.investmentAccountId,
        provider: input.provider,
        connectionId: input.connectionId,
        providerInstanceId: input.providerInstanceId,
        providerPortfolioId: input.providerPortfolioId,
      });
    }
    return Object.freeze({
      ownerId: binding.ownerId,
      investmentAccountId: binding.investmentAccountId,
      provider: binding.provider,
      connectionId: binding.connectionId,
      providerInstanceId: binding.providerInstanceId,
      providerPortfolioId: binding.providerPortfolioId,
    });
  });
}

export async function bindPortfolioProviderIdentity(
  db: Database,
  input: Readonly<{
    ownerId: string;
    investmentAccountId: string;
    provider: PortfolioProviderId;
    connectionId: string;
    providerInstanceId: string;
    providerPortfolioId: string;
    now: string;
  }>,
): Promise<PortfolioProviderBinding> {
  return claimPortfolioProviderBinding(db, input);
}
