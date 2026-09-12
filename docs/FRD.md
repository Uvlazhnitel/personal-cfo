# Personal CFO — Functional Requirements v0.1

## 1. Product Goal

Personal CFO is a personal financial system whose primary purpose is not to control overspending, but to help the user:

* allocate current income effectively;
* maintain sufficient liquidity;
* avoid keeping excessive amounts of capital idle in cash;
* determine a reasonable level of recurring and additional investments;
* account for large future expenses in advance;
* track overall capital growth;
* identify financial inefficiencies;
* forecast the consequences of current financial decisions.

The main goal is:

> Maximize the user’s long-term capital growth without excessively restricting their current quality of life or creating a risk of insufficient liquidity.

---

# 2. Initial User Profile

V1 is initially designed for a single user.

Initial conditions:

| Parameter              | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Primary income         | Fixed monthly salary                                                   |
| Additional income      | Small side hustle, primarily in cash                                   |
| Primary bank           | Swedbank                                                               |
| Primary payment method | Bank card                                                              |
| Cash expenses          | Relatively infrequent                                                  |
| Investments            | ETFs through Lightyear                                                 |
| Current investment     | Approximately €50/month                                                |
| Portfolio tracker      | Already exists separately                                              |
| Primary currency       | EUR                                                                    |
| Client                 | PWA on iPhone                                                          |
| Quick input            | Telegram text or voice messages                                        |
| Backend                | Self-hosted server                                                     |
| Financial literacy     | High                                                                   |
| Main problem           | Not controlling impulsive spending, but allocating capital efficiently |

---

# 3. Core Product Principles

### 3.1. Minimum Manual Work

Most financial data should be collected automatically.

The user should manually enter only information that the system cannot obtain from external sources:

* cash income;
* cash expenses;
* large future expenses;
* financial goals;
* occasional transaction-classification corrections.

---

### 3.2. Decision-Oriented UI

The application should not be a traditional expense tracker.

The main screen should primarily answer the following questions:

* How much capital do I have?
* How quickly is it growing?
* How much cash do I actually need?
* Do I have excess cash?
* How much can I safely invest right now?
* Should I increase my recurring investment?
* Which future expenses should already be taken into account?
* Is there any significant financial inefficiency?

Expense categories and transaction lists are supporting data, not the main focus.

---

### 3.3. Deterministic Financial Engine

All critical financial calculations must be performed by code.

AI must not independently calculate:

* Net Worth;
* Safe to Invest;
* Capital Conversion Rate;
* Cash Drag;
* Sinking Fund amounts;
* projected mandatory expenses;
* Investment Step-Up.

AI receives pre-calculated metrics and explains them to the user.

---

### 3.4. AI as CFO, Not Accountant

AI should not only answer:

> “You spent €X.”

It should answer:

> “What does this mean, and what financial action would make sense?”

---

# 4. Data Sources

## FR-001 — Swedbank Integration

The system must automatically retrieve the user’s bank transactions.

For each transaction, it should ideally store:

* transaction ID;
* date;
* time;
* amount;
* currency;
* merchant/counterparty;
* description;
* account;
* transaction type;
* data source;
* original bank data.

The integration is expected to use an Open Banking provider.

The system must not store the user’s banking password.

---

## FR-002 — Transaction Synchronization

The backend must periodically synchronize new bank transactions.

Each transaction must be imported only once.

The system must provide protection against duplicate transactions.

---

## FR-003 — Cash Transactions via Telegram

The user must be able to write:

> €12 lunch paid in cash

or send a voice message:

> “Today I paid €27 in cash for a haircut.”

The system must convert the message into a structured transaction.

Example:

```json
{
  "amount": -27,
  "currency": "EUR",
  "category": "personal_care",
  "payment_method": "cash",
  "date": "2026-09-12"
}
```

After recording the transaction, Telegram should return a short confirmation.

