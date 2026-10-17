/**
 * Network Fee & Protocol Compatibility Audit Inspector
 *
 * Read-only diagnostic inspector that wraps the network fee and protocol
 * compatibility audit service. It validates inputs, delegates to the service,
 * and provides a human-readable report formatter that clearly distinguishes
 * network fee observations from protocol compatibility findings and marks
 * unknown capabilities explicitly.
 *
 * This inspector never submits transactions and never modifies network
 * configuration.
 */

import {
  NetworkFeeProtocolAuditService,
  NetworkFeeProtocolAuditResult,
  NetworkFeeProtocolAuditFinding,
  NetworkFeeProtocolAuditSeverity,
  NetworkFeeProtocolAuditStatus,
  NetworkFeeProtocolAuditCategory,
  NetworkFeeProtocolAuditOptions,
  NetworkFeeProtocolAuditNetworkContext,
  NetworkFeeProtocolAuditFeeObservation,
  NetworkFeeProtocolAuditProtocolInfo,
} from '../services/network-fee-protocol-audit.service';

/**
 * Input accepted by the inspector. All fields are optional; the service falls
 * back to the project's existing configuration mechanisms where possible.
 */
export interface NetworkFeeProtocolAuditInspectorInput {
  /** Network name override (e.g. "testnet", "mainnet", "futurenet"). */
  network?: string;
  /** Network passphrase override. */
  networkPassphrase?: string;
  /** Horizon URL override. */
  horizonUrl?: string;
  /** Soroban RPC URL override. */
  sorobanRpcUrl?: string;
  /** Whether to include Soroban-specific checks when an RPC endpoint exists. */
  includeSoroban?: boolean;
  /** Whether to include fee statistics observations. */
  includeFeeStatistics?: boolean;
  /** Optional timeout (ms) for network calls. */
  timeoutMs?: number;
}

/**
 * Validation error raised when inspector input is structurally invalid.
 */
export class NetworkFeeProtocolAuditValidationError extends Error {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'NetworkFeeProtocolAuditValidationError';
    this.field = field;
  }
}

/**
 * Inspector wrapping the audit service. Provides input validation and a
 * human-readable formatter.
 */
export class NetworkFeeProtocolAuditInspector {
  private readonly service: NetworkFeeProtocolAuditService;

  constructor(service?: NetworkFeeProtocolAuditService) {
    this.service = service ?? new NetworkFeeProtocolAuditService();
  }

  /**
   * Validate inspector input. Throws NetworkFeeProtocolAuditValidationError on
   * structurally invalid input. Missing optional fields are allowed and are
   * reported as findings by the service rather than rejected here.
   */
  public validateInput(input: NetworkFeeProtocolAuditInspectorInput = {}): void {
    if (input === null || typeof input !== 'object') {
      throw new NetworkFeeProtocolAuditValidationError(
        'Audit input must be an object.',
      );
    }

    if (input.network !== undefined) {
      if (typeof input.network !== 'string' || input.network.trim().length === 0) {
        throw new NetworkFeeProtocolAuditValidationError(
          'Network name must be a non-empty string when provided.',
          'network',
        );
      }
    }

    if (input.networkPassphrase !== undefined) {
      if (
        typeof input.networkPassphrase !== 'string' ||
        input.networkPassphrase.trim().length === 0
      ) {
        throw new NetworkFeeProtocolAuditValidationError(
          'Network passphrase must be a non-empty string when provided.',
          'networkPassphrase',
        );
      }
    }

    if (input.horizonUrl !== undefined) {
      this.validateUrl(input.horizonUrl, 'horizonUrl');
    }

    if (input.sorobanRpcUrl !== undefined) {
      this.validateUrl(input.sorobanRpcUrl, 'sorobanRpcUrl');
    }

    if (input.includeSoroban !== undefined && typeof input.includeSoroban !== 'boolean') {
      throw new NetworkFeeProtocolAuditValidationError(
        'includeSoroban must be a boolean when provided.',
        'includeSoroban',
      );
    }

    if (
      input.includeFeeStatistics !== undefined &&
      typeof input.includeFeeStatistics !== 'boolean'
    ) {
      throw new NetworkFeeProtocolAuditValidationError(
        'includeFeeStatistics must be a boolean when provided.',
        'includeFeeStatistics',
      );
    }

    if (input.timeoutMs !== undefined) {
      if (
        typeof input.timeoutMs !== 'number' ||
        !Number.isFinite(input.timeoutMs) ||
        input.timeoutMs <= 0
      ) {
        throw new NetworkFeeProtocolAuditValidationError(
          'timeoutMs must be a positive finite number when provided.',
          'timeoutMs',
        );
      }
    }
  }

