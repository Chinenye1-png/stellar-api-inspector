import { Keypair } from '@stellar/stellar-sdk';
import { auditAccountMerge, validateMergeAccountIds } from '../src/inspectors/account-merge-audit';
import { formatAccountMergeAudit } from '../src/output/account-merge-audit';
import {
  auditAccountSnapshotConsistency,
  validateSnapshotAccountIds,
} from '../src/inspectors/account-snapshot-consistency';
import { formatAccountSnapshotConsistencyAudit } from '../src/output/account-snapshot-consistency';

const sourceId = Keypair.random().publicKey();
const destinationId = Keypair.random().publicKey();
const horizonUrl = 'https://horizon.example.test';

function account(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
        selling_liabilities: '0.0000000',
        buying_liabilities: '0.0000000',
      },
    ],
    signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
    data: {},
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockHorizon(
  options: {
    source?: unknown;
    destination?: unknown;
    offers?: unknown;
    history?: unknown;
    failSource?: number;
    failDestination?: number;
    failOffers?: number;
  } = {},
) {
  const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
    const url = String(input);
    if (url.includes(`/accounts/${sourceId}/offers`)) {
      return options.failOffers
        ? response({}, options.failOffers)
        : response(options.offers ?? { _embedded: { records: [] } });
    }
    if (url.includes(`/accounts/${sourceId}/operations`)) {
      return response(options.history ?? { _embedded: { records: [] } });
    }
    if (url.includes(`/accounts/${sourceId}`)) {
      return options.failSource
        ? response({}, options.failSource)
        : response(options.source ?? account(sourceId));
    }
    if (url.includes(`/accounts/${destinationId}`)) {
      return options.failDestination
        ? response({}, options.failDestination)
        : response(options.destination ?? account(destinationId));
    }
    return response({}, 404);
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('account merge safety audit', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => jest.clearAllMocks());

  it('validates source and destination IDs before network access', async () => {
    expect(validateMergeAccountIds('bad', destinationId).valid).toBe(false);
    expect(validateMergeAccountIds(sourceId, 'bad').valid).toBe(false);
    const fetchMock = mockHorizon();
    await expect(auditAccountMerge(horizonUrl, 'bad', destinationId)).rejects.toThrow('source');
    await expect(auditAccountMerge(horizonUrl, sourceId, 'bad')).rejects.toThrow('destination');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects identical account IDs before network access', async () => {
    const fetchMock = mockHorizon();
    expect(validateMergeAccountIds(sourceId, sourceId).valid).toBe(false);
    await expect(auditAccountMerge(horizonUrl, sourceId, sourceId)).rejects.toThrow('distinct');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads both accounts and classifies an account with no observed blockers as ready', async () => {
    const fetchMock = mockHorizon();
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);

    expect(result.status).toBe('ready');
    expect(result.sourceAccount.readable).toBe(true);
    expect(result.destinationAccount.readable).toBe(true);
    expect(result.sourceAccount.nativeBalance).toBe('100.0000000');
    expect(result.sourceAccount.estimatedTransferableBalance).toBe('100');
    expect(result.sourceAccount.subentryCount).toBe(0);
    expect(result.sourceAccount.remainingSubentries).toBe(0);
    expect(result.sourceAccount.raw).toEqual(account(sourceId));
    expect(result.sourceAccount.rawOffers).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(result.readOnly).toBe(true);
  });

  it('detects trustlines, offers, data entries, extra signers, sponsorship and liabilities', async () => {
    const customSigner = Keypair.random().publicKey();
    mockHorizon({
      source: account(sourceId, {
        subentry_count: 5,
        num_sponsoring: 1,
        num_sponsored: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '100',
            selling_liabilities: '2',
            buying_liabilities: '1',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: destinationId,
            balance: '5',
            limit: '10',
          },
        ],
        signers: [
          { key: sourceId, weight: 1, type: 'ed25519_public_key' },
          { key: customSigner, weight: 1, type: 'ed25519_public_key' },
        ],
        data: { memo: 'eA==' },
      }),
      offers: { _embedded: { records: [{ id: '1' }, { id: '2' }] } },
    });

    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    const codes = result.findings.map((finding) => finding.code);
    expect(result.status).toBe('requires-cleanup');
    expect(result.sourceAccount.trustlineCount).toBe(1);
    expect(result.sourceAccount.offerCount).toBe(2);
    expect(result.sourceAccount.rawOffers).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.sourceAccount.dataEntryCount).toBe(1);
    expect(result.sourceAccount.additionalSignerCount).toBe(1);
    expect(result.sourceAccount.sponsorshipRelationships).toBe(3);
    expect(result.sourceAccount.sellingLiabilities).toBe('2');
    expect(result.sourceAccount.buyingLiabilities).toBe('1');
    expect(result.sourceAccount.estimatedTransferableBalance).toBe('98');
    expect(codes).toEqual(
      expect.arrayContaining([
        'active-offers',
        'trustlines',
        'data-entries',
        'additional-signers',
        'sponsorship-relationships',
        'outstanding-liabilities',
      ]),
    );
  });

  it('reports a missing destination separately from source cleanup', async () => {
    mockHorizon({ failDestination: 404 });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(result.status).toBe('destination-unavailable');
    expect(result.destinationAccount.exists).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('destination-unavailable');
  });

  it('does not assume readiness when the source is missing or offers cannot be read', async () => {
    mockHorizon({ failSource: 404 });
    const missingSource = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(missingSource.status).toBe('insufficient-information');
    expect(missingSource.sourceAccount.exists).toBe(false);

    mockHorizon({ failOffers: 503 });
    const partial = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(partial.status).toBe('insufficient-information');
    expect(partial.sourceAccount.offerCount).toBeNull();
    expect(partial.findings.map((finding) => finding.code)).toContain('offers-unavailable');
  });

  it('reports missing sponsorship values as insufficient information', async () => {
    mockHorizon({ source: account(sourceId, { num_sponsoring: undefined }) });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(result.status).toBe('insufficient-information');
    expect(result.findings.map((finding) => finding.code)).toContain('sponsorship-unknown');
  });

  it('optionally inspects relevant historical activity and remains JSON serializable', async () => {
    const fetchMock = mockHorizon({
      history: {
        _embedded: {
          records: [
            { id: 'op-1', type: 'begin_sponsoring_future' },
            { id: 'op-2', type: 'payment' },
            { id: 'op-3', type: 'set_options' },
          ],
        },
      },
    });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId, {
      historyDepth: 20,
    });
    expect(result.historicalInspection.inspected).toBe(true);
    expect(result.historicalInspection.records).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/operations?order=desc&limit=20')),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).status).toBe('ready');
  });

  it('formats observations separately from the derived classification and actions', async () => {
    mockHorizon({
      source: account(sourceId, { subentry_count: 1, data: { memo: 'eA==' } }),
    });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    const text = formatAccountMergeAudit(result);
    expect(text).toContain('Classification:');
    expect(text).toContain('--- Source Observations ---');
    expect(text).toContain('--- Findings and Actions ---');
    expect(text).toContain('REQUIRES-CLEANUP');
    expect(text).toContain('Remove account data entries before merging.');
    expect(JSON.stringify(result)).toContain('selling_liabilities');
  });
});

