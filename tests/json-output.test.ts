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
import {
  auditRecoverySignerQuorum,
  parseSep30RecoveryResponse,
  type Sep30RecoveryResponse,
  type OnChainSignerConfig,
} from '../src/sep30/quorum-audit';

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
// SEP-30 recovery signer quorum audit
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFQ';

function recoveryResponse(
  signers: Array<{ key: string; weight?: number }>,
  overrides: Partial<Sep30RecoveryResponse> = {},
): Sep30RecoveryResponse {
  return {
    account: ACCOUNT_ID,
    signers: signers.map((s) => ({ key: s.key, weight: s.weight ?? 1 })),
    ...overrides,
  } as Sep30RecoveryResponse;
}

function onChain(
  signers: Array<{ key: string; weight: number }>,
  thresholds: { low: number; medium: number; high: number },
): OnChainSignerConfig {
  return {
    accountId: ACCOUNT_ID,
    thresholds,
    signers: signers.map((s) => ({ key: s.key, weight: s.weight, type: 'ed25519_public_key' })),
  };
}

const RECOVERY_KEY_A = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const RECOVERY_KEY_B = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ONCHAIN_KEY_C = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

describe('SEP-30 recovery signer quorum audit', () => {
  describe('signer set comparison', () => {
    it('reports matching signer keys', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.matching).toContain(RECOVERY_KEY_A);
      expect(result.signerComparison.missing).toHaveLength(0);
      expect(result.signerComparison.additional).toHaveLength(0);
    });

    it('reports recovery signers missing from the on-chain configuration', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.missing).toContain(RECOVERY_KEY_A);
      expect(result.signerComparison.matching).toHaveLength(0);
      expect(result.findings.some((f) => f.code === 'RECOVERY_SIGNER_NOT_ON_CHAIN')).toBe(true);
    });

    it('reports additional on-chain signers not present in the recovery response', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain(
          [
            { key: RECOVERY_KEY_A, weight: 1 },
            { key: ONCHAIN_KEY_C, weight: 1 },
          ],
          { low: 1, medium: 1, high: 1 },
        ),
      });
      expect(result.signerComparison.additional).toContain(ONCHAIN_KEY_C);
    });

    it('handles nonmatching recovery signer sets entirely', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([
          { key: RECOVERY_KEY_A, weight: 1 },
          { key: RECOVERY_KEY_B, weight: 1 },
        ]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.matching).toHaveLength(0);
      expect(result.signerComparison.missing).toEqual(
        expect.arrayContaining([RECOVERY_KEY_A, RECOVERY_KEY_B]),
      );
    });
  });

  describe('threshold feasibility', () => {
    it('marks a threshold feasible when matching weight is above it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.feasible).toBe(true);
    });

    it('marks a threshold feasible when matching weight equals it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 3 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 3 }], { low: 3, medium: 3, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.feasible).toBe(true);
    });

    it('marks a threshold infeasible when matching weight is below it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(false);
      expect(result.thresholds.high.feasible).toBe(false);
      expect(result.status).toBe('insufficient-quorum');
    });

    it('sums weights across multiple matching signers using integer arithmetic', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([
          { key: RECOVERY_KEY_A, weight: 2 },
          { key: RECOVERY_KEY_B, weight: 3 },
        ]),
        onChain: onChain(
          [
            { key: RECOVERY_KEY_A, weight: 2 },
            { key: RECOVERY_KEY_B, weight: 3 },
          ],
          { low: 1, medium: 5, high: 6 },
        ),
      });
      expect(result.thresholds.medium.availableWeight).toBe(5);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.availableWeight).toBe(5);
      expect(result.thresholds.high.feasible).toBe(false);
    });

    it('respects varied low, medium, and high thresholds', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 4 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 4 }], { low: 1, medium: 10, high: 20 }),
      });
      expect(result.thresholds.low.requiredWeight).toBe(1);
      expect(result.thresholds.medium.requiredWeight).toBe(10);
      expect(result.thresholds.high.requiredWeight).toBe(20);
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(false);
      expect(result.thresholds.high.feasible).toBe(false);
    });
  });

  describe('incomplete and malformed data', () => {
    it('produces a finding for missing signer information', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: { account: ACCOUNT_ID } as Sep30RecoveryResponse,
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'MISSING_SIGNER_DATA')).toBe(true);
    });

    it('produces a finding for malformed signer keys', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: 'not-a-valid-key', weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.findings.some((f) => f.code === 'MALFORMED_SIGNER_KEY')).toBe(true);
    });

    it('produces a finding for unsupported SEP-30 response formats', () => {
      const parsed = parseSep30RecoveryResponse({ unexpected: true });
      expect(parsed.supported).toBe(false);
      expect(parsed.findings.some((f) => f.code === 'UNSUPPORTED_RESPONSE_FORMAT')).toBe(true);
    });

    it('does not throw on unsupported recovery response formats', () => {
      expect(() =>
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: { unexpected: true } as unknown as Sep30RecoveryResponse,
          onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        }),
      ).not.toThrow();
    });

    it('reports inconclusive when the on-chain configuration is incomplete', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: { accountId: ACCOUNT_ID } as OnChainSignerConfig,
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'INCOMPLETE_ONCHAIN_CONFIG')).toBe(true);
    });

    it('reports a warning when recovery signers are absent from the on-chain config', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.status).toBe('warning');
    });
  });

  describe('Horizon retrieval failures', () => {
    it('reports inconclusive when Horizon retrieval fails', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: null,
        horizonError: 'Horizon request failed: 503 Service Unavailable',
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'HORIZON_RETRIEVAL_FAILED')).toBe(true);
    });

    it('does not throw when Horizon retrieval fails', () => {
      expect(() =>
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
          onChain: null,
          horizonError: 'timeout',
        }),
      ).not.toThrow();
    });
  });

  describe('JSON output', () => {
    it('emits a successful audit envelope with required keys', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.accountId).toBe(ACCOUNT_ID);
      expect(parsed.data.thresholds).toBeDefined();
      expect(parsed.data.signerComparison).toBeDefined();
      expect(parsed.data.findings).toBeDefined();
      expect(parsed.data.status).toBe('success');
    });

    it('emits an insufficient-quorum JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 2, high: 3 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('insufficient-quorum');
    });

    it('emits a warning JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('warning');
    });

    it('emits an inconclusive JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: { account: ACCOUNT_ID } as Sep30RecoveryResponse,
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('inconclusive');
    });

    it('includes a disclaimer that quorum feasibility does not guarantee recovery', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.disclaimer.toLowerCase()).toContain('does not guarantee');
    });
  });

  describe('sensitive data and side effects', () => {
    it('does not include credentials or access tokens in the result', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }], {
          authToken: 'super-secret-token',
          metadata: { email: 'user@example.com', phone: '+15551234567' },
        } as Partial<Sep30RecoveryResponse>),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('super-secret-token');
      expect(serialized).not.toContain('user@example.com');
      expect(serialized).not.toContain('+15551234567');
    });

    it('does not log credentials when running the audit', async () => {
      const errOut = await captureStderr(() => {
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }], {
            authToken: 'super-secret-token',
          } as Partial<Sep30RecoveryResponse>),
          onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        });
      });
      expect(errOut).not.toContain('super-secret-token');
    });

    it('performs no recovery action or on-chain change', () => {
      const submitSpy = jest.fn();
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        submitTransaction: submitSpy,
      });
      expect(submitSpy).not.toHaveBeenCalled();
      expect(result.readOnly).toBe(true);
    });
  });
});