  /**
   * Run the audit. Validates input, delegates to the service, and returns the
   * structured result. Read-only: never submits transactions or mutates config.
   */
  public async run(
    input: NetworkFeeProtocolAuditInspectorInput = {},
  ): Promise<NetworkFeeProtocolAuditResult> {
    this.validateInput(input);

    const options: NetworkFeeProtocolAuditOptions = {
      network: input.network,
      networkPassphrase: input.networkPassphrase,
      horizonUrl: input.horizonUrl,
      sorobanRpcUrl: input.sorobanRpcUrl,
      includeSoroban: input.includeSoroban,
      includeFeeStatistics: input.includeFeeStatistics,
      timeoutMs: input.timeoutMs,
    };

    return this.service.audit(options);
  }

  /**
   * Run the audit and format the result as a human-readable report.
   */
  public async runAndFormat(
    input: NetworkFeeProtocolAuditInspectorInput = {},
  ): Promise<string> {
    const result = await this.run(input);
    return this.format(result);
  }

  /**
   * Format a structured audit result into a human-readable report that
   * distinguishes network fee observations from protocol compatibility
   * findings and clearly marks unknown capabilities.
   */
  public format(result: NetworkFeeProtocolAuditResult): string {
    const lines: string[] = [];

    lines.push('Stellar Network Fee & Protocol Compatibility Audit');
    lines.push('==================================================');
    lines.push('');
    lines.push(`Overall status: ${this.formatStatus(result.status)}`);
    lines.push('');

    // Network context
    lines.push('Network Context');
    lines.push('---------------');
    lines.push(...this.formatNetworkContext(result.networkContext));
    lines.push('');

    // Fee observations (distinct from compatibility findings)
    lines.push('Network Fee Observations');
    lines.push('------------------------');
    lines.push(
      'Note: fee statistics are observations of recent network activity and are',
    );
    lines.push(
      'not guarantees of transaction inclusion prices.',
    );
    lines.push('');
    lines.push(...this.formatFeeObservations(result.feeObservations));
    lines.push('');

    // Protocol information
    lines.push('Protocol Information');
    lines.push('--------------------');
    lines.push(...this.formatProtocolInfo(result.protocolInfo));
    lines.push('');

    // Compatibility findings
    lines.push('Compatibility Findings');
    lines.push('----------------------');
    lines.push(...this.formatFindings(result.findings));
    lines.push('');

    // Summary counts
    lines.push('Summary');
    lines.push('-------');
    lines.push(...this.formatSummary(result));

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private validateUrl(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new NetworkFeeProtocolAuditValidationError(
        `${field} must be a non-empty string when provided.`,
        field,
      );
    }
    try {
      // eslint-disable-next-line no-new
      new URL(value);
    } catch {
      throw new NetworkFeeProtocolAuditValidationError(
        `${field} must be a valid URL when provided.`,
        field,
      );
    }
  }

  private formatStatus(status: NetworkFeeProtocolAuditStatus): string {
    switch (status) {
      case 'ok':
        return 'OK';
      case 'warning':
        return 'WARNING';
      case 'error':
        return 'ERROR';
      case 'partial':
        return 'PARTIAL';
      case 'unknown':
        return 'UNKNOWN';
      default:
        return String(status).toUpperCase();
    }
  }

