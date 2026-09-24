const account = Object.freeze({
  uid: '018f0000-0000-7000-8000-000000000801',
  identification_hash: 'synthetic-account-hash.lv.v1',
  identification_hashes: ['synthetic-account-hash.lv.v1'],
  currency: 'EUR',
  usage: 'PRIV',
  cash_account_type: 'CACC',
});

const bookedCard = Object.freeze({
  entry_reference: 'archive-card-001',
  merchant_category_code: '5411',
  transaction_amount: { currency: 'EUR', amount: '12.34' },
  creditor: { name: 'Synthetic Grocery' },
  creditor_account: { identification: 'synthetic-counterparty-account' },
  bank_transaction_code: { description: 'Card purchase', code: 'PMNT', sub_code: 'CDPT' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-09-21',
  value_date: '2026-09-21',
  transaction_date: '2026-09-20',
  reference_number: 'synthetic-card-reference',
  remittance_information: ['Synthetic grocery purchase'],
  exchange_rate: null,
  transaction_id: 'temporary-detail-card-001',
});

const pendingCard = Object.freeze({
  ...bookedCard,
  status: 'PDNG',
  booking_date: null,
});

const changedIdBookedCard = Object.freeze({
  ...bookedCard,
  entry_reference: 'archive-card-booked-002',
});

const salary = Object.freeze({
  entry_reference: 'archive-salary-001',
  transaction_amount: { currency: 'EUR', amount: '2500.00' },
  debtor: { name: 'Synthetic Employer' },
  debtor_account: { iban: 'LV00SYNTHETICEMPLOYER' },
  bank_transaction_code: { description: 'Credit transfer', code: 'PMNT', sub_code: 'RCDT' },
  credit_debit_indicator: 'CRDT',
  status: 'BOOK',
  booking_date: '2026-09-01',
  value_date: '2026-09-01',
  transaction_date: '2026-09-01',
  reference_number: 'synthetic-salary-reference',
  remittance_information: ['Synthetic salary'],
  transaction_id: 'temporary-detail-salary-001',
});

const atm = Object.freeze({
  entry_reference: 'archive-atm-001',
  transaction_amount: { currency: 'EUR', amount: '100.00' },
  creditor: { name: 'Synthetic ATM' },
  bank_transaction_code: { description: 'Cash withdrawal', code: 'PMNT', sub_code: 'CWDL' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-09-10',
  value_date: '2026-09-10',
  transaction_date: '2026-09-10',
  reference_number: 'synthetic-atm-reference',
  remittance_information: ['Synthetic cash withdrawal'],
  transaction_id: 'temporary-detail-atm-001',
});

const brokerage = Object.freeze({
  entry_reference: 'archive-brokerage-001',
  transaction_amount: { currency: 'EUR', amount: '200.00' },
  creditor: { name: 'Synthetic Brokerage' },
  creditor_account: { iban: 'LV00SYNTHETICBROKER' },
  bank_transaction_code: { description: 'Credit transfer', code: 'PMNT', sub_code: 'ICDT' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-09-12',
  value_date: '2026-09-12',
  transaction_date: '2026-09-12',
  reference_number: 'synthetic-brokerage-reference',
  remittance_information: ['Synthetic investment transfer'],
  transaction_id: 'temporary-detail-brokerage-001',
});

const refund = Object.freeze({
  entry_reference: 'archive-refund-001',
  transaction_amount: { currency: 'EUR', amount: '12.34' },
  debtor: { name: 'Synthetic Grocery' },
  bank_transaction_code: { description: 'Card refund', code: 'PMNT', sub_code: 'RRTN' },
  credit_debit_indicator: 'CRDT',
  status: 'BOOK',
  booking_date: '2026-09-23',
  value_date: '2026-09-23',
  transaction_date: '2026-09-22',
  reference_number: 'synthetic-card-reference',
  remittance_information: ['Synthetic refund'],
  transaction_id: 'temporary-detail-refund-001',
});

const exchangedCard = Object.freeze({
  ...bookedCard,
  entry_reference: 'archive-card-fx-001',
  transaction_amount: { currency: 'EUR', amount: '10.00' },
  exchange_rate: {
    unit_currency: 'EUR',
    exchange_rate: '0.91000000',
    rate_type: 'AGRD',
    instructed_amount: { currency: 'USD', amount: '10.99' },
  },
});

export const ENABLE_BANKING_CONTRACT_FIXTURES = Object.freeze({
  session: JSON.stringify({
    session_id: '018f0000-0000-7000-8000-000000000800',
    accounts: [account],
    aspsp: { name: 'Swedbank', country: 'LV' },
    psu_type: 'personal',
    access: { valid_until: '2027-03-23T12:00:00.000000+00:00' },
  }),
  balances: JSON.stringify({
    balances: [
      {
        name: 'Closing booked',
        balance_amount: { currency: 'EUR', amount: '1234.56' },
        balance_type: 'CLBD',
        last_change_date_time: '2026-09-23T20:00:00Z',
        reference_date: '2026-09-23',
        last_committed_transaction: 'archive-card-001',
      },
      {
        name: 'Interim booked',
        balance_amount: { currency: 'EUR', amount: '1222.22' },
        balance_type: 'ITBD',
        last_change_date_time: '2026-09-24T08:00:00Z',
        reference_date: '2026-09-24',
        last_committed_transaction: 'archive-refund-001',
      },
      {
        name: 'Interim available',
        balance_amount: { currency: 'EUR', amount: '1209.88' },
        balance_type: 'ITAV',
        last_change_date_time: '2026-09-24T08:00:00Z',
        reference_date: '2026-09-24',
      },
    ],
  }),
  firstPage: JSON.stringify({
    transactions: [bookedCard, pendingCard, salary, atm, brokerage, refund, exchangedCard],
    continuation_key: 'synthetic-page-2',
  }),
  emptyContinuationPage: JSON.stringify({
    transactions: [],
    continuation_key: 'synthetic-page-3',
  }),
  finalPage: JSON.stringify({ transactions: [], continuation_key: null }),
  items: Object.freeze({
    account,
    bookedCard,
    pendingCard,
    changedIdBookedCard,
    salary,
    atm,
    brokerage,
    refund,
    exchangedCard,
  }),
});
