/**
 * SEP-30 Recovery Signer Quorum and Authorization Audit
 *
 * Read-only diagnostic that compares a SEP-30 recovery account response with the
 * current on-chain signer configuration of a Stellar account (retrieved via Horizon).
 *
 * This module:
 *  - Extracts signer keys/weights from both the SEP-30 recovery response and the
 *    on-chain account response.
 *  - Computes matching / missing / additional signers.
 *  - Evaluates whether the matching signer weights can satisfy each of the
 *    low / medium / high thresholds using exact integer arithmetic.
 *  - Distinguishes an insufficient available signer weight from an unverified or
 *    incomplete recovery configuration.
 *
 * IMPORTANT: A successful quorum calculation does NOT guarantee that a particular
 * SEP-30 recovery transaction can be authorized. This feature performs no recovery
 * action and makes no on-chain changes.
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "error" | "critical";

export type AuditStatus =
  | "pass"
  | "warning"
  | "insufficient-quorum"
  | "inconclusive"
  | "error";

export interface AuditFinding {
  code: string;
  severity: Severity;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface SignerInfo {
  key: string;
  weight: number;
  /** Where the signer was observed. */
  source: "recovery" | "onchain" | "both";
}

export interface SignerComparison {
  matching: SignerInfo[];
  missing: SignerInfo[]; // present in recovery config, absent on-chain
  additional: SignerInfo[]; // present on-chain, absent from recovery config
}

export interface ThresholdFeasibility {
  threshold: number;
  /** Sum of matching signer weights available to satisfy this threshold. */
  availableWeight: number;
  /** Whether availableWeight >= threshold. */
  satisfied: boolean;
  /** Whether the recovery config was complete enough to make a determination. */
  conclusive: boolean;
}

export interface ThresholdSummary {
  low: ThresholdFeasibility;
  medium: ThresholdFeasibility;
  high: ThresholdFeasibility;
}

export interface Sep30QuorumAuditResult {
  accountId: string;
  status: AuditStatus;
  thresholds: ThresholdSummary;
  signerComparison: SignerComparison;
  findings: AuditFinding[];
  /** Human-readable disclaimer about the limits of this audit. */
  disclaimer: string;
  /** ISO timestamp of when the audit was performed. */
  auditedAt: string;
}

/**
 * Minimal shape of a SEP-30 recovery account response. SEP-30 responses may
 * vary; we accept a permissive structure and validate defensively.
 */
export interface Sep30RecoveryResponse {
  account?: string;
  signers?: Array<{ key?: string; weight?: number } | string>;
  [key: string]: unknown;
}

export interface Sep30QuorumAuditOptions {
  /** Stellar account ID (G...). */
  accountId: string;
  /** Parsed SEP-30 recovery account response. */
  recoveryResponse: Sep30RecoveryResponse | string;
  /** Optional Horizon server URL. Defaults to the SDK's public network. */
  horizonUrl?: string;
  /** Optional pre-constructed Horizon server (useful for testing). */
  server?: Horizon.Server;
  /** Optional logger. Defaults to a redacting console logger. */
  logger?: AuditLogger;
}

export interface AuditLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCLAIMER =
  "This audit is a read-only diagnostic. A satisfied quorum calculation does " +
  "not guarantee that a SEP-30 recovery transaction will be authorized or that " +
  "recovery will succeed. Recovery success depends on the recovery service's " +
  "policy, the specific transaction being signed, and other factors not " +
  "evaluated here. No recovery action is performed and no on-chain changes are made.";

const DEFAULT_HORIZON_URL = "https://horizon.stellar.org";

/** Keys that must never be logged. */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passphrase|credential|auth|bearer|api[_-]?key|private)/i;

// ---------------------------------------------------------------------------
// Redacting logger
// ---------------------------------------------------------------------------

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact anything that looks like a secret token or long opaque string.
    if (value.length > 40) return "[REDACTED]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

function redactMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  return redactValue(meta) as Record<string, unknown>;
}