  private formatNetworkContext(
    context: NetworkFeeProtocolAuditNetworkContext | undefined,
  ): string[] {
    const lines: string[] = [];
    if (!context) {
      lines.push('  (network context unavailable)');
      return lines;
    }

    lines.push(`  Network name:        ${context.networkName ?? '(not configured)'}`);
    lines.push(
      `  Network passphrase:  ${
        context.networkPassphrase
          ? this.maskPassphrase(context.networkPassphrase)
          : '(not configured)'
      }`,
    );
    lines.push(`  Horizon URL:         ${context.horizonUrl ?? '(not configured)'}`);
    lines.push(
      `  Soroban RPC URL:     ${context.sorobanRpcUrl ?? '(not configured)'}`,
    );

    if (context.horizonReachable !== undefined) {
      lines.push(
        `  Horizon reachable:   ${context.horizonReachable ? 'yes' : 'no'}`,
      );
    }
    if (context.sorobanReachable !== undefined) {
      lines.push(
        `  Soroban reachable:   ${context.sorobanReachable ? 'yes' : 'no'}`,
      );
    }
    if (context.passphraseMatches !== undefined) {
      lines.push(
        `  Passphrase matches:  ${
          context.passphraseMatches ? 'yes' : 'NO (mismatch)'
        }`,
      );
    }

    return lines;
  }

