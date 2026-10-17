import {
  analyzeTransaction,
  validateTransactionHash,
  buildAssetMovements,
  fetchTransactionDetails,
  fetchTransactionOperations,
} from '../src/services/transaction-analyzer';
import type { AnalyzedOperation } from '../src/services/transaction-analyzer';
import * as horizonClient from '../src/services/horizon-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_HASH = 'a'.repeat(64);

const mockTransactionResponse = {
  hash: 'a'.repeat(64),
  source_account: 'GSOURCEACCOUNT123456789012345678901234567890123456',
  ledger: 500000,
  successful: true,
  fee_charged: '100',
  max_fee: '150',
  memo_type: 'text',
  memo: 'Test memo',
  operation_count: 2,
  created_at: '2026-01-15T12:00:00Z',
};

// ---------------------------------------------------------------------------
// validateTransactionHash
// ---------------------------------------------------------------------------

describe('validateTransactionHash', () => {
  it('accepts a valid 64-char hex hash', () => {
    expect(validateTransactionHash('a'.repeat(64)).valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const r = validateTransactionHash('');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('rejects a hash that is too short', () => {
    expect(validateTransactionHash('abc123').valid).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(validateTransactionHash('z'.repeat(64)).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAssetMovements
// ---------------------------------------------------------------------------

describe('buildAssetMovements', () => {
  it('identifies payment movements', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'payment',
        description: 'GSOURCE sent 100 XLM to GDEST',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('payment');
  });

  it('identifies account funding', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'create_account',
        description: 'GSOURCE funded new account GNEW with 2 XLM',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('account_funded');
  });

  it('identifies trustline creation', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'change_trust',
        description: 'GTRUSTOR created trustline for USDC:GBTRUSTEE with limit 10000',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('trustline_created');
  });

  it('identifies asset exchange', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'manage_sell_offer',
        description: 'GSOURCE 100 XLM for USDC at price 0.5 (offer 12345)',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('asset_exchanged');
  });

  it('identifies account merge', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'account_merge',
        description: 'GSOURCE merged into account GINTODEST',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('account_merged');
  });

  it('returns empty movements for unsupported operations without falling back', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'unknown_op',
        description: 'Unsupported operation type: unknown_op',
        details: {},
        supported: false,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('general');
  });

  it('includes a general movement when there are no specific movements', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'set_options',
        description: 'GSOURCE updated account settings -- home domain: example.com',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// analyzeTransaction — integration (mocked Horizon)
// ---------------------------------------------------------------------------

describe('analyzeTransaction', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('throws on invalid transaction hash', async () => {
    await expect(
      analyzeTransaction({ horizonUrl: 'https://horizon.example', hash: 'bad' }),
    ).rejects.toThrow(/hexadecimal/i);
  });

  it('returns transaction metadata and analyzed operations', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.transaction).toBeDefined();
    expect(analysis.transaction.hash).toBe(VALID_HASH);
    expect(analysis.transaction.sourceAccount).toBe(
      'GSOURCEACCOUNT123456789012345678901234567890123456',
    );
    expect(analysis.transaction.successful).toBe(true);
    expect(analysis.transaction.feeCharged).toBe('100');
    expect(analysis.transaction.memoType).toBe('text');
    expect(analysis.transaction.memoValue).toBe('Test memo');
    expect(analysis.transaction.operationCount).toBe(2);

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('payment');
    expect(analysis.operations[0].description).toContain('sent 100.0000000 XLM to GDEST');
    expect(analysis.operations[0].supported).toBe(true);

    expect(analysis.assetSummary.movements).toBeDefined();
  });

  it('handles path payment operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'path_payment_strict_receive',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISS',
        amount: '50.0000000',
        source_amount: '55.0000000',
        source_asset_type: 'native',
        source_max: '60.0000000',
        path: [],
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('path_payment_strict_receive');
    expect(analysis.operations[0].description).toContain('USDC');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles create account operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'create_account',
        created_at: '2026-01-15T12:00:00Z',
        funder: 'GSOURCE',
        account: 'GNEWACC',
        starting_balance: '3.0000000',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('create_account');
    expect(analysis.operations[0].description).toContain('account');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles change trust operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GTRUSTOR',
        type: 'change_trust',
        created_at: '2026-01-15T12:00:00Z',
        trustor: 'GTRUSTOR',
        trustee: 'GTRUSTEE',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GUSDCISS',
        limit: '999999.9999999',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('change_trust');
    expect(analysis.operations[0].description).toContain('USDC');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles manage sell offer operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'manage_sell_offer',
        created_at: '2026-01-15T12:00:00Z',
        amount: '50.0000000',
        price: '0.5000000',
        offer_id: '98765',
        selling_asset_type: 'native',
        buying_asset_type: 'credit_alphanum4',
        buying_asset_code: 'USDC',
        buying_asset_issuer: 'GUSDCISS',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('manage_sell_offer');
    expect(analysis.operations[0].description).toContain('for');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles manage buy offer operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'manage_buy_offer',
        created_at: '2026-01-15T12:00:00Z',
        amount: '100.0000000',
        price: '0.7500000',
        offer_id: '11111',
        selling_asset_type: 'credit_alphanum4',
        selling_asset_code: 'USDC',
        selling_asset_issuer: 'GUSDCISS',
        buying_asset_type: 'native',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('manage_buy_offer');
    expect(analysis.operations[0].description).toContain('wants to buy');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles unsupported operations gracefully', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 2 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
      {
        id: '2',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'some_unknown_type',
        created_at: '2026-01-15T12:00:00Z',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(2);
    expect(analysis.operations[0].supported).toBe(true);
    expect(analysis.operations[1].supported).toBe(false);
    expect(analysis.operations[1].description).toContain('Unsupported');
  });

  it('supports structured JSON output', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    const json = JSON.stringify({ ok: true, data: analysis });
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.transaction).toBeDefined();
    expect(parsed.data.operations).toBeDefined();
    expect(parsed.data.assetSummary).toBeDefined();
  });

  it('propagates Horizon errors for invalid transaction hashes', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));

    await expect(
      analyzeTransaction({
        horizonUrl: 'https://horizon.example',
        hash: VALID_HASH,
      }),
    ).rejects.toThrow('HTTP 404');
  });
});

