import {
  Sep30RecoveryService,
  Sep30RecoveryAccountResponse,
  Sep30Signer,
} from '../services/sep30-recovery-service';
import { HorizonClient } from '../clients/horizon-client';
import {
  AccountSigner,
  AccountThresholds,
  AccountResponse,
} from '../types/stellar';

/**
 * Severity levels for audit findings.
 */
export type Sep30QuorumFindingSeverity =
  | 'info'
  | 'warning'
  | 'error'
  | 'critical';

/**
 * Overall audit status for the SEP-30 quorum audit.
 */
export type Sep30QuorumAuditStatus =
  | 'pass'
  | 'warning'
  | 'insufficient-quorum'
  | 'inconclusive'
  | 'error';

/**
 * A single finding produced by the SEP-30 quorum audit.
 */
export interface Sep30QuorumFinding {
  code: string;
  severity: Sep30QuorumFindingSeverity;
  message: string;
  evidence?: Record<string, unknown>;
}

/**
 * Classification of a signer key relative to the recovery configuration.
 */
export type Sep30SignerComparisonStatus =
  | 'matching'
  | 'missing-on-chain'
  | 'additional-on-chain'
  | 'invalid';

/**
 * Comparison entry for a single signer key.
 */
export interface Sep30SignerComparisonEntry {
  key: string;
  status: Sep30SignerComparisonStatus;
  recoveryWeight?: number;
  onChainWeight?: number;
  note?: string;
}

/**
 * Threshold feasibility result for a single threshold.
 */
export interface Sep30ThresholdFeasibility {
  thresholdName: 'low' | 'medium' | 'high';
  thresholdValue: number;
  availableWeight: number;
  feasible: boolean;
  shortfall: number;
}

/**
 * Summary of the account thresholds.
 */
export interface Sep30ThresholdSummary {
  low: number;
  medium: number;
  high: number;
}

/**
 * Full result of a SEP-30 quorum audit.
 */
export interface Sep30QuorumAuditResult {
  accountId: string;
  status: Sep30QuorumAuditStatus;
  thresholds: Sep30ThresholdSummary;
  signerComparison: Sep30SignerComparisonEntry[];
  thresholdFeasibility: Sep30ThresholdFeasibility[];
  findings: Sep30QuorumFinding[];
  recoverySignerCount: number;
  onChainSignerCount: number;
  matchingSignerCount: number;
  /**
   * Explicit disclaimer clarifying that a successful quorum calculation does
   * not guarantee successful SEP-30 recovery or authorization of every
   * transaction.
   */
  disclaimer: string;
}

/**
 * Options for the SEP-30 quorum audit.
 */
export interface Sep30QuorumAuditOptions {
  /**
   * The Stellar account ID to audit.
   */
  accountId: string;
  /**
   * The SEP-30 recovery account response supplied by the caller.
   */
  recoveryResponse: Sep30RecoveryAccountResponse;
}

const DISCLAIMER =
  'A successful quorum calculation indicates that the matching recovery ' +
  'signer weights can satisfy the account thresholds. It does not guarantee ' +
  'successful SEP-30 recovery, nor does it verify that any particular ' +
  'recovery transaction will be authorized under the recovery service policy.';

/**
 * Validates a Stellar account ID using the standard StrKey format check.
 * This is a lightweight structural validation and does not confirm the
 * account exists on-chain.
 */
export function isValidStellarAccountId(accountId: unknown): accountId is string {
  if (typeof accountId !== 'string') {
    return false;
  }
  const trimmed = accountId.trim();
  if (trimmed.length !== 56) {
    return false;
  }
  if (!trimmed.startsWith('G')) {
    return false;
  }
  return /^[A-Z2-7]+$/.test(trimmed);
}

/**
 * Validates a Stellar signer key. Signer keys may be ed25519 public keys
 * (starting with G), pre-auth transaction hashes (starting with T), or
 * signed payloads (starting with X). We accept the standard StrKey prefixes.
 */
