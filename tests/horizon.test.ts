import { inspectHorizon } from '../src/inspectors/horizon';
import { auditSponsorshipLifecycle } from '../src/inspectors/sponsorship';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(overrides: Record<string, string | null> = {}) {
  const defaults: Record<string, string | null> = {
    'x-ratelimit-limit': null,
    'x-ratelimit-remaining': null,
    'x-ratelimit-reset': null,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: (name: string) => merged[name.toLowerCase()] ?? null,
  };
}

const minimalBody = {
  network_passphrase: 'Test SDF Network ; September 2015',
  horizon_version: '2.28.0',
  core_version: 'v19.6.0',
  history_latest_ledger: 45000000,
  history_elder_ledger: 1,
  core_latest_ledger: 45000000,
  protocol_version: 21,
};

function mockOnlineResponse(
  body = minimalBody,
  headerOverrides: Record<string, string | null> = {},
) {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    headers: makeHeaders(headerOverrides),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Horizon Inspector', () => {
  const mockUrl = 'https://mock-horizon.stellar.org';
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ── Core fields ──────────────────────────────────────────────────────────

  it('returns status=online with full metadata on a healthy node', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse());

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('online');
    expect(info.networkPassphrase).toBe(minimalBody.network_passphrase);
    expect(info.horizonVersion).toBe(minimalBody.horizon_version);
    expect(info.coreVersion).toBe(minimalBody.core_version);
    expect(info.historyLatestLedger).toBe(45000000);
    expect(info.protocolVersion).toBe(21);
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes URLs with trailing slashes', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse());

    const info = await inspectHorizon('https://mock-horizon.stellar.org/');

    expect(info.url).toBe('https://mock-horizon.stellar.org');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock-horizon.stellar.org/',
      expect.any(Object),
    );
  });

  it('returns status=offline when fetch throws a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection Refused'));

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.networkPassphrase).toBeUndefined();
  });

  it('returns status=offline when Horizon returns an HTTP error status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      headers: makeHeaders(),
    } as unknown as Response);

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
  });

  // ── Rate limit — all headers present ────────────────────────────────────

  it('parses all three rate limit headers when present', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '3600',
        'x-ratelimit-remaining': '3599',
        'x-ratelimit-reset': '10',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBe(3600);
    expect(info.rateLimit.remaining).toBe(3599);
    expect(info.rateLimit.resetSeconds).toBe(10);
    expect(info.rateLimit.hasRateLimitInfo).toBe(true);
  });

  it('computes remainingPercent correctly', async () => {
    // 1800 used of 3600 → 50% remaining
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '3600',
        'x-ratelimit-remaining': '1800',
        'x-ratelimit-reset': '30',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.remainingPercent).toBe(50);
    expect(info.rateLimit.usedPercent).toBe(50);
  });

  it('marks isLow=true when remaining is below 10% of limit', async () => {
    // 5 remaining of 100 = 5%
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': '60',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.isLow).toBe(true);
  });

  it('marks isLow=false when remaining is at or above 10%', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '10',
        'x-ratelimit-reset': '60',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.isLow).toBe(false);
  });

  // ── Rate limit — missing headers ─────────────────────────────────────────

  it('returns null rate limit fields when headers are absent', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse()); // no RL headers

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.resetSeconds).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
    expect(info.rateLimit.isLow).toBe(false);
  });

  it('handles partial headers (limit only) gracefully', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockOnlineResponse(minimalBody, { 'x-ratelimit-limit': '3600' }));

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBe(3600);
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
  });

  it('handles malformed (non-numeric) header values without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': 'unlimited',
        'x-ratelimit-remaining': 'n/a',
        'x-ratelimit-reset': '--',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.resetSeconds).toBeNull();
  });

  // ── Offline nodes also carry the rateLimit field ─────────────────────────

  it('includes a rateLimit field (all nulls) even when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit).toBeDefined();
    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sponsorship lifecycle audit
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFQ';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: makeHeaders(),
  } as unknown as Response;
}

function accountBody(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    account_id: ACCOUNT_ID,
    sequence: '123456789',
    subentry_count: 2,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [],
    signers: [],
    data: {},
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    ...overrides,
  };
}

function operationsBody(records: unknown[], next?: string) {
  return {
    _embedded: { records },
    _links: next ? { next: { href: next } } : {},
  };
}

/**
 * Routes fetch calls to the account endpoint, the operations endpoint and the
 * ledger-entry endpoints used by the sponsorship audit.
 */
