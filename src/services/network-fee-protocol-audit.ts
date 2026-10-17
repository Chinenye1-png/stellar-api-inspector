/**
 * Network Fee and Protocol Compatibility Audit Service
 *
 * ISSUE-104: Read-only diagnostic that evaluates whether the configured Stellar
 * network and available protocol information are compatible with the operations
 * the user intends to inspect or construct.
 *
 * This service is strictly read-only. It never submits transactions, never
 * modifies network configuration, and never claims an operation is valid solely
 * because the network appears compatible.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { getNetworkConfig, validateNetworkPassphrase } from './network-validator';
import { createHorizonClient } from './horizon-client';
import {
  fetchHorizonFeeStats,
  fetchHorizonLedger,
  type HorizonFeeStats,
  type HorizonLedger,
} from './inspectors/horizon';
import {
  getSorobanRpcCapabilities,
  type SorobanRpcCapabilities,
} from './soroban/rpc-capabilities';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingSeverity = 'confirmed-mismatch' | 'warning' | 'unknown' | 'info';

export type AuditStatus = 'ok' | 'warnings' | 'mismatch' | 'error' | 'partial';

export interface AuditFinding {
  /** Stable identifier for the finding. */
  code: string;
  /** Severity classification. */
  severity: FindingSeverity;
  /** Human-readable summary. */
  message: string;
  /** Verifiable evidence supporting the finding. */
  evidence?: Record<string, unknown>;
  /** Recommended next steps for the operator. */
  recommendation?: string;
}

export interface NetworkContext {
  /** Configured network name (e.g. "testnet", "mainnet", "futurenet"). */
  networkName: string | null;
  /** Configured network passphrase. */
  networkPassphrase: string | null;
  /** Horizon URL used for the audit, if configured. */
  horizonUrl: string | null;
  /** Soroban RPC URL used for the audit, if configured. */
  sorobanRpcUrl: string | null;
  /** Whether the configured passphrase matches the SDK's known passphrase for the network. */
  passphraseMatchesKnownNetwork: boolean | null;
}

export interface FeeObservation {
  /** Whether fee statistics were successfully retrieved. */
  available: boolean;
  /** Source of the fee observation. */
  source: 'horizon:/fee_stats' | null;
  /** Raw last-ledger base fee in stroops, if available. */
  lastLedgerBaseFee: string | null;
  /** Raw ledger capacity usage, if available. */
  ledgerCapacityUsage: string | null;
  /** Recommended fee in stroops, if available. */
  recommendedFee: string | null;
  /** Minimum accepted fee in stroops, if available. */
  minAcceptedFee: string | null;
  /** Maximum accepted fee in stroops, if available. */
  maxAcceptedFee: string | null;
  /** Mode of the fee distribution, if available. */
  mode: string | null;
  /** Explicit disclaimer that these are observations, not guarantees. */
  disclaimer: string;
}

export interface ProtocolInfo {
  /** Horizon-reported protocol version from the latest ledger, if available. */
  horizonProtocolVersion: number | null;
  /** Horizon-reported core version from the latest ledger, if available. */
  horizonCoreVersion: string | null;
  /** Soroban RPC protocol version, if available. */
  sorobanProtocolVersion: number | null;
  /** Soroban RPC software version, if available. */
  sorobanSoftwareVersion: string | null;
  /** Soroban RPC passphrase, if available. */
  sorobanPassphrase: string | null;
  /** Whether Soroban RPC checks were attempted. */
  sorobanChecked: boolean;
}

export interface NetworkFeeProtocolAuditResult {
  /** Overall status of the audit. */
  status: AuditStatus;
  /** Configured network context. */
  network: NetworkContext;
  /** Fee observations (never guarantees). */
  fees: FeeObservation;
  /** Available protocol-related information. */
  protocol: ProtocolInfo;
  /** Compatibility findings with severity, evidence, and recommendations. */
  findings: AuditFinding[];
  /** Timestamp of the audit. */
  timestamp: string;
}