function snapshot(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    account_id: accountId,
    sequence: '100',
    subentry_count: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
        selling_liabilities: '0.0000000',
        buying_liabilities: '0.0000000',
      },
    ],
    signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
    home_domain: 'example.test',
    data: {},
    ...overrides,
  };
}

function snapshotInput(
  accountId: string,
  overrides: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return {
    label: `snapshot-${accountId.slice(0, 4)}`,
    source: 'file',
    account: snapshot(accountId, overrides),
    ledgerSequence: 1000,
    ledgerHash: 'abc123',
    lastModifiedLedger: 1000,
    retrievedAt: '2024-01-01T00:00:00.000Z',
    ...meta,
  };
}

describe('account snapshot consistency audit', () => {
  it('reports matching snapshots as consistent', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, {}, { label: 'snapshot-b' }),
    ]);
    expect(result.consistent).toBe(true);
    expect(result.ledgerContext.status).toBe('matching');
    expect(result.findings.map((finding) => finding.code)).not.toContain('field-difference');
    expect(result.readOnly).toBe(true);
  });

  it('reports differing ledger sequences and hashes as different ledger states', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, {}, { ledgerSequence: 1001, ledgerHash: 'def456' }),
    ]);
    expect(result.ledgerContext.status).toBe('differing');
    expect(result.ledgerContext.ledgerSequences).toEqual([1000, 1001]);
    expect(result.ledgerContext.ledgerHashes).toEqual(['abc123', 'def456']);
    expect(result.consistent).toBe(true);
  });

  it('reports missing ledger metadata as a limitation rather than inconsistency', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId, {}, { ledgerSequence: undefined, ledgerHash: undefined }),
      snapshotInput(sourceId, {}, { ledgerSequence: undefined, ledgerHash: undefined }),
    ]);
    expect(result.ledgerContext.status).toBe('unavailable');
    expect(result.consistent).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain('ledger-context-unavailable');
  });

  it('rejects snapshots for different accounts', () => {
    const validation = validateSnapshotAccountIds([
      snapshotInput(sourceId),
      snapshotInput(destinationId),
    ]);
    expect(validation.valid).toBe(false);
    expect(() =>
      auditAccountSnapshotConsistency([snapshotInput(sourceId), snapshotInput(destinationId)]),
    ).toThrow(/account/i);
  });

  it('rejects snapshots from incompatible networks', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId, {}, { network: 'testnet' }),
      snapshotInput(sourceId, {}, { network: 'public' }),
    ]);
    expect(result.comparable).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('network-mismatch');
  });

  it('detects changes in balances, sequence, signers and thresholds', () => {
    const customSigner = Keypair.random().publicKey();
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(
        sourceId,
        {
          sequence: '200',
          balances: [
            {
              asset_type: 'native',
              balance: '250.0000000',
              selling_liabilities: '0.0000000',
              buying_liabilities: '0.0000000',
            },
          ],
          signers: [
            { key: sourceId, weight: 1, type: 'ed25519_public_key' },
            { key: customSigner, weight: 1, type: 'ed25519_public_key' },
          ],
          thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
        },
        { ledgerSequence: 1001, ledgerHash: 'def456' },
      ),
    ]);
    const fields = result.fieldDifferences.map((diff) => diff.field);
    expect(fields).toEqual(
      expect.arrayContaining(['sequence', 'balances', 'signers', 'thresholds']),
    );
    expect(result.consistent).toBe(true);
  });

  it('detects home domain changes', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, { home_domain: 'other.test' }, { ledgerSequence: 1001 }),
    ]);
    expect(result.fieldDifferences.map((diff) => diff.field)).toContain('home_domain');
  });

  it('does not classify legitimate cross-ledger changes as corruption', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(
        sourceId,
        { sequence: '200', balances: [{ asset_type: 'native', balance: '250.0000000' }] },
        { ledgerSequence: 1001, ledgerHash: 'def456' },
      ),
    ]);
    expect(result.consistent).toBe(true);
    expect(result.findings.map((finding) => finding.code)).not.toContain('contradiction');
  });

  it('flags contradictions when snapshots claim the same ledger state but differ', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, { sequence: '200' }),
    ]);
    expect(result.consistent).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('contradiction');
  });

  it('identifies incomplete snapshots and fields that cannot be compared', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, { thresholds: undefined, home_domain: undefined }),
    ]);
    expect(result.findings.map((finding) => finding.code)).toContain('incomplete-snapshot');
    expect(result.incomparableFields).toEqual(
      expect.arrayContaining(['thresholds', 'home_domain']),
    );
  });

  it('handles incompatible field representations without crashing', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, { balances: 'not-an-array' }),
    ]);
    expect(result.findings.map((finding) => finding.code)).toContain('incompatible-field');
    expect(result.consistent).toBe(false);
  });

  it('does not treat differing retrieval timestamps as inconsistency', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId, {}, { retrievedAt: '2024-01-01T00:00:00.000Z' }),
      snapshotInput(sourceId, {}, { retrievedAt: '2024-06-01T00:00:00.000Z' }),
    ]);
    expect(result.consistent).toBe(true);
    expect(result.findings.map((finding) => finding.code)).not.toContain('timestamp-mismatch');
  });

  it('produces readable terminal output and JSON serialization', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId, { sequence: '200' }, { ledgerSequence: 1001 }),
    ]);
    const text = formatAccountSnapshotConsistencyAudit(result);
    expect(text).toContain('Ledger Context:');
    expect(text).toContain('--- Field Differences ---');
    expect(text).toContain('--- Findings ---');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.snapshots).toHaveLength(2);
    expect(json.ledgerContext).toBeDefined();
    expect(json.fieldDifferences).toBeDefined();
    expect(json.consistent).toBeDefined();
  });

  it('does not claim cryptographic proof of authenticity', () => {
    const result = auditAccountSnapshotConsistency([
      snapshotInput(sourceId),
      snapshotInput(sourceId),
    ]);
    expect(result.authenticityVerified).toBe(false);
    expect(result.findings.map((finding) => finding.code)).not.toContain('authenticity-verified');
  });

  it('regression: existing account inspection remains backward compatible', async () => {
    mockHorizon();
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(result.status).toBe('ready');
    expect(result.sourceAccount.readable).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