const defaultLogger: AuditLogger = {
  info(message, meta) {
    // eslint-disable-next-line no-console
    console.log(`[sep30-quorum-audit] ${message}`, redactMeta(meta) ?? "");
  },
  warn(message, meta) {
    // eslint-disable-next-line no-console
    console.warn(`[sep30-quorum-audit] ${message}`, redactMeta(meta) ?? "");
  },
  error(message, meta) {
    // eslint-disable-next-line no-console
    console.error(`[sep30-quorum-audit] ${message}`, redactMeta(meta) ?? "");
  },
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const STELLAR_ACCOUNT_ID = /^G[A-Z2-7]{55}$/;

export function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ACCOUNT_ID.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SEP-30 recovery response from either an object or a JSON string.
 * Returns null if the input cannot be parsed.
 */
export function parseRecoveryResponse(
  input: Sep30RecoveryResponse | string,
): Sep30RecoveryResponse | null {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Sep30RecoveryResponse;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return null;
}

interface ExtractedSigners {
  signers: Map<string, number>;
  /** True if the response contained a signers field we could interpret. */
  hasSignerData: boolean;
  /** True if some signer entries were malformed / skipped. */
  hasMalformedEntries: boolean;
  /** True if the response format is not supported. */
  unsupportedFormat: boolean;
}

/**
 * Extract signer keys and weights from a SEP-30 recovery response.
 * SEP-30 responses are not fully standardized across services, so we accept
 * a few common shapes and report when we cannot interpret the data.
 */
export function extractRecoverySigners(
  response: Sep30RecoveryResponse,
): ExtractedSigners {
  const signers = new Map<string, number>();
  let hasSignerData = false;
  let hasMalformedEntries = false;
  let unsupportedFormat = false;

  const raw = (response as Record<string, unknown>).signers;

  if (raw === undefined || raw === null) {
    // No signers field at all -> unsupported / incomplete.
    return { signers, hasSignerData: false, hasMalformedEntries: false, unsupportedFormat: true };
  }

  if (!Array.isArray(raw)) {
    return { signers, hasSignerData: false, hasMalformedEntries: false, unsupportedFormat: true };
  }

  hasSignerData = true;

  for (const entry of raw) {
    if (typeof entry === "string") {
      if (isValidAccountId(entry)) {
        // Default weight of 1 when only a key is provided.
        signers.set(entry, 1);
      } else {
        hasMalformedEntries = true;
      }
      continue;
    }

    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const key = obj.key ?? obj.public_key ?? obj.publicKey;
      const weight = obj.weight;

      if (!isValidAccountId(key)) {
        hasMalformedEntries = true;
        continue;
      }
      if (weight === undefined) {
        // Key present but no weight -> assume weight 1 but flag as malformed-ish.
        signers.set(key, 1);
        hasMalformedEntries = true;
        continue;
      }
      if (!isPositiveInteger(weight)) {
        hasMalformedEntries = true;
        continue;
      }
      signers.set(key, weight);
      continue;
    }

    hasMalformedEntries = true;
  }

  return { signers, hasSignerData, hasMalformedEntries, unsupportedFormat: false };
}

interface OnChainAccount {
  signers: Map<string, number>;
  thresholds: { low: number; medium: number; high: number };
}

/**
 * Extract signers and thresholds from a Horizon account response.
 */
