import * as fs from 'fs';
import * as path from 'path';

import {
  decodeEnvelopeXdr,
  decodeResultXdr,
  decodeResultMetaXdr,
  decodeFeeMetaXdr,
  computeTransactionHash,
} from '../utils/xdr';

/**
 * Severity levels for consistency audit findings.
 */
export type ConsistencySeverity = 'info' | 'warning' | 'error';

/**
 * Classification of a consistency audit finding.
 *
 * - `confirmed_mismatch`: decoded data disagrees with a comparable structured field.
 * - `decoding_failure`: an XDR artifact could not be decoded (malformed base64, invalid XDR, unsupported version).
 * - `unavailable_comparison`: a comparison could not be performed because required data was absent or unsupported.
 * - `successful_check`: a comparison or decode completed and was consistent.
 */
export type ConsistencyFindingKind =
  | 'confirmed_mismatch'
  | 'decoding_failure'
  | 'unavailable_comparison'
  | 'successful_check';

/**
 * Overall status of the audit.
 */
export type ConsistencyStatus = 'ok' | 'warnings' | 'inconsistencies' | 'errors';

/**
 * A single diagnostic finding produced by the audit.
 */
export interface ConsistencyFinding {
  /** Classification of the finding. */
  kind: ConsistencyFindingKind;
  /** Severity of the finding. */
  severity: ConsistencySeverity;
  /** The field or comparison responsible for the finding. */
  field: string;
  /** Concise human-readable explanation. */
  message: string;
  /** Expected value, when safe to include. */
  expected?: unknown;
  /** Observed value, when safe to include. */
  observed?: unknown;
}

/**
 * Metadata describing the audited input.
 */
export interface ConsistencyInputMetadata {
  /** Where the response came from. */
  source: 'api' | 'file';
  /** File path when the response was loaded from disk. */
  filePath?: string;
  /** Horizon endpoint or URL when the response came from an API request. */
  endpoint?: string;
  /** Network passphrase used for transaction hashing, when configured. */
  networkPassphrase?: string;
  /** XDR fields present in the response. */
  presentXdrFields: string[];
  /** XDR fields absent from the response. */
  missingXdrFields: string[];
}

/**
 * Result of a transaction response consistency audit.
 */
export interface ConsistencyAuditResult {
  /** Overall status of the audit. */
  status: ConsistencyStatus;
  /** All findings produced by the audit. */
  findings: ConsistencyFinding[];
  /** Metadata about the audited input. */
  input: ConsistencyInputMetadata;
  /**
   * Explicit disclaimer separating structural consistency from
   * cryptographic verification and server authenticity.
   */
  disclaimer: string;
}

/**
 * Options for the consistency audit.
 */
export interface ConsistencyAuditOptions {
  /** Network passphrase used for transaction hashing. */
  networkPassphrase?: string;
  /** Horizon endpoint or URL, when the response came from an API request. */
  endpoint?: string;
}

const SUPPORTED_XDR_FIELDS = [
  'envelope_xdr',
  'result_xdr',
  'result_meta_xdr',
  'fee_meta_xdr',
] as const;

type SupportedXdrField = (typeof SUPPORTED_XDR_FIELDS)[number];

const DISCLAIMER =
  'This audit performs structural consistency checks only. It does not ' +
  'cryptographically verify the Horizon server, prove response authenticity, ' +
  'or guarantee that the response has not been tampered with.';

/**
 * Read-only diagnostic service that validates consistency between a Horizon
 * transaction response and its associated XDR fields.
 *
 * The service never submits transactions or modifies network state.
 */
export class TransactionResponseConsistencyService {
  /**
   * Audit a Horizon transaction response supplied as a plain object.
   */
  auditResponse(
    response: unknown,
    options: ConsistencyAuditOptions = {},
  ): ConsistencyAuditResult {
    const findings: ConsistencyFinding[] = [];

    if (!isPlainObject(response)) {
      findings.push({
        kind: 'decoding_failure',
        severity: 'error',
        field: '<response>',
        message:
          'Transaction response is not a JSON object and cannot be audited.',
      });
      return this.buildResult(findings, {
        source: options.endpoint ? 'api' : 'file',
        endpoint: options.endpoint,
        networkPassphrase: options.networkPassphrase,
        presentXdrFields: [],
        missingXdrFields: [...SUPPORTED_XDR_FIELDS],
      });
    }

    const presentXdrFields: string[] = [];
    const missingXdrFields: string[] = [];

    for (const field of SUPPORTED_XDR_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(response, field)) {
        presentXdrFields.push(field);
      } else {
        missingXdrFields.push(field);
      }
    }

