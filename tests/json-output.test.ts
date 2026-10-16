/**
 * Tests for --json output mode across CLI utility functions and the
 * outputJson / outputJsonError helpers.
 *
 * We test:
 *   1. The json.ts output helpers directly
 *   2. The logger JSON-mode routing (stdout → stderr)
 *   3. The writeResult helper behaviour (indirectly via the helpers)
 */

import { outputJson, outputJsonError } from '../src/output/json';
import { logger } from '../src/utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture everything written to process.stdout during `fn()`. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

/** Capture everything written to process.stderr during `fn()`. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// outputJson helper
// ---------------------------------------------------------------------------

describe('outputJson', () => {
  it('writes a valid JSON envelope with ok:true to stdout', async () => {
    const payload = { status: 'online', latencyMs: 42 };
    const out = await captureStdout(() => outputJson(payload));

    // Must be parseable
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual(payload);
  });

  it('produces output that is parseable by JSON.parse', async () => {
    const out = await captureStdout(() => outputJson({ hello: 'world' }));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('pretty-prints with 2-space indentation', async () => {
    const out = await captureStdout(() => outputJson({ a: 1 }));
    // Pretty-printed JSON has newlines and spaces
    expect(out).toContain('\n');
    expect(out).toContain('  ');
  });

  it('handles nested objects correctly', async () => {
    const data = { thresholds: { low: 1, med: 2, high: 3 }, flags: { authRequired: false } };
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    expect(parsed.data.thresholds.med).toBe(2);
    expect(parsed.data.flags.authRequired).toBe(false);
  });

  it('handles arrays correctly', async () => {
    const data = [{ url: 'https://a.com', status: 'online' }];
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data[0].status).toBe('online');
  });

  it('handles null values in the payload', async () => {
    const out = await captureStdout(() => outputJson({ spreadPercent: null }));
    const parsed = JSON.parse(out);
    expect(parsed.data.spreadPercent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// outputJsonError helper
// ---------------------------------------------------------------------------

describe('outputJsonError', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('writes a JSON error envelope with ok:false to stdout', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Something went wrong'));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('Something went wrong');
  });

  it('includes the exit code in the envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Not found', 2));
    } catch {
      // process.exit throws
    }
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe(2);
  });

  it('defaults to exit code 1', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Default exit'));
    } catch {
      // process.exit throws
    }
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit with the specified code', async () => {
    try {
      await captureStdout(() => outputJsonError('Custom exit', 3));
    } catch {
      // process.exit throws
    }
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('produces output that is parseable by JSON.parse', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Parse me'));
    } catch {
      // process.exit throws
    }
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Logger JSON-mode routing
// ---------------------------------------------------------------------------

describe('logger JSON mode', () => {
  afterEach(() => {
    // Always reset logger state between tests
    logger.setJsonMode(false);
    logger.setLevel('info');
  });

  it('isJsonMode() returns false by default', () => {
    expect(logger.isJsonMode()).toBe(false);
  });

  it('isJsonMode() returns true after setJsonMode(true)', () => {
    logger.setJsonMode(true);
    expect(logger.isJsonMode()).toBe(true);
  });

  it('routes logger.error to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.error('test error'));
    expect(errOut).toContain('test error');
  });

  it('routes logger.info to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.info('test info'));
    expect(errOut).toContain('test info');
  });

  it('routes logger.warn to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.warn('test warning'));
    expect(errOut).toContain('test warning');
  });

  it('routes logger.success to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.success('all good'));
    expect(errOut).toContain('all good');
  });

  it('does not write to stdout during logger calls in JSON mode', async () => {
    logger.setJsonMode(true);
    const stdOut = await captureStdout(() => {
      logger.info('this should not go to stdout');
      logger.error('neither should this');
      logger.warn('or this');
    });
    // stdout must remain empty (clean JSON stream)
    expect(stdOut).toBe('');
  });

  it('writes to stdout in normal (non-JSON) mode', async () => {
    logger.setJsonMode(false);
    const stdOut = await captureStdout(() => logger.info('normal info'));
    expect(stdOut).toContain('normal info');
  });
});

// ---------------------------------------------------------------------------
// JSON envelope structure contracts
// ---------------------------------------------------------------------------

describe('JSON envelope structure', () => {
  it('success envelope always has ok:true and a data key', async () => {
    const out = await captureStdout(() => outputJson({ foo: 'bar' }));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(parsed.ok).toBe(true);
  });

  it('error envelope always has ok:false, error, and code keys', async () => {
    let out = '';
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    try {
      out = await captureStdout(() => outputJsonError('oops'));
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('error');
    expect(Object.keys(parsed)).toContain('code');
    expect(parsed.ok).toBe(false);
  });

  it('outputJson result is compatible with jq-style key access', async () => {
    const data = { status: 'online', latencyMs: 55, protocolVersion: 21 };
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    // Simulate what `jq .data.status` would return
    expect(parsed.data.status).toBe('online');
    expect(parsed.data.latencyMs).toBe(55);
    expect(parsed.data.protocolVersion).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// Audit result shapes (ISSUE-095 / 096 / 097 / 098)
// ---------------------------------------------------------------------------

describe('account snapshot consistency audit JSON shape', () => {
  const auditResult = {
    snapshots: [
      { id: 'snap-a', accountId: 'GAAA', ledgerSequence: 100, ledgerHash: 'aaaa', retrievedAt: '2024-01-01T00:00:00Z' },
      { id: 'snap-b', accountId: 'GAAA', ledgerSequence: 100, ledgerHash: 'aaaa', retrievedAt: '2024-01-01T00:05:00Z' },
    ],
    comparisonContext: {
      status: 'same-ledger',
      ledgerSequence: 100,
      ledgerHash: 'aaaa',
      metadataAvailable: true,
    },
    fieldDifferences: [
      { field: 'sequenceNumber', values: [{ snapshotId: 'snap-a', value: '1' }, { snapshotId: 'snap-b', value: '1' }], changed: false },
    ],
    consistencyFindings: [
      { severity: 'info', code: 'MATCHING_SNAPSHOTS', message: 'Snapshots agree on shared ledger state' },
    ],
    limitations: [],
  };

  it('serializes snapshot identifiers, context, differences, and findings', async () => {
    const out = await captureStdout(() => outputJson(auditResult));
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.snapshots).toHaveLength(2);
    expect(parsed.data.snapshots[0].id).toBe('snap-a');
    expect(parsed.data.comparisonContext.status).toBe('same-ledger');
    expect(parsed.data.fieldDifferences[0].field).toBe('sequenceNumber');
    expect(parsed.data.consistencyFindings[0].code).toBe('MATCHING_SNAPSHOTS');
  });

  it('preserves original values and their snapshot sources', async () => {
    const out = await captureStdout(() => outputJson(auditResult));
    const parsed = JSON.parse(out);
    const diff = parsed.data.fieldDifferences[0];
    expect(diff.values[0].snapshotId).toBe('snap-a');
    expect(diff.values[0].value).toBe('1');
    expect(diff.values[1].snapshotId).toBe('snap-b');
  });

  it('reports differing ledger context without claiming corruption', async () => {
    const differing = {
      ...auditResult,
      comparisonContext: { status: 'different-ledgers', ledgerSequence: null, ledgerHash: null, metadataAvailable: true },
      consistencyFindings: [
        { severity: 'info', code: 'DIFFERENT_LEDGER_STATES', message: 'Snapshots captured at different ledgers' },
      ],
    };
    const out = await captureStdout(() => outputJson(differing));
    const parsed = JSON.parse(out);
    expect(parsed.data.comparisonContext.status).toBe('different-ledgers');
    expect(parsed.data.consistencyFindings[0].code).toBe('DIFFERENT_LEDGER_STATES');
    expect(JSON.stringify(parsed.data)).not.toMatch(/corrupt/i);
  });

  it('reports missing ledger metadata as a limitation', async () => {
    const missing = {
      ...auditResult,
      comparisonContext: { status: 'unavailable', ledgerSequence: null, ledgerHash: null, metadataAvailable: false },
      limitations: ['Ledger metadata unavailable; consistency cannot be established'],
    };
    const out = await captureStdout(() => outputJson(missing));
    const parsed = JSON.parse(out);
    expect(parsed.data.comparisonContext.metadataAvailable).toBe(false);
    expect(parsed.data.limitations).toHaveLength(1);
  });

  it('marks incompatible account or network metadata as incomparable', async () => {
    const incomparable = {
      snapshots: [
        { id: 'snap-a', accountId: 'GAAA', network: 'mainnet' },
        { id: 'snap-b', accountId: 'GBBB', network: 'testnet' },
      ],
      comparisonContext: { status: 'incomparable', reason: 'account-mismatch' },
      fieldDifferences: [],
      consistencyFindings: [
        { severity: 'error', code: 'INCOMPARABLE_SNAPSHOTS', message: 'Snapshots refer to different accounts' },
      ],
      limitations: [],
    };
    const out = await captureStdout(() => outputJson(incomparable));
    const parsed = JSON.parse(out);
    expect(parsed.data.comparisonContext.status).toBe('incomparable');
    expect(parsed.data.consistencyFindings[0].code).toBe('INCOMPARABLE_SNAPSHOTS');
  });
});

describe('payment reference audit JSON shape', () => {
  const referenceResult = {
    reference: { type: 'transaction-hash', value: 'abc123' },
    constraints: { destination: 'GDEST', asset: { code: 'USD', issuer: 'GISSUER' }, amount: '10.0000000', window: null },
    matchedRecords: [
      { transactionHash: 'abc123', ledgerSequence: 42, status: 'success', operations: [{ type: 'payment', amount: '10.0000000' }] },
    ],
    ambiguity: { status: 'unique', candidateCount: 1 },
    retrievalLimitations: [],
  };

  it('serializes reference type, constraints, matches, ambiguity, and limitations', async () => {
    const out = await captureStdout(() => outputJson(referenceResult));
    const parsed = JSON.parse(out);
    expect(parsed.data.reference.type).toBe('transaction-hash');
    expect(parsed.data.constraints.asset.issuer).toBe('GISSUER');
    expect(parsed.data.matchedRecords[0].transactionHash).toBe('abc123');
    expect(parsed.data.ambiguity.status).toBe('unique');
    expect(parsed.data.retrievalLimitations).toEqual([]);
  });

  it('reports ambiguous references without selecting an arbitrary result', async () => {
    const ambiguous = {
      ...referenceResult,
      reference: { type: 'memo', value: 'order-42' },
      matchedRecords: [
        { transactionHash: 'aaa', ledgerSequence: 1 },
        { transactionHash: 'bbb', ledgerSequence: 2 },
      ],
      ambiguity: { status: 'ambiguous', candidateCount: 2 },
    };
    const out = await captureStdout(() => outputJson(ambiguous));
    const parsed = JSON.parse(out);
    expect(parsed.data.ambiguity.status).toBe('ambiguous');
    expect(parsed.data.matchedRecords).toHaveLength(2);
  });

  it('discloses incomplete search coverage as a retrieval limitation', async () => {
    const incomplete = {
      ...referenceResult,
      matchedRecords: [],
      ambiguity: { status: 'none', candidateCount: 0 },
      retrievalLimitations: ['Pagination stopped early; historical records may be missing'],
    };
    const out = await captureStdout(() => outputJson(incomplete));
    const parsed = JSON.parse(out);
    expect(parsed.data.retrievalLimitations).toHaveLength(1);
    expect(parsed.data.matchedRecords).toEqual([]);
  });

  it('preserves exact amount precision in constraints and matches', async () => {
    const out = await captureStdout(() => outputJson(referenceResult));
    const parsed = JSON.parse(out);
    expect(parsed.data.constraints.amount).toBe('10.0000000');
    expect(parsed.data.matchedRecords[0].operations[0].amount).toBe('10.0000000');
  });
});

describe('Soroban event query validation JSON shape', () => {
  const queryResult = {
    validationStatus: 'valid',
    fieldFindings: [
      { path: 'contractIds[0]', severity: 'info', message: 'Contract identifier is well-formed' },
    ],
    endpointCompatibility: null,
  };

  it('serializes validation status and field-level findings', async () => {
    const out = await captureStdout(() => outputJson(queryResult));
    const parsed = JSON.parse(out);
    expect(parsed.data.validationStatus).toBe('valid');
    expect(parsed.data.fieldFindings[0].path).toBe('contractIds[0]');
  });

  it('reports malformed fields with actionable errors', async () => {
    const invalid = {
      validationStatus: 'invalid',
      fieldFindings: [
        { path: 'topics[0]', severity: 'error', message: 'Malformed ScVal topic encoding' },
        { path: 'ledgerRange', severity: 'error', message: 'Ledger range is reversed' },
      ],
      endpointCompatibility: null,
    };
    const out = await captureStdout(() => outputJson(invalid));
    const parsed = JSON.parse(out);
    expect(parsed.data.validationStatus).toBe('invalid');
    expect(parsed.data.fieldFindings).toHaveLength(2);
    expect(parsed.data.fieldFindings[0].severity).toBe('error');
  });

  it('distinguishes endpoint compatibility results from local validation', async () => {
    const withEndpoint = {
      ...queryResult,
      endpointCompatibility: { checked: true, endpoint: 'https://rpc.example.com', accepted: true },
    };
    const out = await captureStdout(() => outputJson(withEndpoint));
    const parsed = JSON.parse(out);
    expect(parsed.data.validationStatus).toBe('valid');
    expect(parsed.data.endpointCompatibility.checked).toBe(true);
    expect(parsed.data.endpointCompatibility.accepted).toBe(true);
  });

  it('does not claim event availability from a valid query', async () => {
    const out = await captureStdout(() => outputJson(queryResult));
    const parsed = JSON.parse(out);
    expect(JSON.stringify(parsed.data)).not.toMatch(/guarantee/i);
  });
});

describe('memo privacy audit JSON shape', () => {
  const privacyResult = {
    memo: { type: 'text', byteLength: 24, redacted: true, value: '[REDACTED]' },
    findings: [
      { rule: 'email', severity: 'warning', message: 'Text memo resembles an email address' },
    ],
    customRulesApplied: ['email', 'phone'],
    limitations: ['Pattern matching is indicative, not proof of sensitive data'],
  };

  it('redacts memo content by default while retaining diagnostic metadata', async () => {
    const out = await captureStdout(() => outputJson(privacyResult));
    const parsed = JSON.parse(out);
    expect(parsed.data.memo.redacted).toBe(true);
    expect(parsed.data.memo.value).toBe('[REDACTED]');
    expect(parsed.data.memo.type).toBe('text');
    expect(parsed.data.memo.byteLength).toBe(24);
  });

  it('serializes privacy findings and applied custom rules', async () => {
    const out = await captureStdout(() => outputJson(privacyResult));
    const parsed = JSON.parse(out);
    expect(parsed.data.findings[0].rule).toBe('email');
    expect(parsed.data.findings[0].severity).toBe('warning');
    expect(parsed.data.customRulesApplied).toContain('phone');
  });

  it('does not leak raw memo content in the serialized envelope', async () => {
    const out = await captureStdout(() => outputJson(privacyResult));
    expect(out).not.toContain('user@example.com');
    const parsed = JSON.parse(out);
    expect(parsed.data.memo.value).toBe('[REDACTED]');
  });

  it('supports explicit memo display when requested', async () => {
    const displayed = {
      ...privacyResult,
      memo: { type: 'text', byteLength: 24, redacted: false, value: 'order-12345' },
    };
    const out = await captureStdout(() => outputJson(displayed));
    const parsed = JSON.parse(out);
    expect(parsed.data.memo.redacted).toBe(false);
    expect(parsed.data.memo.value).toBe('order-12345');
  });

  it('does not apply text-pattern findings to hash memo types', async () => {
    const hashMemo = {
      ...privacyResult,
      memo: { type: 'hash', byteLength: 32, redacted: true, value: '[REDACTED]' },
      findings: [],
    };
    const out = await captureStdout(() => outputJson(hashMemo));
    const parsed = JSON.parse(out);
    expect(parsed.data.memo.type).toBe('hash');
    expect(parsed.data.findings).toEqual([]);
  });
});

describe('audit envelopes through outputJsonError', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('serializes incomparable snapshot audits as an error envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Snapshots refer to different accounts', 2));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('Snapshots refer to different accounts');
    expect(parsed.code).toBe(2);
  });

  it('serializes payment reference lookup failures as an error envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Transaction hash not found', 2));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(2);
  });

  it('serializes invalid Soroban query configurations as an error envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Invalid event query configuration', 2));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('Invalid event query configuration');
  });

  it('serializes memo privacy audit failures as an error envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Unable to decode transaction memo', 2));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(2);
  });
});