// ---------------------------------------------------------------------------
// fetchTransactionDetails and fetchTransactionOperations — direct tests
// ---------------------------------------------------------------------------

describe('fetchTransactionDetails', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches transaction details from Horizon', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);

    const details = await fetchTransactionDetails({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(details.hash).toBe(VALID_HASH);
    expect(details.sourceAccount).toBe('GSOURCEACCOUNT123456789012345678901234567890123456');
    expect(details.ledger).toBe(500000);
    expect(details.successful).toBe(true);
    expect(details.feeCharged).toBe('100');
    expect(details.memoType).toBe('text');
    expect(details.memoValue).toBe('Test memo');
    expect(details.operationCount).toBe(2);
  });

  it('handles transaction with no memo', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue({
      ...mockTransactionResponse,
      memo: undefined,
      memo_type: 'none',
    });

    const details = await fetchTransactionDetails({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(details.memoType).toBe('none');
    expect(details.memoValue).toBe('');
  });
});

describe('fetchTransactionOperations', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches operations for a transaction', async () => {
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
    ]);

    const ops = await fetchTransactionOperations({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('payment');
  });

  it('returns empty array for a transaction with no operations', async () => {
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const ops = await fetchTransactionOperations({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(ops).toEqual([]);
  });

  it('propagates Horizon errors', async () => {
    jest
      .spyOn(horizonClient, 'fetchOperationsForTransaction')
      .mockRejectedValue(new Error('HTTP 500'));

    await expect(
      fetchTransactionOperations({
        horizonUrl: 'https://horizon.example',
        hash: VALID_HASH,
      }),
    ).rejects.toThrow('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// Payment reference audit (ISSUE-096)
// ---------------------------------------------------------------------------

import {
  auditPaymentReference,
  validateReferenceFormat,
  matchReferenceToRecords,
  compareAmounts,
  matchAssetIdentity,
} from '../src/services/payment-reference-audit';
import type {
  PaymentReferenceAuditResult,
  ReferenceRecord,
} from '../src/services/payment-reference-audit';

const HASH_REF = 'b'.repeat(64);

function makeRecord(overrides: Partial<ReferenceRecord> = {}): ReferenceRecord {
  return {
    transactionHash: HASH_REF,
    ledger: 500000,
    createdAt: '2026-01-15T12:00:00Z',
    successful: true,
    memoType: 'none',
    memoValue: '',
    sourceAccount: 'GSOURCE',
    destination: 'GDEST',
    assetCode: 'XLM',
    assetIssuer: null,
    amount: '100.0000000',
    ...overrides,
  };
}

describe('validateReferenceFormat', () => {
  it('classifies a valid 64-char hex hash as a transaction hash', () => {
    const r = validateReferenceFormat(HASH_REF);
    expect(r.valid).toBe(true);
    expect(r.referenceType).toBe('transaction_hash');
  });

  it('rejects a malformed transaction hash', () => {
    const r = validateReferenceFormat('not-a-hash');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('treats a non-hash string as an application reference', () => {
    const r = validateReferenceFormat('ORDER-12345');
    expect(r.valid).toBe(true);
    expect(r.referenceType).toBe('application_reference');
  });

  it('rejects an empty reference', () => {
    const r = validateReferenceFormat('');
    expect(r.valid).toBe(false);
  });
});

describe('compareAmounts', () => {
  it('matches exact amounts preserving precision', () => {
    expect(compareAmounts('100.0000000', '100.0000000')).toBe(true);
  });

  it('does not match differing precision values', () => {
    expect(compareAmounts('100.0000000', '100.0000001')).toBe(false);
  });

  it('does not match different magnitudes', () => {
    expect(compareAmounts('100.0000000', '1000.0000000')).toBe(false);
  });
});

describe('matchAssetIdentity', () => {
  it('matches native assets', () => {
    expect(matchAssetIdentity({ code: 'XLM', issuer: null }, { code: 'XLM', issuer: null })).toBe(
      true,
    );
  });

  it('matches issued assets by code and issuer', () => {
    expect(
      matchAssetIdentity(
        { code: 'USDC', issuer: 'GISSUER_A' },
        { code: 'USDC', issuer: 'GISSUER_A' },
      ),
    ).toBe(true);
  });

  it('does not match same code with different issuers', () => {
    expect(
      matchAssetIdentity(
        { code: 'USDC', issuer: 'GISSUER_A' },
        { code: 'USDC', issuer: 'GISSUER_B' },
      ),
    ).toBe(false);
  });
});

describe('matchReferenceToRecords', () => {
  it('returns a unique transaction-hash match', () => {
    const records = [makeRecord({ transactionHash: HASH_REF })];
    const result = matchReferenceToRecords(HASH_REF, 'transaction_hash', records, {});
    expect(result.matches).toHaveLength(1);
    expect(result.ambiguous).toBe(false);
    expect(result.matchKind).toBe('transaction_hash');
  });

  it('reports ambiguity for memo-based references with multiple candidates', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
    ];
    const result = matchReferenceToRecords('ORDER-1', 'application_reference', records, {});
    expect(result.matches).toHaveLength(2);
    expect(result.ambiguous).toBe(true);
    expect(result.matchKind).toBe('memo');
  });

  it('does not confuse text, numeric, and hash memos', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: '12345' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'id', memoValue: '12345' }),
      makeRecord({ transactionHash: 'e'.repeat(64), memoType: 'hash', memoValue: '12345' }),
    ];
    const result = matchReferenceToRecords('12345', 'application_reference', records, {
      memoType: 'id',
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].memoType).toBe('id');
  });

  it('narrows candidates by expected destination', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', destination: 'GDEST_A' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', destination: 'GDEST_B' }),
    ];
    const result = matchReferenceToRecords('ORDER-1', 'application_reference', records, {
      destination: 'GDEST_B',
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].destination).toBe('GDEST_B');
  });

  it('narrows candidates by expected asset using code and issuer', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', assetCode: 'USDC', assetIssuer: 'GISSUER_A' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', assetCode: 'USDC', assetIssuer: 'GISSUER_B' }),
    ];
    const result = matchReferenceToRecords('ORDER-1', 'application_reference', records, {
      asset: { code: 'USDC', issuer: 'GISSUER_B' },
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].assetIssuer).toBe('GISSUER_B');
  });

  it('narrows candidates by expected amount with exact precision', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', amount: '100.0000000' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', amount: '100.0000001' }),
    ];
    const result = matchReferenceToRecords('ORDER-1', 'application_reference', records, {
      amount: '100.0000000',
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].amount).toBe('100.0000000');
  });

  it('narrows candidates by time window', () => {
    const records = [
      makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', createdAt: '2026-01-01T00:00:00Z' }),
      makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1', createdAt: '2026-02-01T00:00:00Z' }),
    ];
    const result = matchReferenceToRecords('ORDER-1', 'application_reference', records, {
      since: '2026-01-15T00:00:00Z',
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].createdAt).toBe('2026-02-01T00:00:00Z');
  });

  it('returns no matches for missing records', () => {
    const result = matchReferenceToRecords('ORDER-999', 'application_reference', [], {});
    expect(result.matches).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });
});