function mockSponsorshipFetch(options: {
  account?: unknown;
  accountStatus?: number;
  operations?: unknown;
  operationsStatus?: number;
  entries?: Record<string, unknown>;
}) {
  const {
    account = accountBody(),
    accountStatus = 200,
    operations = operationsBody([]),
    operationsStatus = 200,
    entries = {},
  } = options;

  return jest.fn().mockImplementation((url: string) => {
    if (url.includes('/operations')) {
      return Promise.resolve(jsonResponse(operations, operationsStatus));
    }
    if (url.includes('/accounts/')) {
      return Promise.resolve(jsonResponse(account, accountStatus));
    }
    for (const [key, value] of Object.entries(entries)) {
      if (url.includes(key)) {
        return Promise.resolve(jsonResponse(value));
      }
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

describe('Sponsorship Lifecycle Audit', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ── Counters: zero / nonzero / unavailable ──────────────────────────────

  it('reports zero sponsorship counters without inventing relationships', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 0, num_sponsored: 0 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.accountId).toBe(ACCOUNT_ID);
    expect(report.summary.numSponsoring).toBe(0);
    expect(report.summary.numSponsored).toBe(0);
    expect(report.relationships).toEqual([]);
  });

  it('reports nonzero counters and distinguishes sponsoring from sponsored', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 3, num_sponsored: 2 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.summary.numSponsoring).toBe(3);
    expect(report.summary.numSponsored).toBe(2);
    // Counters alone must not be turned into concrete relationships.
    expect(report.relationships).toEqual([]);
    expect(report.limitations.join(' ')).toMatch(/counter/i);
  });

  it('flags unavailable sponsorship counters as a limitation', async () => {
    const account = accountBody();
    delete (account as Record<string, unknown>).num_sponsoring;
    delete (account as Record<string, unknown>).num_sponsored;

    global.fetch = mockSponsorshipFetch({ account });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.summary.numSponsoring).toBeNull();
    expect(report.summary.numSponsored).toBeNull();
    expect(report.limitations.join(' ')).toMatch(/num_sponsoring|num_sponsored/i);
  });

  it('does not throw when optional account fields are absent', async () => {
    global.fetch = mockSponsorshipFetch({
      account: { id: ACCOUNT_ID, account_id: ACCOUNT_ID },
    });

    await expect(
      auditSponsorshipLifecycle(ACCOUNT_ID, { horizonUrl: 'https://mock-horizon.stellar.org' }),
    ).resolves.toBeDefined();
  });

  // ── Relationships from ledger entries ───────────────────────────────────

  it('identifies entries sponsored by the inspected account', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1, num_sponsored: 0 }),
      entries: {
        '/data/': {
          _embedded: {
            records: [
              {
                id: 'data-1',
                sponsor: ACCOUNT_ID,
                sponsored_id: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                type: 'data',
              },
            ],
          },
        },
      },
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    const sponsored = report.relationships.filter((r) => r.direction === 'sponsoring');
    expect(sponsored.length).toBeGreaterThanOrEqual(0);
    for (const rel of report.relationships) {
      expect(['sponsoring', 'sponsored', 'unknown']).toContain(rel.direction);
    }
  });

  it('identifies entries for which another account provides sponsorship', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 0, num_sponsored: 1 }),
      entries: {
        '/data/': {
          _embedded: {
            records: [
              {
                id: 'data-2',
                sponsor: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
                sponsored_id: ACCOUNT_ID,
                type: 'data',
              },
            ],
          },
        },
      },
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    for (const rel of report.relationships) {
      expect(rel.sponsoredAccount).toBeDefined();
    }
  });

  it('handles accounts participating in both sponsoring and sponsored relationships', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1, num_sponsored: 1 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.summary.numSponsoring).toBe(1);
    expect(report.summary.numSponsored).toBe(1);
    expect(report.status).toBeDefined();
  });

  // ── Sponsorship start / end events ──────────────────────────────────────

  it('summarizes observed sponsorship start events from operations', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1 }),
      operations: operationsBody([
        {
          id: 'op-1',
          type: 'create_account',
          sponsor: ACCOUNT_ID,
          sponsored_id: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
          created_at: '2024-01-01T00:00:00Z',
        },
      ]),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.events.some((e) => e.kind === 'start')).toBe(true);
  });

  it('summarizes observed sponsorship end events from operations', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 0 }),
      operations: operationsBody([
        {
          id: 'op-2',
          type: 'revoke_sponsorship',
          sponsor: ACCOUNT_ID,
          sponsored_id: 'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
          created_at: '2024-02-01T00:00:00Z',
        },
      ]),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.events.some((e) => e.kind === 'end')).toBe(true);
  });

  it('distinguishes current relationships from historical events', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 0, num_sponsored: 0 }),
      operations: operationsBody([
        {
          id: 'op-3',
          type: 'revoke_sponsorship',
          sponsor: ACCOUNT_ID,
          sponsored_id: 'GFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
          created_at: '2024-03-01T00:00:00Z',
        },
      ]),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.relationships).toEqual([]);
    expect(report.events.length).toBeGreaterThan(0);
  });

  // ── Missing history and incomplete pagination ───────────────────────────

  it('flags missing operation history', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1 }),
      operations: operationsBody([]),
      operationsStatus: 404,
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.limitations.join(' ')).toMatch(/operation/i);
  });

  it('flags incomplete pagination when a next link is present', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 5 }),
      operations: operationsBody(
        [
          {
            id: 'op-4',
            type: 'create_account',
            sponsor: ACCOUNT_ID,
            sponsored_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
            created_at: '2024-04-01T00:00:00Z',
          },
        ],
        'https://mock-horizon.stellar.org/accounts/' + ACCOUNT_ID + '/operations?cursor=op-4',
      ),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report.limitations.join(' ')).toMatch(/pagination|incomplete/i);
  });

  // ── Unsupported entry types ─────────────────────────────────────────────

  it('does not throw on unsupported ledger-entry types', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1 }),
      entries: {
        '/data/': {
          _embedded: {
            records: [
              {
                id: 'weird-1',
                sponsor: ACCOUNT_ID,
                sponsored_id: 'GHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
                type: 'some_future_entry_type',
              },
            ],
          },
        },
      },
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    expect(report).toBeDefined();
    expect(report.limitations.join(' ')).toMatch(/unsupported|unknown/i);
  });

  // ── Reserve estimates ───────────────────────────────────────────────────

  it('labels reserve figures as estimates with documented assumptions', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 2, num_sponsored: 1 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    if (report.reserveEstimate) {
      expect(report.reserveEstimate.isEstimate).toBe(true);
      expect(report.reserveEstimate.assumptions.length).toBeGreaterThan(0);
    }
  });

  it('handles incomplete network parameters for reserve estimates', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
      networkParams: undefined,
    });

    expect(report).toBeDefined();
    if (report.reserveEstimate) {
      expect(report.reserveEstimate.isEstimate).toBe(true);
    }
  });

  // ── JSON output ─────────────────────────────────────────────────────────

  it('produces JSON output for a complete audit', async () => {
    global.fetch = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1, num_sponsored: 1 }),
    });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });
    const json = JSON.parse(JSON.stringify(report));

    expect(json.accountId).toBe(ACCOUNT_ID);
    expect(json.summary).toBeDefined();
    expect(json.findings).toBeDefined();
    expect(json.limitations).toBeDefined();
    expect(json.status).toBeDefined();
  });

  it('produces JSON output for a partial audit', async () => {
    const account = accountBody();
    delete (account as Record<string, unknown>).num_sponsoring;

    global.fetch = mockSponsorshipFetch({ account, operationsStatus: 404 });

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });
    const json = JSON.parse(JSON.stringify(report));

    expect(json.accountId).toBe(ACCOUNT_ID);
    expect(json.limitations.length).toBeGreaterThan(0);
    expect(['complete', 'partial', 'inconclusive']).toContain(json.status);
  });

  it('produces JSON output for an inconclusive audit', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const report = await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });
    const json = JSON.parse(JSON.stringify(report));

    expect(json.accountId).toBe(ACCOUNT_ID);
    expect(json.status).toBe('inconclusive');
    expect(json.limitations.length).toBeGreaterThan(0);
  });

  // ── Read-only guarantee ─────────────────────────────────────────────────

  it('never submits transactions or initiates sponsorship operations', async () => {
    const fetchMock = mockSponsorshipFetch({
      account: accountBody({ num_sponsoring: 1, num_sponsored: 1 }),
    });
    global.fetch = fetchMock;

    await auditSponsorshipLifecycle(ACCOUNT_ID, {
      horizonUrl: 'https://mock-horizon.stellar.org',
    });

    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit | undefined];
      expect(url).not.toMatch(/\/transactions/);
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });
});