    const decoded: Partial<Record<SupportedXdrField, unknown>> = {};

    // Decode each supported XDR field independently so that one failure does
    // not prevent the remaining checks from running.
    for (const field of SUPPORTED_XDR_FIELDS) {
      if (!presentXdrFields.includes(field)) {
        findings.push({
          kind: 'unavailable_comparison',
          severity: 'info',
          field,
          message: `Optional XDR field '${field}' is not present in the response; related checks are unavailable.`,
        });
        continue;
      }

      const raw = (response as Record<string, unknown>)[field];

      if (raw === null || raw === undefined) {
        findings.push({
          kind: 'unavailable_comparison',
          severity: 'info',
          field,
          message: `XDR field '${field}' is null or undefined; related checks are unavailable.`,
        });
        continue;
      }

      if (typeof raw !== 'string') {
        findings.push({
          kind: 'decoding_failure',
          severity: 'error',
          field,
          message: `XDR field '${field}' is not a string and cannot be decoded.`,
          observed: typeof raw,
        });
        continue;
      }

      if (raw.trim() === '') {
        findings.push({
          kind: 'decoding_failure',
          severity: 'error',
          field,
          message: `XDR field '${field}' is empty and cannot be decoded.`,
        });
        continue;
      }

      if (!isLikelyBase64(raw)) {
        findings.push({
          kind: 'decoding_failure',
          severity: 'error',
          field,
          message: `XDR field '${field}' is not valid base64.`,
        });
        continue;
      }

      try {
        const value = this.decodeXdrField(field, raw);
        decoded[field] = value;
        findings.push({
          kind: 'successful_check',
          severity: 'info',
          field,
          message: `XDR field '${field}' decoded successfully.`,
        });
      } catch (error) {
        findings.push({
          kind: 'decoding_failure',
          severity: 'error',
          field,
          message: `Failed to decode XDR field '${field}': ${errorMessage(error)}`,
        });
      }
    }

    // Cross-check the transaction hash against the decoded envelope.
    this.checkTransactionHash(response, decoded, options, findings);

    // Compare comparable structured fields against decoded transaction data.
    this.checkStructuredFields(response, decoded, findings);

