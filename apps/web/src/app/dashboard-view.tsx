import type {
  DashboardDataState,
  DashboardMetric,
  DashboardMoney,
  DashboardOverview,
  DashboardSource,
} from '@personal-cfo/data';

const stateLabels: Readonly<Record<DashboardDataState, string>> = Object.freeze({
  available: 'Available',
  incomplete: 'Incomplete',
  stale: 'Stale',
  unavailable: 'Unavailable',
});

const reasonLabels: Readonly<Record<string, string>> = Object.freeze({
  history_incomplete: 'The required history window is not fully covered.',
  invalid_persisted_result: 'The latest persisted result could not be displayed safely.',
  monthly_baseline_unavailable: 'No reliable prior-month baseline is available.',
  no_calculation: 'No completed calculation is available yet.',
  recommendation_blocked:
    'Incomplete or unreconciled source data blocks a reliable recommendation.',
  required_data_unavailable: 'Required source data is unavailable.',
  source_data_incomplete: 'Some required source data is incomplete.',
  source_data_stale: 'The underlying source data is stale.',
});

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.'
  );
}

export function formatMoney(value: DashboardMoney, locale: string): string {
  const negative = value.amountMinor < 0n;
  const absolute = negative ? -value.amountMinor : value.amountMinor;
  const whole = absolute / 100n;
  const cents = absolute % 100n;
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const fraction =
    cents === 0n ? '' : `${decimalSeparator(locale)}${cents.toString().padStart(2, '0')}`;
  return `${negative ? '−' : ''}€${grouped}${fraction}`;
}

export function formatRatio(value: Readonly<{ numerator: bigint; denominator: bigint }>): string {
  const scaled = value.numerator * 1_000n;
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const roundedTenths = (absolute + value.denominator / 2n) / value.denominator;
  const whole = roundedTenths / 10n;
  const fraction = roundedTenths % 10n;
  return `${negative ? '−' : ''}${whole.toString()}${fraction === 0n ? '' : `.${fraction.toString()}`}%`;
}