If classification confidence is high, no additional confirmation should be required.

---

## FR-004 — Cash Income

The user must be able to report:

> “I received €120 in cash from my side hustle.”

The system must classify this as:

* income;
* source = side hustle;
* payment method = cash.

---

## FR-005 — Cash Account

The system must include a separate virtual Cash Account.

An ATM withdrawal of €100:

```text
Swedbank -€100
Cash +€100
```

must not be treated as an expense.

The actual expense occurs only when the cash is subsequently spent.

---

## FR-006 — Portfolio Integration

The application must retrieve data from the existing portfolio tracker.

At a minimum:

* current investment portfolio value;
* contributed capital;
* current ETF holdings;
* investment contributions;
* investment P/L.

The system must prevent double counting.

For example:

```text
Swedbank → Lightyear €200
```

is not an expense.

It is an internal capital transfer / investment contribution.

---

# 5. Transaction Engine

## FR-010 — Automatic Categorization

Every new transaction must be classified automatically.

Minimum transaction types:

* income;
* side hustle income;
* consumption;
* recurring expense;
* investment;
* account transfer;
* cash withdrawal;
* refund;
* reimbursement;
* reserved spending.

---

## FR-011 — Expense Categories

For analytical purposes, the system may use the following categories:

* housing;
* groceries;
* restaurants;
* delivery;
* transport;
* taxi;
* subscriptions;
* sport;
* health;
* entertainment;
* shopping;
* travel;
* education;
* other.

Categories should not be the primary element of the interface.

---

## FR-012 — Classification Learning

If the user corrects a merchant classification, the system must remember the rule.

For example:

```text
BOULDERING CENTER
→ Sport
```

Future similar transactions should be classified automatically.

---

# 6. Net Worth

## FR-020 — Net Worth Calculation

The system must display the user’s current Net Worth.

Basic model:

```text
Cash
+ Bank balances
+ Investment portfolio
+ Other tracked assets
- Liabilities
= Net Worth
```

V1 may not support liabilities if the user has none.

---

## FR-021 — Net Worth History

The system must store daily or periodic Net Worth snapshots.

The user must be able to see:

* change over the current month;
* change over 3 months;
* change over 6 months;
* change over 1 year;
* all-time change.

---

## FR-022 — Sources of Net Worth Growth

Changes in capital must be separated into at least:

**Capital Contributed**

Money earned by the user and saved or invested.

**Investment Return**

An increase or decrease in the value of assets.

Example:

```text
Net worth +€1,350

+€1,200 new capital
+€150 investment return
```

---

# 7. Capital Conversion Rate

## FR-030 — CCR Calculation

Capital Conversion Rate shows what percentage of received income was converted into long-term capital.

Simplified formula:

```text
Capital created from income
───────────────────────────
Recognized income
```

Capital created may include:

* investment contributions;
* an increase in the emergency reserve;
* an increase in long-term unallocated cash.

It does not include:

* market gains;
* internal transfers;
* money reserved for a future trip or purchase;
* refunds.

---

## FR-031 — CCR Periods

The system must display:

* current month;
* rolling 3 months;
* rolling 6 months;
* rolling 12 months.

The rolling average should be the primary metric so that a trip or large purchase does not make one individual month appear disproportionately negative.

---

## FR-032 — CCR Explanation

AI must be able to explain changes in the metric.

For example:

> Your 6-month Capital Conversion Rate increased from 28% to 34%. The main reasons were higher investment contributions and increased side-hustle income.

---

# 8. Liquidity / Cash Reserve

## FR-040 — Spending Baseline

The system must determine the user’s normal spending level based on historical data.

It must account for:

* recurring expenses;
* variable expenses;
* seasonality when sufficient historical data is available;
* irregular large expenses separately.

A single large trip must not automatically increase the normal monthly spending baseline.

---

## FR-041 — Liquidity Reserve

The system must calculate a recommended liquidity reserve.