    return this.buildResult(findings, {
      source: options.endpoint ? 'api' : 'file',
      endpoint: options.endpoint,
      networkPassphrase: options.networkPassphrase,
      presentXdrFields,
      missingXdrFields,
    });
  }

  /**
   * Audit a Horizon transaction response loaded from a local JSON file.
   */
  auditFile(
    filePath: string,
    options: ConsistencyAuditOptions = {},
  ): ConsistencyAuditResult {
    let parsed: unknown;
    try {
      const contents = fs.readFileSync(filePath, 'utf8');
      parsed = JSON.parse(contents);
    } catch (error) {
      const findings: ConsistencyFinding[] = [
        {
          kind: 'decoding_failure',
          severity: 'error',
          field: '<file>',
          message: `Failed to read or parse JSON file '${filePath}': ${errorMessage(error)}`,
        },
      ];
      return this.buildResult(findings, {
        source: 'file',
        filePath,
        networkPassphrase: options.networkPassphrase,
        presentXdrFields: [],
        missingXdrFields: [...SUPPORTED_XDR_FIELDS],
      });
    }

    const result = this.auditResponse(parsed, options);
    result.input.source = 'file';
    result.input.filePath = filePath;
    return result;
  }

  /**
   * Decode a supported XDR field using the existing Stellar SDK utilities.
   */
  private decodeXdrField(field: SupportedXdrField, raw: string): unknown {
    switch (field) {
      case 'envelope_xdr':
        return decodeEnvelopeXdr(raw);
      case 'result_xdr':
        return decodeResultXdr(raw);
      case 'result_meta_xdr':
        return decodeResultMetaXdr(raw);
      case 'fee_meta_xdr':
        return decodeFeeMetaXdr(raw);
      default:
        throw new Error(`Unsupported XDR field '${field}'.`);
    }
  }

  /**
   * Cross-check the transaction hash against the decoded envelope.
   */
  private checkTransactionHash(
    response: Record<string, unknown>,
    decoded: Partial<Record<SupportedXdrField, unknown>>,
    options: ConsistencyAuditOptions,
    findings: ConsistencyFinding[],
  ): void {
    const reportedHash = response.hash;

    if (reportedHash === undefined || reportedHash === null) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: 'hash',
        message:
          "Response does not include a 'hash' field; transaction hash comparison is unavailable.",
      });
      return;
    }

    if (typeof reportedHash !== 'string' || reportedHash.trim() === '') {
      findings.push({
        kind: 'decoding_failure',
        severity: 'error',
        field: 'hash',
        message: "Response 'hash' field is not a non-empty string.",
      });
      return;
    }

    const envelope = decoded.envelope_xdr;
    if (envelope === undefined) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: 'hash',
        message:
          "Cannot verify transaction hash because 'envelope_xdr' was not decoded.",
      });
      return;
    }

    if (!options.networkPassphrase) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'warning',
        field: 'hash',
        message:
          'Cannot verify transaction hash because no network passphrase is configured.',
      });
      return;
    }

    let computedHash: string;
    try {
      computedHash = computeTransactionHash(envelope, options.networkPassphrase);
    } catch (error) {
      findings.push({
        kind: 'decoding_failure',
        severity: 'error',
        field: 'hash',
        message: `Failed to compute transaction hash from decoded envelope: ${errorMessage(error)}`,
      });
      return;
    }

    if (normalizeHash(computedHash) === normalizeHash(reportedHash)) {
      findings.push({
        kind: 'successful_check',
        severity: 'info',
        field: 'hash',
        message: 'Transaction hash matches the decoded envelope.',
      });
    } else {
      findings.push({
        kind: 'confirmed_mismatch',
        severity: 'error',
        field: 'hash',
        message:
          'Transaction hash does not match the hash computed from the decoded envelope.',
        expected: computedHash,
        observed: reportedHash,
      });
    }
  }

  /**
   * Compare comparable structured response fields with decoded transaction data.
   */
  private checkStructuredFields(
    response: Record<string, unknown>,
    decoded: Partial<Record<SupportedXdrField, unknown>>,
    findings: ConsistencyFinding[],
  ): void {
    const envelope = decoded.envelope_xdr;
    if (envelope === undefined) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: '<structured fields>',
        message:
          'Structured field comparisons are unavailable because the envelope could not be decoded.',
      });
      return;
    }

    const tx = extractTransaction(envelope);
    if (!tx) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: '<structured fields>',
        message:
          'Decoded envelope does not expose a comparable transaction structure.',
      });
      return;
    }

    this.compareField(
      response,
      'source_account',
      extractSourceAccount(tx),
      findings,
      'source account',
    );

    this.compareField(
      response,
      'source_account_sequence',
      extractSequenceNumber(tx),
      findings,
      'sequence number',
    );

    this.compareField(
      response,
      'fee_charged',
      extractFee(tx),
      findings,
      'fee',
    );

    this.compareField(
      response,
      'max_fee',
      extractFee(tx),
      findings,
      'max fee',
    );

    this.compareField(
      response,
      'operation_count',
      extractOperationCount(tx),
      findings,
      'operation count',
    );
  }

  /**
   * Compare a single structured response field against a decoded value.
   */
  private compareField(
    response: Record<string, unknown>,
    responseField: string,
    decodedValue: unknown,
    findings: ConsistencyFinding[],
    label: string,
  ): void {
    if (decodedValue === undefined || decodedValue === null) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: responseField,
        message: `Decoded transaction does not expose a comparable ${label}; comparison is unavailable.`,
      });
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(response, responseField)) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: responseField,
        message: `Response does not include '${responseField}'; ${label} comparison is unavailable.`,
      });
      return;
    }

    const observed = response[responseField];

    if (observed === undefined || observed === null) {
      findings.push({
        kind: 'unavailable_comparison',
        severity: 'info',
        field: responseField,
        message: `Response field '${responseField}' is null or undefined; ${label} comparison is unavailable.`,
      });
      return;
    }

    if (valuesEqual(observed, decodedValue)) {
      findings.push({
        kind: 'successful_check',
        severity: 'info',
        field: responseField,
        message: `${capitalize(label)} is consistent with the decoded transaction.`,
      });
    } else {
      findings.push({
        kind: 'confirmed_mismatch',
        severity: 'error',
        field: responseField,
        message: `${capitalize(label)} in the response does not match the decoded transaction.`,
        expected: decodedValue,
        observed,
      });
    }
  }

  /**
   * Assemble the final audit result and derive the overall status.
   */
  private buildResult(
    findings: ConsistencyFinding[],
    input: ConsistencyInputMetadata,
  ): ConsistencyAuditResult {
    return {
      status: deriveStatus(findings),
      findings,
      input,
      disclaimer: DISCLAIMER,
    };
  }
}

