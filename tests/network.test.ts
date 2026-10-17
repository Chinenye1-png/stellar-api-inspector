import { inspectNetworkPassphrase } from '../src/services/network-validator';
import {
  runNetworkFeeProtocolAudit,
  type NetworkFeeProtocolAuditDeps,
  type HorizonFeeStatsResponse,
  type SorobanNetworkInfoResponse,
} from '../src/services/network-fee-protocol-audit';

describe('inspectNetworkPassphrase', () => {
  it('detects the public network by passphrase', () => {
    const result = inspectNetworkPassphrase('Public Global Stellar Network ; September 2015');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.known).toBe(true);
    expect(result.networkName).toBe('Public Network');
    expect(result.matchedNetwork?.id).toBe('public');
  });

  it('detects testnet by alias', () => {
    const result = inspectNetworkPassphrase('testnet');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.known).toBe(true);
    expect(result.networkName).toBe('Testnet');
  });

  it('treats custom passphrases as custom networks', () => {
    const result = inspectNetworkPassphrase('Custom Network ; Local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.known).toBe(false);
    expect(result.isCustom).toBe(true);
    expect(result.networkName).toBe('Custom Network');
  });

  it('rejects blank input', () => {
    const result = inspectNetworkPassphrase('   ');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('empty');
  });
});

type MockDeps = {
  deps: NetworkFeeProtocolAuditDeps;
  calls: {
    horizonFeeStats: number;
    horizonLedger: number;
    sorobanNetworkInfo: number;
    submitTransaction: number;
    setNetwork: number;
  };
};

function createMockDeps(overrides: {
  networkName?: string;
  networkPassphrase?: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  sdkSupportedProtocolVersion?: number;
  requiredProtocolVersion?: number;
  feeStats?: HorizonFeeStatsResponse | Error | null;
  ledger?: { protocol_version?: number | string } | Error | null;
  sorobanInfo?: SorobanNetworkInfoResponse | Error | null;
}): MockDeps {
  const calls = {
    horizonFeeStats: 0,
    horizonLedger: 0,
    sorobanNetworkInfo: 0,
    submitTransaction: 0,
    setNetwork: 0,
  };

  const deps: NetworkFeeProtocolAuditDeps = {
    getNetworkConfig: () => ({
      networkName: overrides.networkName ?? 'Testnet',
      networkPassphrase: overrides.networkPassphrase ?? 'Test SDF Network ; September 2015',
      horizonUrl: overrides.horizonUrl ?? 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: overrides.sorobanRpcUrl,
    }),
    getSdkCapabilities: () => ({
      supportedProtocolVersion: overrides.sdkSupportedProtocolVersion ?? 20,
      requiredProtocolVersion: overrides.requiredProtocolVersion,
    }),
    fetchHorizonFeeStats: async () => {
      calls.horizonFeeStats += 1;
      if (overrides.feeStats instanceof Error) throw overrides.feeStats;
      return overrides.feeStats ?? null;
    },
    fetchHorizonLedger: async () => {
      calls.horizonLedger += 1;
      if (overrides.ledger instanceof Error) throw overrides.ledger;
      return overrides.ledger ?? null;
    },
    fetchSorobanNetworkInfo: async () => {
      calls.sorobanNetworkInfo += 1;
      if (overrides.sorobanInfo instanceof Error) throw overrides.sorobanInfo;
      return overrides.sorobanInfo ?? null;
    },
    submitTransaction: async () => {
      calls.submitTransaction += 1;
      throw new Error('submitTransaction must not be called by the audit');
    },
    setNetwork: () => {
      calls.setNetwork += 1;
      throw new Error('setNetwork must not be called by the audit');
    },
  };

  return { deps, calls };
}