describe('auditPaymentReference', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a malformed transaction hash', async () => {
    await expect(
      auditPaymentReference({ horizonUrl: 'https://horizon.example', reference: 'bad' }),
    ).rejects.toThrow(/hexadecimal/i);
  });

  it('reports a unique transaction-hash match', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, hash: HASH_REF });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: HASH_REF,
    });

    expect(result.referenceType).toBe('transaction_hash');
    expect(result.ambiguous).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].transactionHash).toBe(HASH_REF);
  });

  it('reports ambiguity for memo-based references', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));
    jest
      .spyOn(horizonClient, 'searchTransactionsByMemo')
      .mockResolvedValue([
        makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
        makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
      ]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: 'ORDER-1',
    });

    expect(result.referenceType).toBe('application_reference');
    expect(result.ambiguous).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.confirmedPayment).toBe(false);
  });

  it('does not treat an ambiguous reference as a confirmed payment', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));
    jest
      .spyOn(horizonClient, 'searchTransactionsByMemo')
      .mockResolvedValue([
        makeRecord({ transactionHash: 'c'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
        makeRecord({ transactionHash: 'd'.repeat(64), memoType: 'text', memoValue: 'ORDER-1' }),
      ]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: 'ORDER-1',
    });

    expect(result.confirmedPayment).toBe(false);
  });

  it('reports incomplete search coverage on pagination failure', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));
    jest
      .spyOn(horizonClient, 'searchTransactionsByMemo')
      .mockRejectedValue(new Error('HTTP 500'));

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: 'ORDER-1',
    });

    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
  });

  it('reports missing records without claiming the transaction does not exist', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));
    jest.spyOn(horizonClient, 'searchTransactionsByMemo').mockResolvedValue([]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: 'ORDER-404',
    });

    expect(result.matches).toHaveLength(0);
    expect(result.confirmedPayment).toBe(false);
  });

  it('produces machine-readable JSON output', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, hash: HASH_REF });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: HASH_REF,
    });

    const json = JSON.stringify({ ok: true, data: result });
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.data.referenceType).toBe('transaction_hash');
    expect(parsed.data.matches).toBeDefined();
    expect(parsed.data.ambiguous).toBeDefined();
    expect(parsed.data.limitations).toBeDefined();
  });

  it('produces readable terminal output', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, hash: HASH_REF });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const result = await auditPaymentReference({
      horizonUrl: 'https://horizon.example',
      reference: HASH_REF,
    });

    const text = formatPaymentReferenceAudit(result);
    expect(typeof text).toBe('string');
    expect(text).toContain(HASH_REF);
  });
});