function formatInstant(value: string | null, locale: string, timeZone: string): string {
  if (value === null) return 'Never';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

function reason(metric: DashboardMetric<unknown>): string | null {
  return metric.reason === null
    ? null
    : (reasonLabels[metric.reason] ?? 'Data quality is limited.');
}

function StatusBadge({ state }: Readonly<{ state: DashboardDataState }>) {
  return <span className={`status-badge status-${state}`}>{stateLabels[state]}</span>;
}

function MoneyCard({
  title,
  metric,
  locale,
  supporting,
}: Readonly<{
  title: string;
  metric: DashboardMetric<DashboardMoney>;
  locale: string;
  supporting?: string;
}>) {
  return (
    <article className="metric-card">
      <div className="metric-heading">
        <h2>{title}</h2>
        <StatusBadge state={metric.state} />
      </div>
      <p className="metric-value">
        {metric.value === null ? 'Unavailable' : formatMoney(metric.value, locale)}
      </p>
      {supporting === undefined ? null : <p className="metric-supporting">{supporting}</p>}
      {reason(metric) === null ? null : <p className="metric-reason">{reason(metric)}</p>}
    </article>
  );
}

function SourceRow({
  title,
  source,
  locale,
  timeZone,
}: Readonly<{
  title: string;
  source: DashboardSource;
  locale: string;
  timeZone: string;
}>) {
  return (
    <div className="source-row">
      <div>
        <p className="source-title">{title}</p>
        <p className="source-name">{source.label}</p>
      </div>
      <div className="source-meta">
        <StatusBadge state={source.state} />
        <time dateTime={source.lastSuccessfulAt ?? undefined}>
          {formatInstant(source.lastSuccessfulAt, locale, timeZone)}
        </time>
      </div>
      <p className="source-detail">{source.detail}</p>
    </div>
  );
}

export function DashboardView({ overview }: Readonly<{ overview: DashboardOverview }>) {
  const { metrics, locale, timeZone } = overview;
  const netWorthChange =
    metrics.monthlyNetWorthChange.value === null
      ? null
      : `${metrics.monthlyNetWorthChange.value.amountMinor >= 0n ? '+' : ''}${formatMoney(metrics.monthlyNetWorthChange.value, locale)} this month`;
  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <a className="brand" href="/" aria-label="Personal CFO dashboard">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>Personal CFO</span>
        </a>
        <nav aria-label="Primary navigation">
          <a aria-current="page" href="/">
            Overview
          </a>
          <a href="/debug">Debug</a>
        </nav>
      </header>

      {overview.synthetic ? (
        <aside className="demo-banner" role="status">
          <strong>Demo data</strong>
          <span>This dashboard contains synthetic fixtures, not real financial data.</span>
        </aside>
      ) : null}

      <section className="hero" aria-labelledby="net-worth-title">
        <div className="hero-label">
          <p id="net-worth-title">Net Worth</p>
          <StatusBadge state={metrics.netWorth.state} />
        </div>
        <p className="hero-value">
          {metrics.netWorth.value === null
            ? 'Unavailable'
            : formatMoney(metrics.netWorth.value, locale)}
        </p>
        {netWorthChange === null ? (
          <p className="hero-subtitle">
            Monthly change will appear after a reliable prior-month snapshot.
          </p>
        ) : (
          <p className="hero-change">{netWorthChange}</p>
        )}
        {reason(metrics.netWorth) === null ? null : (
          <p className="hero-warning">{reason(metrics.netWorth)}</p>
        )}
      </section>

      <section className="dashboard-grid" aria-label="Financial metrics">
        <article className="metric-card featured-card">
          <div className="metric-heading">
            <h2>Capital Conversion</h2>
            <StatusBadge state={metrics.capitalConversionRate.state} />
          </div>
          <p className="metric-value">
            {metrics.capitalConversionRate.value === null
              ? 'Unavailable'
              : formatRatio(metrics.capitalConversionRate.value)}
          </p>
          <p className="metric-supporting">Income converted into capital</p>
          {reason(metrics.capitalConversionRate) === null ? null : (
            <p className="metric-reason">{reason(metrics.capitalConversionRate)}</p>
          )}
        </article>

        <MoneyCard
          title="Safe to Invest"
          metric={metrics.safeToInvest}
          locale={locale}
          supporting="Recommended amount"
        />

        <MoneyCard
          title="Available Cash"
          metric={metrics.availableCash}
          locale={locale}
          supporting={
            metrics.comfortReserve.value === null
              ? 'Comfort reserve unavailable'
              : `Comfort reserve ${formatMoney(metrics.comfortReserve.value, locale)}`
          }
        />

        <MoneyCard title="Investments" metric={metrics.investmentPortfolio} locale={locale} />
        <MoneyCard
          title="Sinking Funds"
          metric={metrics.reservedSinkingFunds}
          locale={locale}
          supporting="Reserved cash"
        />
      </section>

      <section className="source-card" aria-labelledby="source-status-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Data quality</p>
            <h2 id="source-status-title">Source status</h2>
          </div>
          <p className="last-update">
            Last update{' '}
            <time dateTime={overview.sources.lastSuccessfulUpdate ?? undefined}>
              {formatInstant(overview.sources.lastSuccessfulUpdate, locale, timeZone)}
            </time>
          </p>
        </div>
        <SourceRow
          title="Bank connection"
          source={overview.sources.bank}
          locale={locale}
          timeZone={timeZone}
        />
        <SourceRow
          title="Portfolio data"
          source={overview.sources.portfolio}
          locale={locale}
          timeZone={timeZone}
        />
      </section>

      <footer className="dashboard-footer">
        <p>Persisted deterministic outputs only. Missing data is never treated as zero.</p>
      </footer>
    </main>
  );
}