  private formatFeeObservations(
    observations: NetworkFeeProtocolAuditFeeObservation[] | undefined,
  ): string[] {
    const lines: string[] = [];
    if (!observations || observations.length === 0) {
      lines.push('  (no fee observations available)');
      return lines;
    }

    for (const obs of observations) {
      lines.push(`  Source: ${obs.source}`);
      if (obs.available) {
        if (obs.lastLedgerBaseFee !== undefined) {
          lines.push(`    Last ledger base fee: ${obs.lastLedgerBaseFee} stroops`);
        }
        if (obs.ledgerCapacityUsage !== undefined) {
          lines.push(`    Ledger capacity usage: ${obs.ledgerCapacityUsage}`);
        }
        if (obs.feeCharged !== undefined) {
          lines.push(`    Fee charged (recent): ${obs.feeCharged} stroops`);
        }
        if (obs.maxFee !== undefined) {
          lines.push(`    Max fee (recent): ${obs.maxFee} stroops`);
        }
        if (obs.minFee !== undefined) {
          lines.push(`    Min fee (recent): ${obs.minFee} stroops`);
        }
        if (obs.mode !== undefined) {
          lines.push(`    Mode: ${obs.mode}`);
        }
        if (obs.p90 !== undefined) {
          lines.push(`    p90: ${obs.p90} stroops`);
        }
        if (obs.p99 !== undefined) {
          lines.push(`    p99: ${obs.p99} stroops`);
        }
        if (obs.observedAt !== undefined) {
          lines.push(`    Observed at: ${obs.observedAt}`);
        }
        if (obs.notes && obs.notes.length > 0) {
          for (const note of obs.notes) {
            lines.push(`    Note: ${note}`);
          }
        }
      } else {
        lines.push(
          `    (unavailable${obs.reason ? `: ${obs.reason}` : ''})`,
        );
      }
      lines.push('');
    }

    // Trim trailing blank line
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  private formatProtocolInfo(
    info: NetworkFeeProtocolAuditProtocolInfo | undefined,
  ): string[] {
    const lines: string[] = [];
    if (!info) {
      lines.push('  (protocol information unavailable)');
      return lines;
    }

    lines.push(
      `  Horizon protocol version: ${
        info.horizonProtocolVersion !== undefined
          ? info.horizonProtocolVersion
          : '(unknown)'
      }`,
    );
    lines.push(
      `  Horizon core version:     ${
        info.horizonCoreVersion ?? '(unknown)'
      }`,
    );
    lines.push(
      `  Soroban protocol version: ${
        info.sorobanProtocolVersion !== undefined
          ? info.sorobanProtocolVersion
          : '(unknown)'
      }`,
    );
    lines.push(
      `  Soroban software version: ${
        info.sorobanSoftwareVersion ?? '(unknown)'
      }`,
    );
    lines.push(
      `  SDK supported protocol:   ${
        info.sdkSupportedProtocolVersion !== undefined
          ? info.sdkSupportedProtocolVersion
          : '(unknown)'
      }`,
    );

    if (info.unknownCapabilities && info.unknownCapabilities.length > 0) {
      lines.push('  Unknown capabilities:');
      for (const cap of info.unknownCapabilities) {
        lines.push(`    - ${cap} (unknown)`);
      }
    }

    if (info.notes && info.notes.length > 0) {
      for (const note of info.notes) {
        lines.push(`  Note: ${note}`);
      }
    }

    return lines;
  }

  private formatFindings(
    findings: NetworkFeeProtocolAuditFinding[] | undefined,
  ): string[] {
    const lines: string[] = [];
    if (!findings || findings.length === 0) {
      lines.push('  (no compatibility findings)');
      return lines;
    }

    // Group by severity for readability
    const order: NetworkFeeProtocolAuditSeverity[] = [
      'error',
      'warning',
      'info',
      'unknown',
    ];

    const grouped = new Map<NetworkFeeProtocolAuditSeverity, NetworkFeeProtocolAuditFinding[]>();
    for (const f of findings) {
      const list = grouped.get(f.severity) ?? [];
      list.push(f);
      grouped.set(f.severity, list);
    }

    for (const severity of order) {
      const list = grouped.get(severity);
      if (!list || list.length === 0) {
        continue;
      }
      lines.push(`  [${severity.toUpperCase()}]`);
      for (const finding of list) {
        lines.push(`    - ${finding.message}`);
        if (finding.category) {
          lines.push(`      Category: ${this.formatCategory(finding.category)}`);
        }
        if (finding.evidence) {
          lines.push(`      Evidence: ${finding.evidence}`);
        }
        if (finding.recommendation) {
          lines.push(`      Recommended: ${finding.recommendation}`);
        }
      }
      lines.push('');
    }

    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  private formatCategory(category: NetworkFeeProtocolAuditCategory): string {
    switch (category) {
      case 'network-config':
        return 'network configuration';
      case 'passphrase':
        return 'network passphrase';
      case 'fee':
        return 'fee observation';
      case 'protocol':
        return 'protocol compatibility';
      case 'soroban':
        return 'Soroban RPC';
      case 'sdk':
        return 'SDK capability';
      default:
        return String(category);
    }
  }

  private formatSummary(result: NetworkFeeProtocolAuditResult): string[] {
    const lines: string[] = [];
    const findings = result.findings ?? [];

    const counts = {
      error: 0,
      warning: 0,
      info: 0,
      unknown: 0,
    };

    for (const f of findings) {
      if (f.severity in counts) {
        counts[f.severity as keyof typeof counts] += 1;
      }
    }

    lines.push(`  Errors:   ${counts.error}`);
    lines.push(`  Warnings: ${counts.warning}`);
    lines.push(`  Info:     ${counts.info}`);
    lines.push(`  Unknown:  ${counts.unknown}`);

    if (result.notes && result.notes.length > 0) {
      lines.push('');
      for (const note of result.notes) {
        lines.push(`  Note: ${note}`);
      }
    }

    return lines;
  }

  /**
   * Mask a passphrase for display while still allowing the user to verify it.
   * We show the first and last few characters so users can confirm identity
   * without printing the full value in logs.
   */
  private maskPassphrase(passphrase: string): string {
    if (passphrase.length <= 8) {
      return passphrase;
    }
    const head = passphrase.slice(0, 4);
    const tail = passphrase.slice(-4);
    return `${head}…${tail}`;
  }
}

export default NetworkFeeProtocolAuditInspector;