// ---------------------------------------------------------------------------
// Memo privacy audit (ISSUE-095)
// ---------------------------------------------------------------------------

import {
  auditMemoPrivacy,
  decodeMemoForAudit,
  applyPrivacyRules,
  redactMemo,
} from '../src/services/memo-privacy-audit';
import type { MemoPrivacyAuditResult } from '../src/services/memo-privacy-audit';

describe('decodeMemoForAudit', () => {
  it('decodes a text memo', () => {
    const r = decodeMemoForAudit({ type: 'text', value: 'hello' });
    expect(r.type).toBe('text');
    expect(r.value).toBe('hello');
  });

  it('decodes an id memo', () => {
    const r = decodeMemoForAudit({ type: 'id', value: '12345' });
    expect(r.type).toBe('id');
    expect(r.value).toBe('12345');
  });

  it('decodes a hash memo', () => {
    const r = decodeMemoForAudit({ type: 'hash', value: 'a'.repeat(64) });
    expect(r.type).toBe('hash');
  });

  it('decodes a return-hash memo', () => {
    const r = decodeMemoForAudit({ type: 'return', value: 'b'.repeat(64) });
    expect(r.type).toBe('return');
  });

  it('decodes an empty memo', () => {
    const r = decodeMemoForAudit({ type: 'none', value: '' });
    expect(r.type).toBe('none');
    expect(r.value).toBe('');
  });
});