describe('runNetworkFeeProtocolAudit', () => {
  describe('network configuration', () => {
    it('reports the configured network context for a valid configuration', async () => {
      const { deps } = createMockDeps({
        networkName: 'Testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.networkContext.networkName).toBe('Testnet');
      expect(result.networkContext.networkPassphrase).toBe('Test SDF Network ; September 2015');
      expect(result.networkContext.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(result.networkContext.passphraseKnown).toBe(true);
    });

    it('flags incomplete network configuration with a meaningful finding', async () => {
      const { deps } = createMockDeps({
        networkName: '',
        networkPassphrase: '',
        horizonUrl: '',
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const finding = result.findings.find((f) => f.code === 'NETWORK_CONFIG_INCOMPLETE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(result.status).toBe('error');
    });

    it('reports unknown passphrases as advisory rather than confirmed mismatch', async () => {
      const { deps } = createMockDeps({
        networkName: 'Custom',
        networkPassphrase: 'Custom Network ; Local',
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.networkContext.passphraseKnown).toBe(false);
      const finding = result.findings.find((f) => f.code === 'NETWORK_PASSPHRASE_UNKNOWN');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });
  });

  describe('passphrase consistency across clients', () => {
    it('reports no mismatch when client passphrases match', async () => {
      const { deps } = createMockDeps({
        networkPassphrase: 'Test SDF Network ; September 2015',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 20,
          version: '20.0.0',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const mismatch = result.findings.find((f) => f.code === 'NETWORK_PASSPHRASE_MISMATCH');
      expect(mismatch).toBeUndefined();
    });

    it('reports a confirmed mismatch when client passphrases differ', async () => {
      const { deps } = createMockDeps({
        networkPassphrase: 'Test SDF Network ; September 2015',
        sorobanInfo: {
          passphrase: 'Public Global Stellar Network ; September 2015',
          protocolVersion: 20,
          version: '20.0.0',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const mismatch = result.findings.find((f) => f.code === 'NETWORK_PASSPHRASE_MISMATCH');
      expect(mismatch).toBeDefined();
      expect(mismatch?.severity).toBe('error');
      expect(result.status).toBe('error');
    });
  });

  describe('fee statistics', () => {
    it('summarizes available fee statistics as observations', async () => {
      const { deps } = createMockDeps({
        feeStats: {
          last_ledger: '100',
          last_ledger_base_fee: '100',
          ledger_capacity_usage: '0.5',
          fee_charged: {
            max: '200',
            min: '100',
            mode: '100',
            p10: '100',
            p20: '100',
            p30: '100',
            p40: '100',
            p50: '100',
            p60: '100',
            p70: '100',
            p80: '100',
            p90: '150',
            p95: '180',
            p99: '200',
          },
          max_fee: {
            max: '300',
            min: '100',
            mode: '100',
            p10: '100',
            p20: '100',
            p30: '100',
            p40: '100',
            p50: '100',
            p60: '100',
            p70: '100',
            p80: '100',
            p90: '200',
            p95: '250',
            p99: '300',
          },
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.feeObservations.available).toBe(true);
      expect(result.feeObservations.baseFee).toBe('100');
      expect(result.feeObservations.recommendedFee).toBeDefined();
      expect(result.feeObservations.disclaimer).toMatch(/observation|not.*guarantee/i);
    });

    it('handles empty fee statistics without throwing', async () => {
      const { deps } = createMockDeps({ feeStats: null });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.feeObservations.available).toBe(false);
      const finding = result.findings.find((f) => f.code === 'FEE_STATS_UNAVAILABLE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });

    it('handles malformed fee statistics without throwing', async () => {
      const { deps } = createMockDeps({
        feeStats: { last_ledger: '100' } as unknown as HorizonFeeStatsResponse,
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.feeObservations.available).toBe(false);
      const finding = result.findings.find((f) => f.code === 'FEE_STATS_MALFORMED');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });

    it('handles fee statistics fetch errors without throwing', async () => {
      const { deps } = createMockDeps({ feeStats: new Error('network down') });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.feeObservations.available).toBe(false);
      const finding = result.findings.find((f) => f.code === 'FEE_STATS_UNAVAILABLE');
      expect(finding).toBeDefined();
    });
  });

  describe('protocol metadata', () => {
    it('reports protocol version from ledger information', async () => {
      const { deps } = createMockDeps({
        ledger: { protocol_version: 20 },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.protocolInfo.ledgerProtocolVersion).toBe(20);
    });

    it('handles missing protocol metadata as unknown', async () => {
      const { deps } = createMockDeps({ ledger: null });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.protocolInfo.ledgerProtocolVersion).toBeUndefined();
      const finding = result.findings.find((f) => f.code === 'PROTOCOL_METADATA_UNAVAILABLE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });

    it('handles malformed protocol metadata without throwing', async () => {
      const { deps } = createMockDeps({
        ledger: { protocol_version: 'not-a-number' },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.protocolInfo.ledgerProtocolVersion).toBeUndefined();
      const finding = result.findings.find((f) => f.code === 'PROTOCOL_METADATA_MALFORMED');
      expect(finding).toBeDefined();
    });

    it('reports unsupported SDK capabilities as a finding', async () => {
      const { deps } = createMockDeps({
        ledger: { protocol_version: 21 },
        sdkSupportedProtocolVersion: 20,
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const finding = result.findings.find((f) => f.code === 'SDK_PROTOCOL_UNSUPPORTED');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });
  });

  describe('Soroban RPC', () => {
    it('inspects Soroban network info when the endpoint is configured', async () => {
      const { deps, calls } = createMockDeps({
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 20,
          version: '20.0.0',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(calls.sorobanNetworkInfo).toBe(1);
      expect(result.sorobanInfo.available).toBe(true);
      expect(result.sorobanInfo.protocolVersion).toBe(20);
      expect(result.sorobanInfo.softwareVersion).toBe('20.0.0');
    });

    it('skips Soroban checks when no RPC endpoint is configured', async () => {
      const { deps, calls } = createMockDeps({ sorobanRpcUrl: undefined });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(calls.sorobanNetworkInfo).toBe(0);
      expect(result.sorobanInfo.available).toBe(false);
      const finding = result.findings.find((f) => f.code === 'SOROBAN_ENDPOINT_NOT_CONFIGURED');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('info');
    });

    it('handles Soroban responses with only some metadata fields', async () => {
      const { deps } = createMockDeps({
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.sorobanInfo.available).toBe(true);
      expect(result.sorobanInfo.protocolVersion).toBeUndefined();
      expect(result.sorobanInfo.softwareVersion).toBeUndefined();
    });

    it('handles Soroban RPC errors without throwing', async () => {
      const { deps } = createMockDeps({
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: new Error('rpc unavailable'),
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      expect(result.sorobanInfo.available).toBe(false);
      const finding = result.findings.find((f) => f.code === 'SOROBAN_INFO_UNAVAILABLE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
    });

    it('does not infer protocol support from software version alone', async () => {
      const { deps } = createMockDeps({
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
          version: '20.0.0',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const inferred = result.findings.find((f) => f.code === 'PROTOCOL_SUPPORT_CONFIRMED');
      expect(inferred).toBeUndefined();
      expect(result.protocolInfo.ledgerProtocolVersion).toBeUndefined();
    });
  });

  describe('unknown capabilities', () => {
    it('reports unknown capabilities as unknown rather than incompatible', async () => {
      const { deps } = createMockDeps({
        ledger: null,
        sorobanRpcUrl: undefined,
      });

      const result = await runNetworkFeeProtocolAudit(deps);

      const unknown = result.findings.filter((f) => f.severity === 'unknown');
      expect(unknown.length).toBeGreaterThan(0);
      const incompatible = result.findings.filter((f) => f.code === 'PROTOCOL_INCOMPATIBLE');
      expect(incompatible).toHaveLength(0);
    });
  });

  describe('JSON output', () => {
    it('produces JSON output for a successful audit', async () => {
      const { deps } = createMockDeps({
        ledger: { protocol_version: 20 },
        feeStats: {
          last_ledger: '100',
          last_ledger_base_fee: '100',
          ledger_capacity_usage: '0.5',
          fee_charged: { max: '200', min: '100', mode: '100' },
          max_fee: { max: '300', min: '100', mode: '100' },
        },
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 20,
          version: '20.0.0',
        },
      });

      const result = await runNetworkFeeProtocolAudit(deps);
      const json = JSON.parse(JSON.stringify(result));

      expect(json.networkContext).toBeDefined();
      expect(json.feeObservations).toBeDefined();
      expect(json.findings).toBeDefined();
      expect(json.status).toBeDefined();
    });

    it('produces JSON output for warnings', async () => {
      const { deps } = createMockDeps({
        ledger: null,
        feeStats: null,
      });

      const result = await runNetworkFeeProtocolAudit(deps);
      const json = JSON.parse(JSON.stringify(result));

      expect(json.status).toBe('warning');
      expect(json.findings.length).toBeGreaterThan(0);
    });

    it('produces JSON output for errors', async () => {
      const { deps } = createMockDeps({
        networkName: '',
        networkPassphrase: '',
        horizonUrl: '',
      });

      const result = await runNetworkFeeProtocolAudit(deps);
      const json = JSON.parse(JSON.stringify(result));

      expect(json.status).toBe('error');
    });

    it('produces JSON output for partial results', async () => {
      const { deps } = createMockDeps({
        ledger: { protocol_version: 20 },
        feeStats: new Error('fee stats failed'),
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: new Error('rpc failed'),
      });

      const result = await runNetworkFeeProtocolAudit(deps);
      const json = JSON.parse(JSON.stringify(result));

      expect(json.protocolInfo.ledgerProtocolVersion).toBe(20);
      expect(json.feeObservations.available).toBe(false);
      expect(json.sorobanInfo.available).toBe(false);
      expect(json.status).toBe('warning');
    });
  });

  describe('read-only guarantees', () => {
    it('does not submit transactions or modify network settings', async () => {
      const { deps, calls } = createMockDeps({
        ledger: { protocol_version: 20 },
        feeStats: {
          last_ledger: '100',
          last_ledger_base_fee: '100',
          ledger_capacity_usage: '0.5',
          fee_charged: { max: '200', min: '100', mode: '100' },
          max_fee: { max: '300', min: '100', mode: '100' },
        },
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        sorobanInfo: {
          passphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 20,
          version: '20.0.0',
        },
      });

      await runNetworkFeeProtocolAudit(deps);

      expect(calls.submitTransaction).toBe(0);
      expect(calls.setNetwork).toBe(0);
    });
  });
});