export function extractOnChainAccount(account: Horizon.AccountResponse): OnChainAccount {
  const signers = new Map<string, number>();
  for (const s of account.signers ?? []) {
    if (isValidAccountId(s.key) && isPositiveInteger(s.weight)) {
      signers.set(s.key, s.weight);
    }
  }

  const t = account.thresholds ?? { low_threshold: 0, med_threshold: 0, high_threshold: 0 };
  return {
    signers,
    thresholds: {
      low: t.low_threshold ?? 0,
      medium: t.med_threshold ?? 0,
      high: t.high_threshold ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison & feasibility
// ---------------------------------------------------------------------------

export function compareSigners(
  recovery: Map<string, number>,
  onchain: Map<string, number>,
): SignerComparison {
  const matching: SignerInfo[] = [];
  const missing: SignerInfo[] = [];
  const additional: SignerInfo[] = [];

  for (const [key, weight] of recovery) {
    if (onchain.has(key)) {
      matching.push({ key, weight, source: "both" });
    } else {
      missing.push({ key, weight, source: "recovery" });
    }
  }

  for (const [key, weight] of onchain) {
    if (!recovery.has(key)) {
      additional.push({ key, weight, source: "onchain" });
    }
  }

  return { matching, missing, additional };
}

/**
 * Compute threshold feasibility using the weights of matching signers only.
 * Uses exact integer arithmetic (all weights and thresholds are integers).
 */
export function evaluateThreshold(
  threshold: number,
  matching: SignerInfo[],
  conclusive: boolean,
): ThresholdFeasibility {
  let availableWeight = 0;
  for (const s of matching) {
    availableWeight += s.weight;
  }
  return {
    threshold,
    availableWeight,
    satisfied: availableWeight >= threshold,
    conclusive,
  };
}

// ---------------------------------------------------------------------------
// Main audit
// ---------------------------------------------------------------------------

export async function auditSep30RecoveryQuorum(
  options: Sep30QuorumAuditOptions,
): Promise<Sep30QuorumAuditResult> {
  const logger = options.logger ?? defaultLogger;
  const findings: AuditFinding[] = [];
  const auditedAt = new Date().toISOString();

  const accountId = options.accountId;

  // --- Validate account id -------------------------------------------------
  if (!isValidAccountId(accountId)) {
    findings.push({
      code: "INVALID_ACCOUNT_ID",
      severity: "critical",
      message: "The supplied account ID is not a valid Stellar account ID.",
    });
    logger.error("Invalid account ID supplied to SEP-30 quorum audit");
    return {
      accountId: typeof accountId === "string" ? accountId : "",
      status: "error",
      thresholds: emptyThresholds(),
      signerComparison: { matching: [], missing: [], additional: [] },
      findings,
      disclaimer: DISCLAIMER,
      auditedAt,
    };
  }

  // --- Parse recovery response --------------------------------------------
  const recoveryResponse = parseRecoveryResponse(options.recoveryResponse);
  if (!recoveryResponse) {
    findings.push({
      code: "UNSUPPORTED_RECOVERY_RESPONSE",
      severity: "error",
      message:
        "The supplied SEP-30 recovery response could not be parsed. Expected a JSON object.",
    });
    logger.warn("Unparseable SEP-30 recovery response", { accountId });
    return {
      accountId,
      status: "inconclusive",
      thresholds: emptyThresholds(),
      signerComparison: { matching: [], missing: [], additional: [] },
      findings,
      disclaimer: DISCLAIMER,
      auditedAt,
    };
  }

  const extracted = extractRecoverySigners(recoveryResponse);

  if (extracted.unsupportedFormat) {
    findings.push({
      code: "UNSUPPORTED_RECOVERY_RESPONSE",
      severity: "error",
      message:
        "The SEP-30 recovery response does not contain a supported signers field. " +
        "Cannot evaluate signer quorum.",
    });
  } else if (!extracted.hasSignerData) {
    findings.push({
      code: "MISSING_SIGNER_DATA",
      severity: "warning",
      message: "The SEP-30 recovery response contains no signer information.",
    });
  }

  if (extracted.hasMalformedEntries) {
    findings.push({
      code: "MALFORMED_SIGNER_ENTRIES",
      severity: "warning",
      message:
        "Some signer entries in the SEP-30 recovery response were malformed or " +
        "missing weights and were skipped or defaulted.",
    });
  }

  // --- Fetch on-chain account ---------------------------------------------
  let onchain: OnChainAccount;
  try {
    const server =
      options.server ??
      new Horizon.Server(options.horizonUrl ?? DEFAULT_HORIZON_URL);
    const accountResponse = await server.accounts().accountId(accountId).call();
    onchain = extractOnChainAccount(accountResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: "HORIZON_RETRIEVAL_FAILED",
      severity: "error",
      message: `Failed to retrieve on-chain account from Horizon: ${message}`,
    });
    logger.error("Horizon retrieval failed during SEP-30 quorum audit", {
      accountId,
    });
    return {
      accountId,
      status: "error",
      thresholds: emptyThresholds(),
      signerComparison: { matching: [], missing: [], additional: [] },
      findings,
      disclaimer: DISCLAIMER,
      auditedAt,
    };
  }

  // --- Compare signers -----------------------------------------------------
  const comparison = compareSigners(extracted.signers, onchain.signers);

  if (comparison.missing.length > 0) {
    findings.push({
      code: "RECOVERY_SIGNERS_NOT_ONCHAIN",
      severity: "warning",
      message:
        `${comparison.missing.length} recovery signer(s) reported by the SEP-30 ` +
        "service do not appear in the current on-chain signer configuration.",
      evidence: { count: comparison.missing.length },
    });
  }

  if (comparison.additional.length > 0) {
    findings.push({
      code: "ONCHAIN_SIGNERS_NOT_IN_RECOVERY",
      severity: "info",
      message:
        `${comparison.additional.length} on-chain signer(s) are not reported by the ` +
        "SEP-30 recovery service.",
      evidence: { count: comparison.additional.length },
    });
  }

  if (comparison.matching.length === 0) {
    findings.push({
      code: "NO_MATCHING_SIGNERS",
      severity: "warning",
      message:
        "No recovery signer keys match the current on-chain signer configuration.",
    });
  }

  // --- Evaluate thresholds -------------------------------------------------
  // A determination is conclusive only when we have interpretable recovery
  // signer data. Otherwise we cannot distinguish insufficient weight from an
  // incomplete configuration.
  const conclusive = !extracted.unsupportedFormat && extracted.hasSignerData;

  const thresholds: ThresholdSummary = {
    low: evaluateThreshold(onchain.thresholds.low, comparison.matching, conclusive),
    medium: evaluateThreshold(onchain.thresholds.medium, comparison.matching, conclusive),
    high: evaluateThreshold(onchain.thresholds.high, comparison.matching, conclusive),
  };

  const thresholdEntries: Array<[keyof ThresholdSummary, ThresholdFeasibility]> = [
    ["low", thresholds.low],
    ["medium", thresholds.medium],
    ["high", thresholds.high],
  ];

  for (const [name, feasibility] of thresholdEntries) {
    if (!feasibility.conclusive) {
      findings.push({
        code: "THRESHOLD_INCONCLUSIVE",
        severity: "warning",
        message:
          `Cannot determine whether the ${name} threshold can be satisfied: ` +
          "the recovery configuration is incomplete or unsupported.",
        evidence: { threshold: feasibility.threshold },
      });
      continue;
    }
    if (!feasibility.satisfied) {
      findings.push({
        code: "INSUFFICIENT_QUORUM",
        severity: "warning",
        message:
          `Matching recovery signer weights (${feasibility.availableWeight}) are ` +
          `insufficient to satisfy the ${name} threshold (${feasibility.threshold}).`,
        evidence: {
          threshold: feasibility.threshold,
          availableWeight: feasibility.availableWeight,
        },
      });
    } else {
      findings.push({
        code: "THRESHOLD_SATISFIED",
        severity: "info",
        message:
          `Matching recovery signer weights (${feasibility.availableWeight}) satisfy ` +
          `the ${name} threshold (${feasibility.threshold}).`,
        evidence: {
          threshold: feasibility.threshold,
          availableWeight: feasibility.availableWeight,
        },
      });
    }
  }

  // --- Determine overall status -------------------------------------------
  const status = determineStatus(findings, thresholds, conclusive);

  logger.info("SEP-30 quorum audit completed", {
    accountId,
    status,
    matchingSigners: comparison.matching.length,
    missingSigners: comparison.missing.length,
    additionalSigners: comparison.additional.length,
  });

  return {
    accountId,
    status,
    thresholds,
    signerComparison: comparison,
    findings,
    disclaimer: DISCLAIMER,
    auditedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyThresholds(): ThresholdSummary {
  const empty = (): ThresholdFeasibility => ({
    threshold: 0,
    availableWeight: 0,
    satisfied: false,
    conclusive: false,
  });
  return { low: empty(), medium: empty(), high: empty() };
}

function determineStatus(
  findings: AuditFinding[],
  thresholds: ThresholdSummary,
  conclusive: boolean,
): AuditStatus {
  if (findings.some((f) => f.severity === "critical")) return "error";
  if (!conclusive) return "inconclusive";

  const anyInsufficient = [
    thresholds.low,
    thresholds.medium,
    thresholds.high,
  ].some((t) => t.conclusive && !t.satisfied);

  if (anyInsufficient) return "insufficient-quorum";

  if (findings.some((f) => f.severity === "warning")) return "warning";

  return "pass";
}

export default auditSep30RecoveryQuorum;