It must take into account:

* normal monthly burn rate;
* income stability;
* spending variability;
* upcoming mandatory payments;
* Sinking Funds;
* the user’s risk preference.

The system must display the following ranges:

```text
Minimum cash
Comfort cash
Current cash
Excess cash
```

---

# 9. Cash Drag Detector

## FR-050 — Excess Cash

The system must identify capital that remains in cash for an extended period beyond the required liquidity level.

Example:

```text
Liquid cash            €7,200
Reserved               €800
Comfort reserve       €4,500
───────────────────────────
Potential excess      €1,900
```

---

## FR-051 — Cash Drag Notification

If a significant amount remains above the comfort cash level for an extended period, the CFO must notify the user.

Example:

> Over the last 60 days, you have held an average of approximately €1,700 above your comfort cash buffer. Your recurring investment contribution may be too low.

---

## FR-052 — No Automatic Investment

The Cash Drag Detector must not invest money automatically.

It only generates a recommendation.

---

# 10. Sinking Funds

## FR-060 — Future Expense

The user must be able to create a future expense.

Example:

```text
Japan
Target: €1,500
Date: May 2027
```

---

## FR-061 — Required Contribution

The system must calculate the required monthly reserve contribution.

For example:

```text
Remaining: €900
Months remaining: 6

Required reserve:
€150/month
```

---

## FR-062 — Reserved Cash

Sinking Fund money may physically remain in the regular Swedbank account.

However, the financial engine must treat it as reserved.

It must not be included in:

* Excess Cash;
* Safe to Invest;
* freely disposable cash.

---

# 11. Safe to Invest

## FR-070 — Safe to Invest Calculation

The system must calculate how much money the user can invest immediately without compromising liquidity.

Conceptually:

```text
Current liquid cash

- operational cash until next income
- future obligations
- sinking funds
- minimum/comfort liquidity reserve

= investable surplus
```

---

## FR-071 — Investment Range

Instead of a single arbitrary number, the system should provide a range:

```text
Conservative: €180
Recommended:  €240
Maximum:      €310
```

---

## FR-072 — Explanation

Every recommendation must be explainable.

Example:

> The €240 recommendation accounts for expected expenses before the next salary, €350 in reserved funds, and maintaining a comfort cash level of €4,500.

---

## FR-073 — Mid-Month Recalculation

Safe to Invest must be updated when:

* salary is received;
* side-hustle income is received;
* large expenses occur;
* a Sinking Fund is created;
* the bank balance changes;
* upcoming obligations change.

---

# 12. Investment Step-Up

## FR-080 — Sustainable Investment Detection

The system must analyze whether the current recurring investment contribution reflects the user’s actual financial capacity.

Example:

```text
Current investment: €50/month

Average sustainable investable surplus:
€220/month
```

---

## FR-081 — Step-Up Recommendation

If the user maintains excess cash and sufficient liquidity for several consecutive months, the application should suggest increasing the recurring investment.

Example:

> For the last four months, your liquidity has remained above the comfort level even after all expenses. You may want to consider increasing your recurring contribution from €50 to €150.

---

## FR-082 — Gradual Increases

The application must not immediately recommend the maximum possible amount.

Investment Step-Up should be gradual.

For example:

```text
€50
↓
€100
↓
€150
↓
€200
```

with periodic reassessment.

---

## FR-083 — Step-Down

If the user’s financial situation temporarily deteriorates, the system must also be able to suggest:

* not increasing the investment;
* temporarily keeping the current level;
* reducing it if necessary.

---

# 13. Expense Optimization

## FR-090 — Spending Drift

The system must look for significant changes in spending behavior.

Example:

```text
Taxi baseline: €65/month
Current forecast: €128/month

Drift: +€63
```

---

## FR-091 — Recurring Leak Detection

The system must detect:

* new subscriptions;
* recurring payments;
* price increases for recurring services;
* potentially unused services, if additional data is available.