/**
 * Derive the overall status from the collected findings.
 */
function deriveStatus(findings: ConsistencyFinding[]): ConsistencyStatus {
  if (findings.some((f) => f.kind === 'confirmed_mismatch')) {
    return 'inconsistencies';
  }
  if (findings.some((f) => f.kind === 'decoding_failure')) {
    return 'errors';
  }
  if (findings.some((f) => f.severity === 'warning')) {
    return 'warnings';
  }
  return 'ok';
}

/**
 * Determine whether a string is plausibly base64-encoded.
 */
function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}

/**
 * Normalize a hash for comparison.
 */
function normalizeHash(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Compare two values for structural equality, tolerating numeric string forms.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'number' && typeof b === 'string') {
    return String(a) === b.trim();
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return a.trim() === String(b);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  return false;
}

/**
 * Extract the transaction structure from a decoded envelope.
 */
function extractTransaction(envelope: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(envelope)) {
    return undefined;
  }
  const tx = (envelope as Record<string, unknown>).tx;
  if (isPlainObject(tx)) {
    return tx as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Extract the source account from a decoded transaction.
 */
function extractSourceAccount(tx: Record<string, unknown>): string | undefined {
  const sourceAccount = tx.sourceAccount;
  if (typeof sourceAccount === 'string') {
    return sourceAccount;
  }
  if (isPlainObject(sourceAccount)) {
    const accountId = (sourceAccount as Record<string, unknown>).accountId;
    if (typeof accountId === 'string') {
      return accountId;
    }
  }
  return undefined;
}

/**
 * Extract the sequence number from a decoded transaction.
 */
function extractSequenceNumber(tx: Record<string, unknown>): string | undefined {
  const seq = tx.seqNum;
  if (typeof seq === 'string') {
    return seq;
  }
  if (typeof seq === 'number') {
    return String(seq);
  }
  return undefined;
}

/**
 * Extract the fee from a decoded transaction.
 */
function extractFee(tx: Record<string, unknown>): number | undefined {
  const fee = tx.fee;
  if (typeof fee === 'number') {
    return fee;
  }
  if (typeof fee === 'string' && fee.trim() !== '' && !Number.isNaN(Number(fee))) {
    return Number(fee);
  }
  return undefined;
}

/**
 * Extract the operation count from a decoded transaction.
 */
function extractOperationCount(tx: Record<string, unknown>): number | undefined {
  const ops = tx.operations;
  if (Array.isArray(ops)) {
    return ops.length;
  }
  return undefined;
}

/**
 * Type guard for plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract a readable message from an unknown error.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Convenience helper to audit a response from a local JSON file.
 */
export function auditTransactionResponseFile(
  filePath: string,
  options: ConsistencyAuditOptions = {},
): ConsistencyAuditResult {
  return new TransactionResponseConsistencyService().auditFile(filePath, options);
}

/**
 * Convenience helper to audit an in-memory Horizon transaction response.
 */
export function auditTransactionResponse(
  response: unknown,
  options: ConsistencyAuditOptions = {},
): ConsistencyAuditResult {
  return new TransactionResponseConsistencyService().auditResponse(response, options);
}