describe('applyPrivacyRules', () => {
  it('detects configured email patterns', () => {
    const findings = applyPrivacyRules('contact me at user@example.com', {});
    expect(findings.some((f) => f.rule === 'email')).toBe(true);
  });

  it('detects configured phone-number patterns', () => {
    const findings = applyPrivacyRules('call +1-555-123-4567', {});
    expect(findings.some((f) => f.rule === 'phone')).toBe(true);
  });

  it('detects credential-like strings', () => {
    const findings = applyPrivacyRules('api_key=SECRET1234567890', {});
    expect(findings.some((f) => f.rule === 'credential')).toBe(true);
  });

  it('supports custom rules', () => {
    const findings = applyPrivacyRules('ACCT-9999', {
      customRules: [{ name: 'account-id', pattern: /ACCT-\d+/ }],
    });
    expect(findings.some((f) => f.rule === 'account-id')).toBe(true);
  });

  it('flags unusually long text', () => {
    const findings = applyPrivacyRules('x'.repeat(200), { maxTextLength: 64 });
    expect(findings.some((f) => f.rule === 'long_text')).toBe(true);
  });

  it('does not flag non-matching text', () => {
    const findings = applyPrivacyRules('order shipped', {});
    expect(findings).toHaveLength(0);
  });
});

describe('redactMemo', () => {
  it('redacts text memo content by default', () => {
    const redacted = redactMemo({ type: 'text', value: 'user@example.com' });
    expect(redacted).not.toContain('user@example.com');
  });

  it('retains diagnostic metadata', () => {
    const redacted = redactMemo({ type: 'text', value: 'user@example.com' });
    expect(redacted).toContain('text');
  });
});

describe('auditMemoPrivacy', () => {
  it('does not apply text-pattern checks to hash memos', () => {
    const result = auditMemoPrivacy({ type: 'hash', value: 'a'.repeat(64) });
    expect(result.findings).toHaveLength(0);
    expect(result.memoType).toBe('hash');
  });

  it('does not apply text-pattern checks to return-hash memos', () => {
    const result = auditMemoPrivacy({ type: 'return', value: 'b'.repeat(64) });
    expect(result.findings).toHaveLength(0);
    expect(result.memoType).toBe('return');
  });

  it('does not apply text-pattern checks to id memos', () => {
    const result = auditMemoPrivacy({ type: 'id', value: '12345' });
    expect(result.findings).toHaveLength(0);
    expect(result.memoType).toBe('id');
  });

  it('redacts memo content in default JSON output', () => {
    const result = auditMemoPrivacy({ type: 'text', value: 'user@example.com' });
    const json = JSON.stringify({ ok: true, data: result });
    expect(json).not.toContain('user@example.com');
  });

  it('exposes memo content when explicitly requested', () => {
    const result = auditMemoPrivacy(
      { type: 'text', value: 'user@example.com' },
      { revealMemo: true },
    );
    expect(result.memoValue).toBe('user@example.com');
  });

  it('reports memo type and byte length', () => {
    const result = auditMemoPrivacy({ type: 'text', value: 'hello' });
    expect(result.memoType).toBe('text');
    expect(result.byteLength).toBe(5);
  });

  it('warns that pattern matches require review rather than being proof', () => {
    const result = auditMemoPrivacy({ type: 'text', value: 'user@example.com' });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].severity).toBe('warning');
  });

  it('produces readable terminal output', () => {
    const result = auditMemoPrivacy({ type: 'text', value: 'user@example.com' });
    const text = formatMemoPrivacyAudit(result);
    expect(typeof text).toBe('string');
    expect(text).toContain('text');
  });
});

// ---------------------------------------------------------------------------
// Regression: existing transaction lookup and memo inspection
// ---------------------------------------------------------------------------

describe('regression: existing transaction lookup and memo inspection', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('still validates transaction hashes', () => {
    expect(validateTransactionHash(VALID_HASH).valid).toBe(true);
    expect(validateTransactionHash('bad').valid).toBe(false);
  });

  it('still fetches transaction details with memo metadata', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);

    const details = await fetchTransactionDetails({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(details.memoType).toBe('text');
    expect(details.memoValue).toBe('Test memo');
  });

  it('still analyzes transactions end to end', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.transaction.hash).toBe(VALID_HASH);
    expect(analysis.operations).toEqual([]);
  });
});