---

## FR-092 — Optimization Priority

The application must not optimize expenses merely because they exist.

Priority:

1. unnecessary recurring expenses;
2. obvious financial inefficiencies;
3. spending drift;
4. convenience spending;
5. other discretionary expenses.

Useful expenses, such as sports activities, must not automatically be treated as problems.

---

## FR-093 — Potential Savings

Each optimization recommendation must include an approximate financial impact.

For example:

> Reduce delivery spending to the normal baseline
> Potential saving: ~€65/month.

---

## FR-094 — Actual Savings

If the user accepts a recommendation, the application must compare the subsequent result with the baseline.

For example:

```text
Expected saving: €60
Actual estimated saving: €53
```

---

# 14. Financial Forecast

## FR-100 — Capital Forecast

The system must forecast Net Worth over the following horizons:

* 1 year;
* 3 years;
* 5 years;
* 10 years.

---

## FR-101 — Forecast Components

The forecast must separately account for:

* current capital;
* monthly capital contributions;
* expected investments;
* expected cash accumulation;
* investment-return assumptions;
* planned future expenses.

---

## FR-102 — Contributions-Only Forecast

The system must provide a mode that does not assume any market returns.

Example:

```text
With contributions only
€32,400

With assumed investment growth
€38,700
```

This allows the user to distinguish between their own contributions and modelled investment returns.

---

## FR-103 — What-If Scenarios

The user must be able to test scenarios such as:

> What if I invest an additional €100 per month?

> What if I invest all of my side-hustle income?

> What if my salary increases by €300?

> What if I take a €2,000 trip?

> What if I buy a €10,000 car?

The system must immediately show how the scenario changes the forecast.

---

# 15. AI CFO

## FR-110 — CFO Context

AI must have access to aggregated financial data:

* income;
* expenses;
* spending baseline;
* recurring expenses;
* liquidity reserve;
* Sinking Funds;
* Safe to Invest;
* Cash Drag;
* investments;
* portfolio;
* Net Worth;
* CCR;
* forecast.

---

## FR-111 — CFO Responsibilities

AI may:

* explain financial metrics;
* identify meaningful changes;
* formulate recommendations;
* rank recommendations;
* explain consequences;
* answer the user’s financial questions.

AI must not modify financial data without the user’s explicit action.

---

## FR-112 — Explainability

Every important recommendation must answer the question:

> Why?

For example:

> Why do you recommend investing €220?

AI must explain the recommendation using the user’s actual financial metrics.

---

## FR-113 — No Invented Numbers

AI must not invent financial values.

All amounts must come from the Financial Engine.

---

# 16. Proactive CFO

Telegram is the primary channel for proactive messages.

## FR-120 — Salary Event

After detecting a salary payment:

> Salary received: €X
> Planned obligations: €Y
> Safe to Invest: €Z
> Suggested investment: €N

---

## FR-121 — Weekly CFO

Once a week, the application may send a short report:

```text
Weekly CFO

Spending: normal
Net worth: +€X
Safe to invest: €Y
Cash drag: none
Capital Conversion Rate: Z%

No action required.
```

---

## FR-122 — Opportunity Notification

The application may proactively message the user when it detects a significant opportunity.

For example:

> Your cash has remained consistently above the comfort level for the last two months. You may want to consider an additional investment of approximately €300.

---

## FR-123 — Warning Notification

Example:

> Your planned trip in six weeks requires another €420. Your Sinking Fund is currently approximately €110 behind schedule.

---

## FR-124 — Notification Restraint

The application must not generate messages merely to drive engagement.

If nothing financially significant has happened:

> No action required.

is a valid state.

---

# 17. Main Dashboard

The main PWA screen must be focused on capital.

Suggested structure:

```text
NET WORTH
€XX,XXX
+€XXX this month

CAPITAL CONVERSION
34%
6-month avg: 31%

SAFE TO INVEST
€240 recommended

CASH
€6,700
Comfort: €4,500
Excess: €1,300

INVESTMENTS
€X,XXX
Monthly contribution: €XXX

SINKING FUNDS
€X,XXX reserved

FORECAST
1Y / 5Y / 10Y

AI CFO
1 actionable insight
```

---

# 18. Secondary Screens

Minimum set:

### Overview

Main CFO Dashboard.

### Cash Flow

Income, expenses, and capital created.

### Transactions

Full transaction history and classification correction.

### Capital

Cash, portfolio, and Net Worth.

### Investments

Investment contributions, Safe to Invest, and Step-Up.

### Plans

Sinking Funds and future obligations.

### Forecast

What-if scenarios.

### CFO

History of AI recommendations and the ability to ask questions.

---

# 19. Telegram Interface

Telegram must support short, natural-language commands without requiring the user to remember a specific syntax.

Examples:

> Paid €18 in cash for lunch.

> Received €120 from my side hustle.

> I want to take a trip in June costing approximately €1,500.

> Can I invest another €200?

> Why do I have less money left this month?

> Can I buy a laptop for €1,800?

---

# 20. Security

Minimum requirements:

* banking credentials must not be stored;
* external integrations must use OAuth/Open Banking consent;
* API tokens must be stored encrypted;
* the Telegram user ID must be whitelisted;
* the financial API must not be publicly accessible without authentication;
* the user must be able to disconnect a data source;
* the user must be able to delete imported data;
* AI must receive only the financial data it needs.

---

# 21. Out of Scope for V1

The following are intentionally excluded:

* automatic ETF purchases;
* brokerage account management;
* selection of specific stocks or ETFs;
* complex tax planning;
* credit scoring;
* family accounts;
* full accounting functionality;
* dozens of budget categories;
* punitive spending-control systems;
* gamification;
* Apple Health;
* Fitbit / gym cost-per-use;
* complex machine-learning models;
* support for multiple banks;
* a full native iOS application.

The architecture should nevertheless allow some of these capabilities to be added later.

---

# 22. Optional V1.1

After validating the core product, the following may be added:

### Health / Usage Data

Fitbit / Google Health integration to estimate the cost per use of a gym or other services.

### Purchase Decision Assistant

For example:

> Can I afford a €1,800 MacBook?

The answer should include:

* impact on the cash buffer;
* impact on Safe to Invest;
* impact on the Financial Forecast;
* impact on upcoming Sinking Funds.

### Capital Opportunity Cost

Show the long-term effect of a large purchase.

### Income Optimization

Analyze the contribution of side-hustle income to capital growth separately.

---

# 23. Key Product KPIs

The application should track financial outcomes rather than the number of times the user opens the app.

Primary metrics:

**Net Worth Growth**

How much total capital has increased.

**Capital Conversion Rate**

What percentage of income is converted into capital.

**Invested Capital**

How much new money has been invested.

**Cash Drag**

How much capital remains unnecessarily in cash.

**Potential Savings**

How much financial inefficiency has been identified.

**Realized Savings**

The actual impact of recommendations that were accepted.

---

# 24. Main User Cycle

```text
Income received
        ↓
Automatic data import
        ↓
Identification of obligations and reserves
        ↓
Calculation of required liquidity
        ↓
Calculation of Safe to Invest
        ↓
Investment decision
        ↓
Cash-flow monitoring
        ↓
Detection of Cash Drag / inefficiencies
        ↓
Investment Step-Up
        ↓
Net Worth growth
        ↓
Financial Forecast updated
```

---

# 25. Core Product Promise

Personal CFO should not tell the user:

> “You spend too much.”

It should tell the user:

> “Based on your current income, expenses, reserves, and capital, this is the most reasonable way to allocate your money right now.”

And, in the long term, answer the question:

> **How can I convert the largest reasonable portion of my current income into future capital?**