export function isValidSignerKey(key: unknown): key is string {
  if (typeof key !== 'string') {
    return false;
  }
  const trimmed = key.trim();
  if (trimmed.length !== 56) {
    return false;
  }
  const prefix = trimmed.charAt(0);
  if (prefix !== 'G' && prefix !== 'T' && prefix !== 'X') {
    return false;
  }
  return /^[A-Z2-7]+$/.test(trimmed);
}

function normalizeWeight(weight: unknown): number | undefined {
  if (typeof weight === 'number' && Number.isInteger(weight) && weight >= 0) {
    return weight;
  }
  if (typeof weight === 'string' && /^\d+$/.test(weight)) {
    const parsed = Number.parseInt(weight, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function extractRecoverySigners(
  response: Sep30RecoveryAccountResponse,
): { signers: Sep30Signer[]; findings: Sep30QuorumFinding[] } {
  const findings: Sep30QuorumFinding[] = [];
  const signers: Sep30Signer[] = [];

  if (!response || typeof response !== 'object') {
    findings.push({
      code: 'SEP30_UNSUPPORTED_RESPONSE',
      severity: 'error',
      message:
        'The supplied SEP-30 recovery account response is not a supported object.',
    });
    return { signers, findings };
  }

  const rawSigners = (response as { signers?: unknown }).signers;

  if (rawSigners === undefined || rawSigners === null) {
    findings.push({
      code: 'SEP30_MISSING_SIGNERS',
      severity: 'warning',
      message:
        'The SEP-30 recovery account response does not include a signers field.',
    });
    return { signers, findings };
  }

  if (!Array.isArray(rawSigners)) {
    findings.push({
      code: 'SEP30_UNSUPPORTED_SIGNERS_FORMAT',
      severity: 'error',
      message:
        'The SEP-30 recovery account response signers field is not an array.',
    });
    return { signers, findings };
  }

  for (let i = 0; i < rawSigners.length; i += 1) {
    const entry = rawSigners[i] as Partial<Sep30Signer> | undefined;
    if (!entry || typeof entry !== 'object') {
      findings.push({
        code: 'SEP30_INVALID_SIGNER_ENTRY',
        severity: 'warning',
        message: `Signer entry at index ${i} is not a valid object.`,
        evidence: { index: i },
      });
      continue;
    }
    const key = (entry as { key?: unknown }).key;
    if (!isValidSignerKey(key)) {
      findings.push({
        code: 'SEP30_INVALID_SIGNER_KEY',
        severity: 'warning',
        message: `Signer entry at index ${i} has a malformed or missing key.`,
        evidence: { index: i },
      });
      continue;
    }
    const weight = normalizeWeight((entry as { weight?: unknown }).weight);
    if (weight === undefined) {
      findings.push({
        code: 'SEP30_INVALID_SIGNER_WEIGHT',
        severity: 'warning',
        message: `Signer entry at index ${i} has a malformed or missing weight.`,
        evidence: { index: i, key },
      });
      continue;
    }
    signers.push({ key, weight });
  }

  if (signers.length === 0 && rawSigners.length > 0) {
    findings.push({
      code: 'SEP30_NO_USABLE_SIGNERS',
      severity: 'warning',
      message:
        'The SEP-30 recovery account response did not contain any usable signer entries.',
    });
  }

  return { signers, findings };
}

function extractOnChainSigners(
  account: AccountResponse,
): { signers: AccountSigner[]; findings: Sep30QuorumFinding[] } {
  const findings: Sep30QuorumFinding[] = [];
  const signers: AccountSigner[] = [];

  const rawSigners = account?.signers;
  if (!Array.isArray(rawSigners)) {
    findings.push({
      code: 'HORIZON_MISSING_SIGNERS',
      severity: 'error',
      message:
        'The on-chain account response did not include a signers array.',
    });
    return { signers, findings };
  }

  for (let i = 0; i < rawSigners.length; i += 1) {
    const entry = rawSigners[i] as Partial<AccountSigner> | undefined;
    if (!entry || typeof entry !== 'object') {
      findings.push({
        code: 'HORIZON_INVALID_SIGNER_ENTRY',
        severity: 'warning',
        message: `On-chain signer entry at index ${i} is not a valid object.`,
        evidence: { index: i },
      });
      continue;
    }
    const key = (entry as { key?: unknown }).key;
    if (!isValidSignerKey(key)) {
      findings.push({
        code: 'HORIZON_INVALID_SIGNER_KEY',
        severity: 'warning',
        message: `On-chain signer entry at index ${i} has a malformed or missing key.`,
        evidence: { index: i },
      });
      continue;
    }
    const weight = normalizeWeight((entry as { weight?: unknown }).weight);
    if (weight === undefined) {
      findings.push({
        code: 'HORIZON_INVALID_SIGNER_WEIGHT',
        severity: 'warning',
        message: `On-chain signer entry at index ${i} has a malformed or missing weight.`,
        evidence: { index: i, key },
      });
      continue;
    }
    signers.push({ key, weight });
  }

  return { signers, findings };
}

function extractThresholds(
  account: AccountResponse,
): { thresholds: Sep30ThresholdSummary; findings: Sep30QuorumFinding[] } {
  const findings: Sep30QuorumFinding[] = [];
  const raw = account?.thresholds as Partial<AccountThresholds> | undefined;

  const low = normalizeWeight(raw?.low);
  const medium = normalizeWeight(raw?.medium);
  const high = normalizeWeight(raw?.high);

  if (low === undefined || medium === undefined || high === undefined) {
    findings.push({
      code: 'HORIZON_MISSING_THRESHOLDS',
      severity: 'error',
      message:
        'The on-chain account response did not include complete low, medium, and high thresholds.',
      evidence: {
        low: raw?.low,
        medium: raw?.medium,
        high: raw?.high,
      },
    });
    return {
      thresholds: {
        low: low ?? 0,
        medium: medium ?? 0,
        high: high ?? 0,
      },
      findings,
    };
  }

  return { thresholds: { low, medium, high }, findings };
}

function compareSigners(
  recoverySigners: Sep30Signer[],
  onChainSigners: AccountSigner[],
): Sep30SignerComparisonEntry[] {
  const onChainByKey = new Map<string, number>();
  for (const signer of onChainSigners) {
    onChainByKey.set(signer.key, signer.weight);
  }

  const recoveryByKey = new Map<string, number>();
  for (const signer of recoverySigners) {
    recoveryByKey.set(signer.key, signer.weight);
  }

  const entries: Sep30SignerComparisonEntry[] = [];

  for (const signer of recoverySigners) {
    const onChainWeight = onChainByKey.get(signer.key);
    if (onChainWeight === undefined) {
      entries.push({
        key: signer.key,
        status: 'missing-on-chain',
        recoveryWeight: signer.weight,
        note: 'Recovery signer is not present in the current on-chain signer configuration.',
      });
    } else {
      entries.push({
        key: signer.key,
        status: 'matching',
        recoveryWeight: signer.weight,
        onChainWeight,
        note:
          signer.weight === onChainWeight
            ? 'Recovery signer weight matches the on-chain weight.'
            : 'Recovery signer weight differs from the on-chain weight.',
      });
    }
  }

  for (const signer of onChainSigners) {
    if (!recoveryByKey.has(signer.key)) {
      entries.push({
        key: signer.key,
        status: 'additional-on-chain',
        onChainWeight: signer.weight,
        note: 'On-chain signer is not reported by the recovery service.',
      });
    }
  }

  return entries;
}

function computeThresholdFeasibility(
  thresholds: Sep30ThresholdSummary,
  matchingWeight: number,
): Sep30ThresholdFeasibility[] {
  const names: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
  return names.map((name) => {
    const thresholdValue = thresholds[name];
    const feasible = matchingWeight >= thresholdValue;
    return {
      thresholdName: name,
      thresholdValue,
      availableWeight: matchingWeight,
      feasible,
      shortfall: feasible ? 0 : thresholdValue - matchingWeight,
    };
  });
}

/**
 * SEP-30 recovery signer quorum and authorization audit.
 *
 * This inspector is strictly read-only. It retrieves the current on-chain
 * signer configuration through the Horizon client and compares it with an
 * explicitly supplied SEP-30 recovery account response. It performs no
 * recovery actions and makes no on-chain changes.
 */
export class Sep30QuorumAuditInspector {
  private readonly recoveryService: Sep30RecoveryService;
  private readonly horizonClient: HorizonClient;

  constructor(
    recoveryService: Sep30RecoveryService,
    horizonClient: HorizonClient,
  ) {
    this.recoveryService = recoveryService;
    this.horizonClient = horizonClient;
  }

  /**
   * Runs the quorum audit for the supplied account and recovery response.
   */
  async audit(options: Sep30QuorumAuditOptions): Promise<Sep30QuorumAuditResult> {
    const findings: Sep30QuorumFinding[] = [];

    const accountId = options?.accountId;
    if (!isValidStellarAccountId(accountId)) {
      findings.push({
        code: 'INVALID_ACCOUNT_ID',
        severity: 'error',
        message:
          'The supplied account ID is not a structurally valid Stellar account ID.',
      });
      return this.buildResult({
        accountId: typeof accountId === 'string' ? accountId : '',
        status: 'error',
        thresholds: { low: 0, medium: 0, high: 0 },
        signerComparison: [],
        thresholdFeasibility: [],
        findings,
        recoverySignerCount: 0,
        onChainSignerCount: 0,
        matchingSignerCount: 0,
      });
    }

    const { signers: recoverySigners, findings: recoveryFindings } =
      extractRecoverySigners(options.recoveryResponse);
    findings.push(...recoveryFindings);

    let account: AccountResponse;
    try {
      account = await this.horizonClient.getAccount(accountId);
    } catch (error) {
      findings.push({
        code: 'HORIZON_RETRIEVAL_FAILED',
        severity: 'error',
        message:
          'Failed to retrieve the on-chain account configuration from Horizon.',
        evidence: {
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return this.buildResult({
        accountId,
        status: 'error',
        thresholds: { low: 0, medium: 0, high: 0 },
        signerComparison: [],
        thresholdFeasibility: [],
        findings,
        recoverySignerCount: recoverySigners.length,
        onChainSignerCount: 0,
        matchingSignerCount: 0,
      });
    }

    const { signers: onChainSigners, findings: onChainFindings } =
      extractOnChainSigners(account);
    findings.push(...onChainFindings);

    const { thresholds, findings: thresholdFindings } =
      extractThresholds(account);
    findings.push(...thresholdFindings);

    const signerComparison = compareSigners(recoverySigners, onChainSigners);

    const matchingSignerCount = signerComparison.filter(
      (entry) => entry.status === 'matching',
    ).length;

    // Compute available weight using the on-chain weights of matching signers.
    // We use the on-chain weight because that is the authoritative value for
    // threshold evaluation.
    let matchingWeight = 0;
    for (const entry of signerComparison) {
      if (entry.status === 'matching' && typeof entry.onChainWeight === 'number') {
        matchingWeight += entry.onChainWeight;
      }
    }

    const thresholdFeasibility = computeThresholdFeasibility(
      thresholds,
      matchingWeight,
    );

    const missingOnChain = signerComparison.filter(
      (entry) => entry.status === 'missing-on-chain',
    );
    if (missingOnChain.length > 0) {
      findings.push({
        code: 'RECOVERY_SIGNERS_NOT_ON_CHAIN',
        severity: 'warning',
        message:
          'One or more recovery signers are not present in the current on-chain signer configuration.',
        evidence: {
          count: missingOnChain.length,
          keys: missingOnChain.map((entry) => entry.key),
        },
      });
    }

    const additionalOnChain = signerComparison.filter(
      (entry) => entry.status === 'additional-on-chain',
    );
    if (additionalOnChain.length > 0) {
      findings.push({
        code: 'ON_CHAIN_SIGNERS_NOT_IN_RECOVERY',
        severity: 'info',
        message:
          'The on-chain signer configuration includes signers not reported by the recovery service.',
        evidence: {
          count: additionalOnChain.length,
          keys: additionalOnChain.map((entry) => entry.key),
        },
      });
    }

    const infeasible = thresholdFeasibility.filter((entry) => !entry.feasible);
    for (const entry of infeasible) {
      findings.push({
        code: `THRESHOLD_INFEASIBLE_${entry.thresholdName.toUpperCase()}`,
        severity: 'warning',
        message: `Matching recovery signer weight (${entry.availableWeight}) is below the ${entry.thresholdName} threshold (${entry.thresholdValue}).`,
        evidence: {
          thresholdName: entry.thresholdName,
          thresholdValue: entry.thresholdValue,
          availableWeight: entry.availableWeight,
          shortfall: entry.shortfall,
        },
      });
    }

    let status: Sep30QuorumAuditStatus;
    if (recoverySigners.length === 0) {
      status = 'inconclusive';
      findings.push({
        code: 'INCONCLUSIVE_RECOVERY_CONFIGURATION',
        severity: 'warning',
        message:
          'No usable recovery signer information was available, so threshold feasibility could not be evaluated.',
      });
    } else if (infeasible.length > 0) {
      status = 'insufficient-quorum';
    } else if (findings.some((f) => f.severity === 'warning')) {
      status = 'warning';
    } else {
      status = 'pass';
    }

    return this.buildResult({
      accountId,
      status,
      thresholds,
      signerComparison,
      thresholdFeasibility,
      findings,
      recoverySignerCount: recoverySigners.length,
      onChainSignerCount: onChainSigners.length,
      matchingSignerCount,
    });
  }

  private buildResult(
    partial: Omit<Sep30QuorumAuditResult, 'disclaimer'>,
  ): Sep30QuorumAuditResult {
    return {
      ...partial,
      disclaimer: DISCLAIMER,
    };
  }
}

/**
 * Formats a SEP-30 quorum audit result into a human-readable report.
 */
export function formatSep30QuorumAuditReport(
  result: Sep30QuorumAuditResult,
): string {
  const lines: string[] = [];
  lines.push('SEP-30 Recovery Signer Quorum Audit');
  lines.push('==================================');
  lines.push(`Account: ${result.accountId || '(unknown)'}`);
  lines.push(`Status: ${result.status}`);
  lines.push('');
  lines.push('Thresholds');
  lines.push('----------');
  lines.push(`  low:    ${result.thresholds.low}`);
  lines.push(`  medium: ${result.thresholds.medium}`);
  lines.push(`  high:   ${result.thresholds.high}`);
  lines.push('');
  lines.push('Threshold Feasibility');
  lines.push('---------------------');
  if (result.thresholdFeasibility.length === 0) {
    lines.push('  (not evaluated)');
  } else {
    for (const entry of result.thresholdFeasibility) {
      const verdict = entry.feasible ? 'feasible' : `short by ${entry.shortfall}`;
      lines.push(
        `  ${entry.thresholdName.padEnd(6)} threshold=${entry.thresholdValue} available=${entry.availableWeight} -> ${verdict}`,
      );
    }
  }
  lines.push('');
  lines.push('Signer Comparison');
  lines.push('-----------------');
  lines.push(
    `  recovery signers: ${result.recoverySignerCount}, on-chain signers: ${result.onChainSignerCount}, matching: ${result.matchingSignerCount}`,
  );
  if (result.signerComparison.length === 0) {
    lines.push('  (no signer comparison available)');
  } else {
    for (const entry of result.signerComparison) {
      const parts: string[] = [`  [${entry.status}] ${entry.key}`];
      if (typeof entry.recoveryWeight === 'number') {
        parts.push(`recoveryWeight=${entry.recoveryWeight}`);
      }
      if (typeof entry.onChainWeight === 'number') {
        parts.push(`onChainWeight=${entry.onChainWeight}`);
      }
      lines.push(parts.join(' '));
      if (entry.note) {
        lines.push(`      ${entry.note}`);
      }
    }
  }
  lines.push('');
  lines.push('Findings');
  lines.push('--------');
  if (result.findings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
    }
  }
  lines.push('');
  lines.push('Note');
  lines.push('----');
  lines.push(`  ${result.disclaimer}`);
  return lines.join('\n');
}