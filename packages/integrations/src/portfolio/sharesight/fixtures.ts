const portfolio = Object.freeze({
  id: 293304,
  name: 'Sanitized EUR Portfolio',
  currency_code: 'EUR',
  inception_date: '01 Jan 2024',
  tz_name: 'Riga',
});

function valuation(holdingValue: string, totalValue = '10000.10', currencyCode = 'EUR'): string {
  return `{
    "portfolio_valuation": {
      "id": "ValuationReport_293304",
      "balance_date": "2026-09-21",
      "portfolio_id": 293304,
      "grouping": "market",
      "custom_group_id": null,
      "value": ${totalValue}
    },
    "portfolio_valuation_holdings": [
      {
        "id": 6257909,
        "portfolio_valuation_id": "ValuationReport_293304",
        "symbol": "SYN",
        "instrument_id": 429,
        "market_code": "XETR",
        "group_type": "market",
        "group_id": 2,
        "name": "Sanitized Broad Market ETF",
        "value": ${holdingValue},
        "quantity": 12.5000,
        "instrument_price": 760.004
      }
    ],
    "portfolio_valuation_cash_accounts": [
      {
        "id": "CashAccount_754797206",
        "cash_account_id": 754797206,
        "portfolio_valuation_id": "ValuationReport_293304",
        "name": "Sanitized brokerage cash",
        "value": 500.05,
        "currency": "€",
        "currency_code": "${currencyCode}"
      }
    ],
    "portfolio_valuation_sub_totals": []
  }`;
}

function cashTransaction(id: number, amount: string, type: string, portfolioId = 293304): string {
  return `{
    "cash_account_transactions": [
      {
        "id": ${id},
        "date_time": "2026-09-20T10:15:30.000Z",
        "description": "Sanitized transfer",
        "amount": ${amount},
        "balance": 1300.15,
        "cash_account_id": 754797206,
        "foreign_identifier": "bank-transfer-${id}",
        "holding_id": null,
        "trade_id": null,
        "payout_id": null,
        "cash_account_transaction_type": { "name": "${type}" },
        "links": {
          "portfolio": "https://api.sharesight.com/api/v2/portfolios/${portfolioId}"
        }
      }
    ],
    "links": {
      "self": "https://api.sharesight.com/api/v2/cash_accounts/754797206/cash_account_transactions"
    }
  }`;
}

export const SHARESIGHT_CONTRACT_FIXTURES = Object.freeze({
  portfolios: JSON.stringify({ portfolios: [portfolio], links: { self: '/api/v2/portfolios' } }),
  completeValuation: valuation('9500.05'),
  limitedHoldingsValuation: valuation('6000.00'),
  materialMismatchValuation: valuation('9400.00'),
  withinRoundingValuation: valuation('9500.04'),
  nonEurValuation: valuation('9500.05', '10000.10', 'GBP'),
  nonEurPortfolio: JSON.stringify({
    portfolios: [{ ...portfolio, currency_code: 'GBP' }],
    links: { self: '/api/v2/portfolios' },
  }),
  cashAccounts: `{
    "cash_accounts": [
      {
        "id": 754797206,
        "name": "Sanitized brokerage cash",
        "currency": "EUR",
        "portfolio_id": 293304,
        "portfolio_currency": "EUR",
        "date": "2026-09-21",
        "balance": 500.05,
        "balance_in_portfolio_currency": 500.05,
        "links": { "portfolio": "https://api.sharesight.com/api/v2/portfolios/293304" }
      }
    ]
  }`,
  deposit: cashTransaction(798669676, '1000.10', 'DEPOSIT'),
  depositReplay: cashTransaction(798669676, '1000.10', 'DEPOSIT'),
  revisedDeposit: cashTransaction(798669676, '1100.10', 'DEPOSIT'),
  withdrawal: cashTransaction(798669677, '-200.00', 'WITHDRAWAL'),
  directionConflict: cashTransaction(798669678, '200.00', 'WITHDRAWAL'),
  unrelatedCashTransaction: cashTransaction(798669679, '4.50', 'INTEREST_PAYMENT'),
  crossPortfolioDeposit: cashTransaction(798669680, '1000.10', 'DEPOSIT', 999999),
  pendingTrade: `{
    "trades": [
      {
        "id": null,
        "unique_identifier": "pending-trade-1",
        "transaction_type": "BUY",
        "transaction_date": "2026-09-21",
        "quantity": 1.25,
        "price": 80.00,
        "exchange_rate": 1.0,
        "brokerage": 1.25,
        "brokerage_currency_code": "EUR",
        "value": 100.00,
        "portfolio_id": 293304,
        "holding_id": 6257909,
        "instrument_id": 429,
        "state": "unconfirmed"
      }
    ]
  }`,
  observedIdentitylessTrade: `{
    "trades": [
      {
        "id": null,
        "unique_identifier": null,
        "transaction_type": "BUY",
        "transaction_date": "2026-09-21",
        "quantity": 1.25,
        "price": 80.00,
        "exchange_rate": 1.0,
        "brokerage": 0,
        "brokerage_currency_code": null,
        "value": 100.00,
        "portfolio_id": 293304,
        "holding_id": 6257909,
        "instrument_id": 429,
        "state": "unconfirmed"
      }
    ]
  }`,
  performance: `{
    "portfolio_performance": {
      "id": "PerformanceReport_293304",
      "portfolio_id": 293304,
      "grouping": "market",
      "value": 10000.10,
      "capital_gain": 525.20,
      "payout_gain": 42.30,
      "currency_gain": -12.10,
      "total_gain": 555.40,
      "start_date": "2026-01-01",
      "end_date": "2026-09-21"
    }
  }`,
  observedDirectPerformance: `{
    "id": "PerformanceReport_293304",
    "portfolio_id": 293304,
    "grouping": "market",
    "custom_group_id": null,
    "include_sales": true,
    "value": 10000.10,
    "capital_gain": 525.20,
    "capital_gain_percent": 5.25,
    "payout_gain": 42.30,
    "payout_gain_percent": 0.42,
    "currency_gain": -12.10,
    "currency_gain_percent": -0.12,
    "total_gain": 555.40,
    "total_gain_percent": 5.55,
    "start_date": "2026-01-01",
    "end_date": "2026-09-21",
    "holdings": [],
    "cash_accounts": [],
    "sub_totals": [],
    "links": {
      "portfolio": "/api/v2/portfolios/293304",
      "self": "/api/v2/portfolios/293304/performance"
    }
  }`,
  payouts: `{
    "payouts": [
      {
        "id": 2,
        "portfolio_id": 293304,
        "holding_id": 6257909,
        "instrument_id": 429,
        "symbol": "SYN",
        "market": "XETR",
        "paid_on": "2026-09-18",
        "goes_ex_on": "2026-09-10",
        "amount": 42.30,
        "currency": "EUR",
        "exchange_rate": 1.0,
        "state": "confirmed"
      }
    ]
  }`,
  observedIdentitylessPayout: `{
    "payouts": [
      {
        "id": null,
        "portfolio_id": 293304,
        "holding_id": 6257909,
        "instrument_id": 429,
        "symbol": "SYN",
        "market": "XETR",
        "paid_on": "2026-09-18",
        "goes_ex_on": "2026-09-10",
        "amount": 42.30,
        "currency": "EUR",
        "exchange_rate": 1.0,
        "state": "unconfirmed"
      }
    ]
  }`,
});
