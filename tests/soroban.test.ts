import { inspectSoroban, validateSorobanUrl } from '../src/inspectors/soroban';
import {
  validateEventQuery,
  formatEventQueryValidation,
  SorobanEventQueryConfig,
} from '../src/inspectors/sorobanEventQuery';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that dispatches different results per JSON-RPC method name.
 */
function buildMethodMock(handlers: Record<string, unknown>, httpOk = true, httpStatus = 200) {
  return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!httpOk) {
      return Promise.resolve({
        ok: false,
        status: httpStatus,
        statusText: 'Service Unavailable',
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }

    const body = JSON.parse(init?.body as string) as { method: string };
    const result = handlers[body.method] ?? null;

    if (result instanceof Error) {
      // Simulate a JSON-RPC error envelope
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: result.message },
          }),
      } as unknown as Response);
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response);
  });
}

// ---------------------------------------------------------------------------
// validateSorobanUrl
// ---------------------------------------------------------------------------

describe('validateSorobanUrl', () => {
  it('accepts a valid https URL', () => {
    expect(validateSorobanUrl('https://soroban-testnet.stellar.org').valid).toBe(true);
  });

  it('accepts a valid http URL', () => {
    expect(validateSorobanUrl('http://localhost:8000').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = validateSorobanUrl('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a non-URL string', () => {
    const result = validateSorobanUrl('not-a-url');
    expect(result.valid).toBe(false);
  });

  it('rejects an ftp:// URL', () => {
    const result = validateSorobanUrl('ftp://soroban.example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/http/i);
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — happy path
// ---------------------------------------------------------------------------

describe('inspectSoroban — successful inspection', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns status=online and all fields when all three methods succeed', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test SDF Network ; September 2015', protocolVersion: 21 },
      getLatestLedger: { sequence: 999000, closedAt: 1700000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
    expect(info.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(info.protocolVersion).toBe(21);
    expect(info.latestLedgerSequence).toBe(999000);
    expect(info.latestLedgerCloseTime).toBe(1700000000);
    expect(info.latestLedgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('measures latency as a non-negative number', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stores the normalized url on the result', async () => {
    global.fetch = buildMethodMock({ getHealth: { status: 'healthy' } });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.url).toBe('https://soroban.example.com');
  });

  it('handles the alternative `passphrase` field name from getNetwork', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { passphrase: 'Public Global Stellar Network ; September 2015' },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('handles closeTime variant from getLatestLedger', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getLatestLedger: { sequence: 42, closeTime: 1680000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latestLedgerCloseTime).toBe(1680000000);
    expect(info.latestLedgerCloseTimeIso).toBeTruthy();
  });

  it('handles ledgerCloseTime variant from getLatestLedger', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getLatestLedger: { sequence: 42, ledgerCloseTime: 1690000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latestLedgerCloseTime).toBe(1690000000);
  });

  it('handles a millisecond timestamp in latestLedgerCloseTime without double-converting', async () => {
    const msTimestamp = 1700000000000; // already in ms
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getLatestLedger: { sequence: 42, closedAt: msTimestamp },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    // Should not produce a date in year 55000+
    const year = new Date(info.latestLedgerCloseTimeIso!).getFullYear();
    expect(year).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — partial / degraded responses
// ---------------------------------------------------------------------------

describe('inspectSoroban — optional methods failing gracefully', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns online even when getNetwork fails', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: new Error('Method not found'),
      getLatestLedger: { sequence: 123 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.networkPassphrase).toBeUndefined();
    expect(info.latestLedgerSequence).toBe(123);
  });

  it('returns online even when getLatestLedger fails', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 21 },
      getLatestLedger: new Error('Method not found'),
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.latestLedgerSequence).toBeUndefined();
    expect(info.latestLedgerCloseTime).toBeUndefined();
  });

  it('returns online when both optional methods fail', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: new Error('Not supported'),
      getLatestLedger: new Error('Not supported'),
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
  });

  it('uses "unknown" as health when getHealth returns no status field', async () => {
    global.fetch = buildMethodMock({ getHealth: {} });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.health).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — offline / failure scenarios
// ---------------------------------------------------------------------------

describe('inspectSoroban — offline and error handling', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns status=offline when fetch throws a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.health).toBeUndefined();
    expect(info.error).toMatch(/Network error/);
  });

  it('returns status=offline when the server returns a non-2xx HTTP status', async () => {
    global.fetch = buildMethodMock({}, false, 503);

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toMatch(/HTTP 503/);
  });

  it('returns status=offline when getHealth returns a JSON-RPC error', async () => {
    global.fetch = buildMethodMock({ getHealth: new Error('Server unavailable') });

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
  });

  it('populates latencyMs even when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns offline immediately for an invalid URL (no network call)', async () => {
    global.fetch = jest.fn();

    const info = await inspectSoroban('not-a-url');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns offline for an empty URL', async () => {
    global.fetch = jest.fn();

    const info = await inspectSoroban('');

    expect(info.status).toBe('offline');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not throw for any input — always returns a SorobanInfo object', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('anything'));

    await expect(inspectSoroban('https://soroban.example.com')).resolves.toMatchObject({
      status: 'offline',
    });
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — valid configurations
// ---------------------------------------------------------------------------

describe('validateEventQuery — valid configurations', () => {
  it('accepts a minimal valid query with only a contract id', () => {
    const config: SorobanEventQueryConfig = {
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    };

    const result = validateEventQuery(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.query).toBeDefined();
  });

  it('accepts a query with a supported event type', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'contract',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a query with a valid ledger range', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 1000,
      endLedger: 2000,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a query with valid topic filters', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [['*']],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a query with an empty topic filter array (optional)', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports optional filters separately from required parameters', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'contract',
      topics: [['*']],
      startLedger: 10,
      endLedger: 20,
    });

    expect(result.valid).toBe(true);
    expect(result.optional).toBeDefined();
    expect(Array.isArray(result.optional)).toBe(true);
    expect(result.required).toBeDefined();
    expect(Array.isArray(result.required)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — supported event types
// ---------------------------------------------------------------------------

describe('validateEventQuery — event type filters', () => {
  it('accepts the "contract" event type', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'contract',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts the "system" event type', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'system',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts the "diagnostic" event type', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'diagnostic',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an unsupported event type', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'bogus' as unknown as 'contract',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /type/i.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — contract identifier validation
// ---------------------------------------------------------------------------

describe('validateEventQuery — contract identifiers', () => {
  it('accepts a valid contract id', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a contract id with an invalid prefix', () => {
    const result = validateEventQuery({
      contractIds: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /contract/i.test(e.message))).toBe(true);
  });

  it('rejects a contract id with an invalid length', () => {
    const result = validateEventQuery({
      contractIds: ['CABC'],
    });

    expect(result.valid).toBe(false);
  });

  it('rejects a contract id with invalid base32 characters', () => {
    const result = validateEventQuery({
      contractIds: ['C1111111111111111111111111111111111111111111111111111'],
    });

    expect(result.valid).toBe(false);
  });

  it('reports the offending index for an invalid contract id', () => {
    const result = validateEventQuery({
      contractIds: [
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        'not-a-contract',
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path && /contractIds\[1\]/.test(e.path))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — topic filters
// ---------------------------------------------------------------------------

describe('validateEventQuery — topic filters', () => {
  it('accepts a wildcard topic', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [['*']],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid ScVal topic representation', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [['AAAAAA==']],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a malformed ScVal topic representation', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [['not-base64!!!']],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /topic/i.test(e.message))).toBe(true);
  });

  it('rejects a topic filter that is not an array of arrays', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: ['*'] as unknown as string[][],
    });

    expect(result.valid).toBe(false);
  });

  it('reports the path of a malformed topic', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      topics: [['*'], ['not-base64!!!']],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path && /topics\[1\]/.test(e.path))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — required fields and unsupported combinations
// ---------------------------------------------------------------------------

describe('validateEventQuery — required fields and unsupported combinations', () => {
  it('rejects a query with no contract ids', () => {
    const result = validateEventQuery({} as SorobanEventQueryConfig);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /contract/i.test(e.message))).toBe(true);
  });

  it('rejects a query with an empty contractIds array', () => {
    const result = validateEventQuery({ contractIds: [] });

    expect(result.valid).toBe(false);
  });

  it('reports unsupported schema fields explicitly rather than discarding them', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      unsupportedField: true,
    } as unknown as SorobanEventQueryConfig);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unsupported/i.test(e.message))).toBe(true);
  });

  it('reports unsupported filter combinations', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      type: 'system',
      topics: [['*']],
    });

    // system events do not support topic filters in the supported schema
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /combination|topic/i.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — ledger ranges
// ---------------------------------------------------------------------------

describe('validateEventQuery — ledger ranges', () => {
  it('accepts a valid ascending ledger range', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 100,
      endLedger: 200,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a query with only startLedger', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 100,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a reversed ledger range', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 500,
      endLedger: 100,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /ledger|range/i.test(e.message))).toBe(true);
  });

  it('rejects a malformed (non-integer) ledger boundary', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 1.5,
    });

    expect(result.valid).toBe(false);
  });

  it('rejects a negative ledger boundary', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: -1,
    });

    expect(result.valid).toBe(false);
  });

  it('rejects a non-numeric ledger boundary', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      startLedger: 'abc' as unknown as number,
    });

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — endpoint compatibility vs local validation
// ---------------------------------------------------------------------------

