import { fetchOperations } from '../src/services/operations';
import { normalizeOperation, normalizeOperationType } from '../utils/operation-parser';
import {
  auditAccountLedgerEntries,
  formatLedgerEntryAudit,
} from '../src/services/ledger-entry-audit';

describe('operations history', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes common operation fields and details', () => {
    const op = normalizeOperation({
      id: '1',
      transaction_hash: 'abc',
      source_account: 'GABC',
      type: 'payment',
      created_at: '2026-01-01T00:00:00Z',
      from: 'GA',
      to: 'GB',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      amount: '10.0000000',
    });

    expect(op.transactionHash).toBe('abc');
    expect(op.details.assetCode).toBe('USDC');
    expect(op.details.amount).toBe('10.0000000');
  });

  it('normalizes operation type filter aliases', () => {
    expect(normalizeOperationType('manage-buy-offer')).toBe('manage_buy_offer');
  });

  it('fetches operations, applies type filtering, and follows pagination safely', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      calls.push(url);
      const firstPage = calls.length === 1;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            _embedded: {
              records: firstPage
                ? [
                    {
                      id: '1',
                      transaction_hash: 'tx1',
                      source_account: 'GA',
                      type: 'create_account',
                      created_at: '2026-01-01T00:00:00Z',
                    },
                    {
                      id: '2',
                      transaction_hash: 'tx2',
                      source_account: 'GB',
                      type: 'payment',
                      created_at: '2026-01-02T00:00:00Z',
                      amount: '5',
                    },
                  ]
                : [
                    {
                      id: '3',
                      transaction_hash: 'tx3',
                      source_account: 'GC',
                      type: 'payment',
                      created_at: '2026-01-03T00:00:00Z',
                      amount: '9',
                    },
                  ],
            },
            _links: {
              next: { href: firstPage ? 'https://horizon.example/next' : undefined },
            },
          }),
      } as Response);
    });

    const result = await fetchOperations({
      horizonUrl: 'https://horizon.example',
      type: 'payment',
      limit: 2,
    });

    expect(result.operations).toHaveLength(2);
    expect(result.operations.map((operation) => operation.id)).toEqual(['2', '3']);
    expect(calls[0]).toContain('/operations');
    expect(calls).toHaveLength(2);
  });

  it('uses account-scoped operations endpoint when account filter is present', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ _embedded: { records: [] }, _links: {} }),
    } as Response);

    await fetchOperations({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
      limit: 1,
    });

    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      '/accounts/GACCOUNT/operations',
    );
  });
});