export interface NetworkFeeProtocolAuditOptions {
  /** Override the configured network name. */
  networkName?: string;
  /** Override the configured network passphrase. */
  networkPassphrase?: string;
  /** Override the Horizon URL. */
  horizonUrl?: string;
  /** Override the Soroban RPC URL. */
  sorobanRpcUrl?: string;
  /** Optional Horizon client to reuse (e.g. in tests). */
  horizonClient?: Horizon.Server;
  /** Optional Soroban RPC capabilities provider (e.g. in tests). */
  sorobanCapabilitiesProvider?: (url: string) => Promise<SorobanRpcCapabilities>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEE_DISCLAIMER =
  'Fee statistics are observations of recent network activity and are not ' +
  'guaranteed transaction inclusion prices. Actual inclusion depends on ' +
  'network conditions, transaction composition, and surge pricing.';

const KNOWN_NETWORKS: Record<string, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  pubnet: 'Public Global Stellar Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  local: 'Standalone Network ; February 2017',
  standalone: 'Standalone Network ; February 2017',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePassphrase(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveKnownPassphrase(networkName: string | null): string | null {
  if (!networkName) {
    return null;
  }
  const key = networkName.trim().toLowerCase();
  return KNOWN_NETWORKS[key] ?? null;
}

function emptyFeeObservation(): FeeObservation {
  return {
    available: false,
    source: null,
    lastLedgerBaseFee: null,
    ledgerCapacityUsage: null,
    recommendedFee: null,
    minAcceptedFee: null,
    maxAcceptedFee: null,
    mode: null,
    disclaimer: FEE_DISCLAIMER,
  };
}

function emptyProtocolInfo(): ProtocolInfo {
  return {
    horizonProtocolVersion: null,
    horizonCoreVersion: null,
    sorobanProtocolVersion: null,
    sorobanSoftwareVersion: null,
    sorobanPassphrase: null,
    sorobanChecked: false,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class NetworkFeeProtocolAuditService {
  private readonly options: NetworkFeeProtocolAuditOptions;

  constructor(options: NetworkFeeProtocolAuditOptions = {}) {
    this.options = options;
  }

  /**
   * Run the read-only network fee and protocol compatibility audit.
   */
  async audit(): Promise<NetworkFeeProtocolAuditResult> {
    const findings: AuditFinding[] = [];
    const timestamp = new Date().toISOString();

    // -----------------------------------------------------------------
    // 1. Resolve configured network context.
    // -----------------------------------------------------------------
    const network = this.resolveNetworkContext(findings);

    // -----------------------------------------------------------------
    // 2. Inspect Horizon fee statistics and ledger protocol info.
    // -----------------------------------------------------------------
    const fees = emptyFeeObservation();
    const protocol = emptyProtocolInfo();

    const horizonClient = this.resolveHorizonClient(network.horizonUrl, findings);

    if (horizonClient) {
      await this.inspectHorizonFees(horizonClient, fees, findings);
      await this.inspectHorizonLedger(horizonClient, protocol, findings);
    } else {
      findings.push({
        code: 'horizon-unavailable',
        severity: 'unknown',
        message:
          'No Horizon endpoint is configured or available; fee statistics and ' +
          'Horizon protocol metadata could not be inspected.',
        recommendation:
          'Configure a Horizon URL (e.g. via the network configuration) to ' +
          'enable fee and protocol inspection.',
      });
    }

    // -----------------------------------------------------------------
    // 3. Conditionally inspect Soroban RPC network/version metadata.
    // -----------------------------------------------------------------
    if (network.sorobanRpcUrl) {
      await this.inspectSorobanRpc(network, protocol, findings);
    } else {
      findings.push({
        code: 'soroban-not-configured',
        severity: 'unknown',
        message:
          'No Soroban RPC endpoint is configured; Soroban-specific protocol ' +
          'metadata was not inspected.',
        recommendation:
          'Configure a Soroban RPC URL if Soroban operations are intended.',
      });
    }

    // -----------------------------------------------------------------
    // 4. Cross-client passphrase comparison.
    // -----------------------------------------------------------------
    this.comparePassphrases(network, protocol, findings);

    // -----------------------------------------------------------------
    // 5. Protocol capability inference guard.
    // -----------------------------------------------------------------
    this.assessProtocolCapabilities(protocol, findings);

    // -----------------------------------------------------------------
    // 6. Determine overall status.
    // -----------------------------------------------------------------
    const status = this.determineStatus(findings, fees, protocol, network);

    return {
      status,
      network,
      fees,
      protocol,
      findings,
      timestamp,
    };
  }

  // -------------------------------------------------------------------
  // Network context
  // -------------------------------------------------------------------

  private resolveNetworkContext(findings: AuditFinding[]): NetworkContext {
    let networkName: string | null = null;
    let networkPassphrase: string | null = null;
    let horizonUrl: string | null = null;
    let sorobanRpcUrl: string | null = null;

    // Prefer explicit overrides, then fall back to project configuration.
    try {
      const config = getNetworkConfig();
      networkName = normalizePassphrase(config?.networkName ?? null);
      networkPassphrase = normalizePassphrase(config?.networkPassphrase ?? null);
      horizonUrl = normalizePassphrase(config?.horizonUrl ?? null);
      sorobanRpcUrl = normalizePassphrase(config?.sorobanRpcUrl ?? null);
    } catch {
      // Configuration may be absent; handled below.
    }

    if (this.options.networkName !== undefined) {
      networkName = normalizePassphrase(this.options.networkName);
    }
    if (this.options.networkPassphrase !== undefined) {
      networkPassphrase = normalizePassphrase(this.options.networkPassphrase);
    }
    if (this.options.horizonUrl !== undefined) {
      horizonUrl = normalizePassphrase(this.options.horizonUrl);
    }
    if (this.options.sorobanRpcUrl !== undefined) {
      sorobanRpcUrl = normalizePassphrase(this.options.sorobanRpcUrl);
    }

    if (!networkName) {
      findings.push({
        code: 'network-name-missing',
        severity: 'warning',
        message: 'No network name is configured.',
        recommendation:
          'Configure a network name (e.g. "testnet" or "mainnet") so the audit ' +
          'can report the intended network context.',
      });
    }

    if (!networkPassphrase) {
      findings.push({
        code: 'network-passphrase-missing',
        severity: 'warning',
        message: 'No network passphrase is configured.',
        recommendation:
          'Configure a network passphrase so the audit can verify network ' +
          'consistency across clients.',
      });
    }

    // Validate the passphrase against the SDK's known networks.
    let passphraseMatchesKnownNetwork: boolean | null = null;
    if (networkPassphrase) {
      const knownPassphrase = resolveKnownPassphrase(networkName);
      if (knownPassphrase) {
        passphraseMatchesKnownNetwork = knownPassphrase === networkPassphrase;
        if (!passphraseMatchesKnownNetwork) {
          findings.push({
            code: 'network-passphrase-mismatch-known',
            severity: 'confirmed-mismatch',
            message:
              `Configured passphrase does not match the known passphrase for ` +
              `network "${networkName}".`,
            evidence: {
              configuredNetworkName: networkName,
              expectedPassphrase: knownPassphrase,
              configuredPassphrase: networkPassphrase,
            },
            recommendation:
              'Verify the network name and passphrase configuration; a mismatch ' +
              'will cause transactions to be built for the wrong network.',
          });
        }
      } else {
        // Unknown network name: validate via the network-validator if possible.
        try {
          const validation = validateNetworkPassphrase(networkPassphrase);
          if (validation && typeof validation.valid === 'boolean') {
            passphraseMatchesKnownNetwork = validation.valid;
            if (!validation.valid) {
              findings.push({
                code: 'network-passphrase-unrecognized',
                severity: 'warning',
                message:
                  'Configured passphrase is not recognized as a known Stellar ' +
                  'network passphrase.',
                evidence: { configuredPassphrase: networkPassphrase },
                recommendation:
                  'Confirm the passphrase is correct for the intended network.',
              });
            }
          }
        } catch {
          findings.push({
            code: 'network-passphrase-unverifiable',
            severity: 'unknown',
            message:
              'Configured passphrase could not be verified against known networks.',
            evidence: { configuredPassphrase: networkPassphrase },
          });
        }
      }
    }

    return {
      networkName,
      networkPassphrase,
      horizonUrl,
      sorobanRpcUrl,
      passphraseMatchesKnownNetwork,
    };
  }

  // -------------------------------------------------------------------
  // Horizon inspection
  // -------------------------------------------------------------------

  private resolveHorizonClient(
    horizonUrl: string | null,
    findings: AuditFinding[],
  ): Horizon.Server | null {
    if (this.options.horizonClient) {
      return this.options.horizonClient;
    }
    if (!horizonUrl) {
      return null;
    }
    try {
      return createHorizonClient(horizonUrl);
    } catch (error) {
      findings.push({
        code: 'horizon-client-error',
        severity: 'error',
        message: 'Failed to create a Horizon client from the configured URL.',
        evidence: {
          horizonUrl,
          error: error instanceof Error ? error.message : String(error),
        },
        recommendation:
          'Verify the Horizon URL is well-formed and reachable.',
      });
      return null;
    }
  }

  private async inspectHorizonFees(
    client: Horizon.Server,
    fees: FeeObservation,
    findings: AuditFinding[],
  ): Promise<void> {
    let stats: HorizonFeeStats | null = null;
    try {
      stats = await fetchHorizonFeeStats(client);
    } catch (error) {
      findings.push({
        code: 'horizon-fee-stats-error',
        severity: 'warning',
        message: 'Failed to retrieve Horizon fee statistics.',
        evidence: {
          error: error instanceof Error ? error.message : String(error),
        },
        recommendation:
          'Verify Horizon connectivity and that /fee_stats is available.',
      });
      return;
    }

    if (!stats || typeof stats !== 'object') {
      findings.push({
        code: 'horizon-fee-stats-malformed',
        severity: 'warning',
        message:
          'Horizon returned an empty or malformed fee statistics response.',
        recommendation:
          'Retry the audit or verify the Horizon endpoint version.',
      });
      return;
    }

    const lastLedgerBaseFee = safeString(
      (stats as Record<string, unknown>).last_ledger_base_fee,
    );
    const ledgerCapacityUsage = safeString(
      (stats as Record<string, unknown>).ledger_capacity_usage,
    );

    const feeCharged = (stats as Record<string, unknown>).fee_charged as
      | Record<string, unknown>
      | undefined;
    const maxFee = (stats as Record<string, unknown>).max_fee as
      | Record<string, unknown>
      | undefined;

    const minAcceptedFee = safeString(feeCharged?.min);
    const maxAcceptedFee = safeString(feeCharged?.max);
    const mode = safeString(feeCharged?.mode);
    const recommendedFee = safeString(maxFee?.min);

    const hasAnyField =
      lastLedgerBaseFee !== null ||
      ledgerCapacityUsage !== null ||
      minAcceptedFee !== null ||
      maxAcceptedFee !== null ||
      mode !== null ||
      recommendedFee !== null;

    if (!hasAnyField) {
      findings.push({
        code: 'horizon-fee-stats-empty',
        severity: 'warning',
        message:
          'Horizon fee statistics response contained no recognized fee fields.',
        evidence: { rawKeys: Object.keys(stats as Record<string, unknown>) },
        recommendation:
          'Verify the Horizon endpoint exposes the expected /fee_stats schema.',
      });
      return;
    }

    fees.available = true;
    fees.source = 'horizon:/fee_stats';
    fees.lastLedgerBaseFee = lastLedgerBaseFee;
    fees.ledgerCapacityUsage = ledgerCapacityUsage;
    fees.recommendedFee = recommendedFee;
    fees.minAcceptedFee = minAcceptedFee;
    fees.maxAcceptedFee = maxAcceptedFee;
    fees.mode = mode;

    findings.push({
      code: 'horizon-fee-stats-observed',
      severity: 'info',
      message:
        'Horizon fee statistics were retrieved. These are observations of ' +
        'recent network activity, not guaranteed inclusion prices.',
      evidence: {
        lastLedgerBaseFee,
        ledgerCapacityUsage,
        recommendedFee,
        minAcceptedFee,
        maxAcceptedFee,
        mode,
      },
    });
  }

  private async inspectHorizonLedger(
    client: Horizon.Server,
    protocol: ProtocolInfo,
    findings: AuditFinding[],
  ): Promise<void> {
    let ledger: HorizonLedger | null = null;
    try {
      ledger = await fetchHorizonLedger(client);
    } catch (error) {
      findings.push({
        code: 'horizon-ledger-error',
        severity: 'warning',
        message: 'Failed to retrieve the latest Horizon ledger.',
        evidence: {
          error: error instanceof Error ? error.message : String(error),
        },
        recommendation:
          'Verify Horizon connectivity and that /ledgers is available.',
      });
      return;
    }

    if (!ledger || typeof ledger !== 'object') {
      findings.push({
        code: 'horizon-ledger-malformed',
        severity: 'warning',
        message: 'Horizon returned an empty or malformed ledger response.',
        recommendation:
          'Retry the audit or verify the Horizon endpoint version.',
      });
      return;
    }

    const record = ledger as Record<string, unknown>;
    const protocolVersion = safeNumber(record.protocol_version);
    const coreVersion = safeString(record.core_version);

    protocol.horizonProtocolVersion = protocolVersion;
    protocol.horizonCoreVersion = coreVersion;

    if (protocolVersion === null) {
      findings.push({
        code: 'horizon-protocol-version-missing',
        severity: 'unknown',
        message:
          'Horizon ledger response did not include a protocol version field.',
        evidence: { rawKeys: Object.keys(record) },
      });
    } else {
      findings.push({
        code: 'horizon-protocol-version-observed',
        severity: 'info',
        message: `Horizon reports protocol version ${protocolVersion}.`,
        evidence: {
          protocolVersion,
          coreVersion,
        },
      });
    }
  }

  // -------------------------------------------------------------------
  // Soroban RPC inspection
  // -------------------------------------------------------------------

  private async inspectSorobanRpc(
    network: NetworkContext,
    protocol: ProtocolInfo,
    findings: AuditFinding[],
  ): Promise<void> {
    protocol.sorobanChecked = true;

    const url = network.sorobanRpcUrl as string;
    const provider =
      this.options.sorobanCapabilitiesProvider ?? getSorobanRpcCapabilities;

    let capabilities: SorobanRpcCapabilities | null = null;
    try {
      capabilities = await provider(url);
    } catch (error) {
      findings.push({
        code: 'soroban-rpc-error',
        severity: 'warning',
        message: 'Failed to retrieve Soroban RPC network information.',
        evidence: {
          sorobanRpcUrl: url,
          error: error instanceof Error ? error.message : String(error),
        },
        recommendation:
          'Verify the Soroban RPC endpoint is reachable and supports ' +
          'getNetwork/getVersion.',
      });
      return;
    }

    if (!capabilities || typeof capabilities !== 'object') {
      findings.push({
        code: 'soroban-rpc-malformed',
        severity: 'warning',
        message:
          'Soroban RPC returned an empty or malformed capabilities response.',
        recommendation:
          'Verify the Soroban RPC endpoint version and supported methods.',
      });
      return;
    }

    const caps = capabilities as Record<string, unknown>;

    const sorobanPassphrase = normalizePassphrase(
      safeString(caps.networkPassphrase ?? caps.passphrase),
    );
    const sorobanProtocolVersion = safeNumber(
      caps.protocolVersion ?? caps.protocol_version,
    );
    const sorobanSoftwareVersion = safeString(
      caps.softwareVersion ?? caps.version ?? caps.software_version,
    );

    protocol.sorobanPassphrase = sorobanPassphrase;
    protocol.sorobanProtocolVersion = sorobanProtocolVersion;
    protocol.sorobanSoftwareVersion = sorobanSoftwareVersion;

    const hasAnyField =
      sorobanPassphrase !== null ||
      sorobanProtocolVersion !== null ||
      sorobanSoftwareVersion !== null;

    if (!hasAnyField) {
      findings.push({
        code: 'soroban-metadata-unavailable',
        severity: 'unknown',
        message:
          'Soroban RPC did not expose recognized network or version metadata.',
        evidence: { rawKeys: Object.keys(caps) },
        recommendation:
          'Verify the Soroban RPC endpoint supports getNetwork and getVersion.',
      });
      return;
    }

    findings.push({
      code: 'soroban-metadata-observed',
      severity: 'info',
      message: 'Soroban RPC network and version metadata were retrieved.',
      evidence: {
        sorobanPassphrase,
        sorobanProtocolVersion,
        sorobanSoftwareVersion,
      },
    });
  }

  // -------------------------------------------------------------------
  // Cross-client passphrase comparison
  // -------------------------------------------------------------------

  private comparePassphrases(
    network: NetworkContext,
    protocol: ProtocolInfo,
    findings: AuditFinding[],
  ): void {
    const configured = network.networkPassphrase;

    if (configured && protocol.sorobanPassphrase) {
      if (configured !== protocol.sorobanPassphrase) {
        findings.push({
          code: 'soroban-passphrase-mismatch',
          severity: 'confirmed-mismatch',
          message:
            'Configured network passphrase does not match the Soroban RPC ' +
            'network passphrase.',
          evidence: {
            configuredPassphrase: configured,
            sorobanPassphrase: protocol.sorobanPassphrase,
          },
          recommendation:
            'Ensure the Soroban RPC endpoint targets the same network as the ' +
            'configured passphrase.',
        });
      } else {
        findings.push({
          code: 'soroban-passphrase-match',
          severity: 'info',
          message:
            'Configured network passphrase matches the Soroban RPC network ' +
            'passphrase.',
          evidence: { passphrase: configured },
        });
      }
    } else if (configured && protocol.sorobanChecked && !protocol.sorobanPassphrase) {
      findings.push({
        code: 'soroban-passphrase-unavailable',
        severity: 'unknown',
        message:
          'Soroban RPC did not expose a network passphrase; cross-client ' +
          'consistency could not be verified.',
      });
    }
  }

  // -------------------------------------------------------------------
  // Protocol capability assessment
  // -------------------------------------------------------------------

  private assessProtocolCapabilities(
    protocol: ProtocolInfo,
    findings: AuditFinding[],
  ): void {
    // Guard: never infer protocol capabilities from version numbers alone.
    if (
      protocol.horizonProtocolVersion !== null ||
      protocol.sorobanProtocolVersion !== null ||
      protocol.sorobanSoftwareVersion !== null
    ) {
      findings.push({
        code: 'protocol-capabilities-not-inferred',
        severity: 'unknown',
        message:
          'Protocol and software version numbers were observed, but version ' +
          'numbers alone do not prove support for every protocol feature. ' +
          'Capability support must be verified per operation.',
        evidence: {
          horizonProtocolVersion: protocol.horizonProtocolVersion,
          sorobanProtocolVersion: protocol.sorobanProtocolVersion,
          sorobanSoftwareVersion: protocol.sorobanSoftwareVersion,
        },
        recommendation:
          'Verify support for the specific operations you intend to use ' +
          'against the target network before relying on the audit results.',
      });
    }

    if (
      protocol.horizonProtocolVersion === null &&
      protocol.sorobanProtocolVersion === null
    ) {
      findings.push({
        code: 'protocol-version-unavailable',
        severity: 'unknown',
        message:
          'No protocol version information was available from any configured ' +
          'endpoint.',
        recommendation:
          'Configure a reachable Horizon or Soroban RPC endpoint to obtain ' +
          'protocol version information.',
      });
    }
  }

  // -------------------------------------------------------------------
  // Status determination
  // -------------------------------------------------------------------

  private determineStatus(
    findings: AuditFinding[],
    fees: FeeObservation,
    protocol: ProtocolInfo,
    network: NetworkContext,
  ): AuditStatus {
    const hasMismatch = findings.some(
      (f) => f.severity === 'confirmed-mismatch',
    );
    const hasError = findings.some((f) => f.severity === 'error');
    const hasWarning = findings.some((f) => f.severity === 'warning');
    const hasUnknown = findings.some((f) => f.severity === 'unknown');

    if (hasMismatch) {
      return 'mismatch';
    }
    if (hasError) {
      return 'error';
    }

    const hasAnyData =
      fees.available ||
      protocol.horizonProtocolVersion !== null ||
      protocol.sorobanProtocolVersion !== null ||
      network.networkPassphrase !== null;

    if (!hasAnyData) {
      return 'error';
    }

    if (hasWarning) {
      return 'warnings';
    }

    if (hasUnknown) {
      return 'partial';
    }

    return 'ok';
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Run the network fee and protocol compatibility audit.
 */
export async function auditNetworkFeeProtocol(
  options: NetworkFeeProtocolAuditOptions = {},
): Promise<NetworkFeeProtocolAuditResult> {
  const service = new NetworkFeeProtocolAuditService(options);
  return service.audit();
}

export default NetworkFeeProtocolAuditService;