describe('validateEventQuery — endpoint compatibility', () => {
  it('does not claim endpoint acceptance for a locally valid query', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });

    expect(result.valid).toBe(true);
    expect(result.endpointCompatibility).toBeUndefined();
  });

  it('distinguishes local validation from endpoint compatibility when an endpoint is supplied', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
      endpoint: 'https://soroban.example.com',
    });

    expect(result.valid).toBe(true);
    expect(result.endpointCompatibility).toBeDefined();
    expect(result.endpointCompatibility!.checked).toBe(false);
  });

  it('does not claim that a valid query guarantees event availability', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });

    expect(result.valid).toBe(true);
    expect(result.notes.join(' ')).toMatch(/does not guarantee|no guarantee|not guarantee/i);
  });
});

// ---------------------------------------------------------------------------
// validateEventQuery — output formatting
// ---------------------------------------------------------------------------

describe('validateEventQuery — output formatting', () => {
  it('produces a JSON-serializable result', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });

    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toBeDefined();
  });

  it('includes field-level findings in JSON output', () => {
    const result = validateEventQuery({
      contractIds: ['not-a-contract'],
    });

    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toHaveProperty('message');
  });

  it('formats a readable terminal report for a valid query', () => {
    const result = validateEventQuery({
      contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'],
    });

    const output = formatEventQueryValidation(result);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toMatch(/valid/i);
  });

  it('formats a readable terminal report for an invalid query', () => {
    const result = validateEventQuery({ contractIds: [] });

    const output = formatEventQueryValidation(result);
    expect(output).toMatch(/invalid|error/i);
  });
});

// ---------------------------------------------------------------------------
// Regression — existing Soroban event decoding remains backward compatible
// ---------------------------------------------------------------------------

describe('regression — existing Soroban event inspection', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('still returns a SorobanInfo object from inspectSoroban', async () => {
    global.fetch = buildMethodMock({ getHealth: { status: 'healthy' } });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info).toMatchObject({ status: 'online', health: 'healthy' });
  });

  it('still validates Soroban URLs', () => {
    expect(validateSorobanUrl('https://soroban.example.com').valid).toBe(true);
    expect(validateSorobanUrl('not-a-url').valid).toBe(false);
  });
});