describe('account ledger-entry ownership audit', () => {
  const originalFetch = global.fetch;

  const accountResponse = (overrides: Record<string, unknown> = {}) => ({
    id: 'GACCOUNT',
    account_id: 'GACCOUNT',
    sequence: '1',
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
      },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        balance: '10.0000000',
        sponsor: 'GSPONSOR',
      },
    ],
    signers: [],
    data: {
      config: 'dmFsdWU=',
    },
    num_sponsoring: 1,
    num_sponsored: 1,
    ...overrides,
  });

  const jsonResponse = (body: unknown, ok = true) =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    } as Response);

  const routeFetch = (
    handlers: Record<string, (url: string) => Response | Promise<Response>>,
  ) => {
    const calls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      calls.push(String(url));
      const match = Object.keys(handlers).find((key) => String(url).includes(key));
      if (!match) {
        return Promise.resolve(jsonResponse({ _embedded: { records: [] }, _links: {} }));
      }
      return Promise.resolve(handlers[match](String(url)));
    });
    return calls;
  };

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('categorizes trustlines, offers, claimable balances, and data entries', async () => {
    routeFetch({
      '/accounts/GACCOUNT/offers': () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                id: '99',
                seller: 'GACCOUNT',
                selling: { asset_type: 'native' },
                buying: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
                amount: '5.0000000',
                sponsor: 'GSPONSOR',
              },
            ],
          },
          _links: {},
        }),
      '/claimable_balances': () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                id: 'cb-1',
                sponsor: 'GSPONSOR',
                claimant: 'GACCOUNT',
                asset: 'USDC:GISSUER',
                amount: '3.0000000',
              },
            ],
          },
          _links: {},
        }),
      '/accounts/GACCOUNT': () => jsonResponse(accountResponse()),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    const categories = audit.categories.map((category) => category.category);
    expect(categories).toEqual(
      expect.arrayContaining(['trustline', 'offer', 'claimable_balance', 'data_entry']),
    );

    const trustline = audit.categories.find((c) => c.category === 'trustline');
    expect(trustline?.entries[0]).toMatchObject({
      identifier: 'USDC:GISSUER',
      relationship: 'sponsored',
      sponsor: 'GSPONSOR',
    });

    const offer = audit.categories.find((c) => c.category === 'offer');
    expect(offer?.entries[0]).toMatchObject({
      identifier: '99',
      relationship: 'sponsored',
      sponsor: 'GSPONSOR',
    });

    const claimable = audit.categories.find((c) => c.category === 'claimable_balance');
    expect(claimable?.entries[0]).toMatchObject({
      identifier: 'cb-1',
      relationship: 'sponsored',
      sponsor: 'GSPONSOR',
    });

    const dataEntry = audit.categories.find((c) => c.category === 'data_entry');
    expect(dataEntry?.entries[0]).toMatchObject({
      identifier: 'config',
      relationship: 'direct',
    });
  });

  it('distinguishes directly associated resources from sponsored ones', async () => {
    routeFetch({
      '/accounts/GACCOUNT/offers': () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                id: '1',
                seller: 'GACCOUNT',
                selling: { asset_type: 'native' },
                buying: { asset_type: 'native' },
                amount: '1.0000000',
              },
            ],
          },
          _links: {},
        }),
      '/claimable_balances': () => jsonResponse({ _embedded: { records: [] }, _links: {} }),
      '/accounts/GACCOUNT': () =>
        jsonResponse(
          accountResponse({
            balances: [
              { asset_type: 'native', balance: '100.0000000' },
              {
                asset_type: 'credit_alphanum4',
                asset_code: 'USDC',
                asset_issuer: 'GISSUER',
                balance: '10.0000000',
              },
            ],
            num_sponsoring: 0,
            num_sponsored: 0,
          }),
        ),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    const trustline = audit.categories.find((c) => c.category === 'trustline');
    expect(trustline?.entries[0].relationship).toBe('direct');

    const offer = audit.categories.find((c) => c.category === 'offer');
    expect(offer?.entries[0].relationship).toBe('direct');
  });

  it('handles empty resource collections without claiming completeness', async () => {
    routeFetch({
      '/accounts/GACCOUNT': () =>
        jsonResponse(
          accountResponse({
            balances: [{ asset_type: 'native', balance: '100.0000000' }],
            data: {},
            num_sponsoring: 0,
            num_sponsored: 0,
          }),
        ),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    expect(audit.categories.every((category) => category.entries.length === 0)).toBe(true);
    expect(audit.complete).toBe(false);
    expect(audit.status).toBe('partial');
    expect(audit.limitations.length).toBeGreaterThan(0);
  });

  it('marks the audit partial when pagination is incomplete', async () => {
    routeFetch({
      '/accounts/GACCOUNT/offers': () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                id: '1',
                seller: 'GACCOUNT',
                selling: { asset_type: 'native' },
                buying: { asset_type: 'native' },
                amount: '1.0000000',
              },
            ],
          },
          _links: { next: { href: 'https://horizon.example/accounts/GACCOUNT/offers?cursor=1' } },
        }),
      '/accounts/GACCOUNT': () => jsonResponse(accountResponse()),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
      maxPages: 1,
    });

    expect(audit.status).toBe('partial');
    expect(audit.complete).toBe(false);
    expect(audit.incompletePagination).toBe(true);
  });

  it('reports retrieval failures and unavailable endpoints', async () => {
    routeFetch({
      '/accounts/GACCOUNT/offers': () => jsonResponse({}, false),
      '/claimable_balances': () => jsonResponse({}, false),
      '/accounts/GACCOUNT': () => jsonResponse(accountResponse()),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    expect(audit.status).toBe('failed');
    expect(audit.errors.length).toBeGreaterThan(0);
    expect(audit.categories.find((c) => c.category === 'offer')?.status).toBe('failed');
  });

  it('tolerates unsupported response fields', async () => {
    routeFetch({
      '/accounts/GACCOUNT/offers': () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                id: '1',
                seller: 'GACCOUNT',
                selling: { asset_type: 'native' },
                buying: { asset_type: 'native' },
                amount: '1.0000000',
                unexpected_field: { nested: true },
              },
            ],
          },
          _links: {},
        }),
      '/accounts/GACCOUNT': () =>
        jsonResponse(accountResponse({ unknown_top_level: 'value' })),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    expect(audit.categories.find((c) => c.category === 'offer')?.entries).toHaveLength(1);
    expect(audit.status).not.toBe('failed');
  });

  it('produces machine-readable JSON for complete, partial, and failed audits', async () => {
    routeFetch({
      '/accounts/GACCOUNT': () =>
        jsonResponse(
          accountResponse({
            balances: [{ asset_type: 'native', balance: '100.0000000' }],
            data: {},
            num_sponsoring: 0,
            num_sponsored: 0,
          }),
        ),
    });

    const audit = await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    const json = formatLedgerEntryAudit(audit);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('categories');
    expect(parsed).toHaveProperty('limitations');
    expect(parsed).toHaveProperty('complete');
    expect(['complete', 'partial', 'failed']).toContain(parsed.status);
  });

  it('performs only read-only HTTP requests', async () => {
    const calls = routeFetch({
      '/accounts/GACCOUNT': () => jsonResponse(accountResponse()),
    });

    await auditAccountLedgerEntries({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
    });

    const fetchMock = global.fetch as jest.Mock;
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const method = (init?.method ?? 'GET').toUpperCase();
      expect(method).toBe('GET');
    }
    expect(calls.every((url) => url.startsWith('https://horizon.example'))).toBe(true);
  });
});
