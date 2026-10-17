import { promises as fs } from 'fs';
import * as path from 'path';

import {
  AccountTrustline,
  loadAccountTrustlines,
  validateAccountId,
} from './account-trustlines';

import {
  TrustlineExposureService,
  TrustlineExposureReport,
  TrustlineExposureOptions,
  ValuationDataset,
  ValuationCurrency,
  ValuationSource,
  ExposureServiceError,
  createTrustlineExposureService,
} from '../services/trustline-exposure-service';

export {
  TrustlineExposureService,
  TrustlineExposureReport,
  TrustlineExposureOptions,
  ValuationDataset,
  ValuationCurrency,
  ValuationSource,
  ExposureServiceError,
  createTrustlineExposureService,
};

/**
 * Options accepted by the trustline exposure inspector entry point.
 */
export interface TrustlineExposureInspectorOptions {
  /** Stellar account ID (public key) to inspect. */
  accountId: string;
  /** Horizon network configuration (e.g. network passphrase / horizon URL). */
  network?: {
    horizonUrl?: string;
    networkPassphrase?: string;
  };
  /**
   * Optional path to a JSON valuation dataset file. When provided, the file is
   * read and validated before being passed to the exposure service.
   */
  valuationDatasetPath?: string;
  /**
   * Optional pre-loaded valuation dataset. Mutually exclusive with
   * `valuationDatasetPath`.
   */
  valuationDataset?: ValuationDataset;
  /** Optional pre-fetched trustlines, bypassing Horizon retrieval. */
  trustlines?: AccountTrustline[];
  /** Additional service options (e.g. precision, rounding). */
  serviceOptions?: Omit<TrustlineExposureOptions, 'valuationDataset' | 'trustlines'>;
}

/**
 * Error raised for invalid inspector-level input (account ID, valuation file,
 * or valuation metadata).
 */
export class TrustlineExposureInspectorError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TrustlineExposureInspectorError';
    this.code = code;
  }
}

const SUPPORTED_VALUATION_CURRENCIES: ReadonlyArray<string> = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'USDC',
  'USDT',
  'XLM',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the account ID using the shared account/trustline utilities.
 */
export function validateInspectorAccountId(accountId: unknown): string {
  if (!isNonEmptyString(accountId)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_ACCOUNT_ID',
      'A Stellar account ID is required.',
    );
  }

  const trimmed = accountId.trim();

  try {
    const valid = validateAccountId(trimmed);
    if (valid === false) {
      throw new TrustlineExposureInspectorError(
        'INVALID_ACCOUNT_ID',
        `Invalid Stellar account ID: ${trimmed}`,
      );
    }
  } catch (err) {
    if (err instanceof TrustlineExposureInspectorError) {
      throw err;
    }
    throw new TrustlineExposureInspectorError(
      'INVALID_ACCOUNT_ID',
      `Invalid Stellar account ID: ${trimmed}`,
    );
  }

  return trimmed;
}

/**
 * Validate the currency and source metadata of a valuation dataset.
 * Returns a normalized copy of the dataset.
 */
export function validateValuationDataset(dataset: unknown): ValuationDataset {
  if (!isPlainObject(dataset)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_VALUATION_DATASET',
      'Valuation dataset must be a JSON object.',
    );
  }

  const currency = dataset.currency;
  if (!isNonEmptyString(currency)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_VALUATION_CURRENCY',
      'Valuation dataset must declare an explicit valuation currency.',
    );
  }

  const normalizedCurrency = currency.trim().toUpperCase();
  if (!SUPPORTED_VALUATION_CURRENCIES.includes(normalizedCurrency)) {
    throw new TrustlineExposureInspectorError(
      'UNSUPPORTED_VALUATION_CURRENCY',
      `Unsupported valuation currency: ${currency}. Supported currencies: ${SUPPORTED_VALUATION_CURRENCIES.join(
        ', ',
      )}.`,
    );
  }

  const source = dataset.source;
  if (!isNonEmptyString(source)) {
    throw new TrustlineExposureInspectorError(
      'MISSING_VALUATION_SOURCE',
      'Valuation dataset must declare a source (e.g. provider name or URL).',
    );
  }

  const prices = dataset.prices;
  if (!isPlainObject(prices)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_VALUATION_DATASET',
      'Valuation dataset must include a "prices" object keyed by asset identity.',
    );
  }

  const normalizedPrices: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(prices)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TrustlineExposureInspectorError(
        'INVALID_VALUATION_PRICE',
        `Valuation price for "${key}" must be a string or number.`,
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TrustlineExposureInspectorError(
        'INVALID_VALUATION_PRICE',
        `Valuation price for "${key}" must be a finite number.`,
      );
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      throw new TrustlineExposureInspectorError(
        'INVALID_VALUATION_PRICE',
        `Valuation price for "${key}" must not be empty.`,
      );
    }
    normalizedPrices[key] = value;
  }

  const normalized: ValuationDataset = {
    currency: normalizedCurrency as ValuationCurrency,
    source: source.trim() as ValuationSource,
    prices: normalizedPrices,
  };

  if (isNonEmptyString(dataset.asOf)) {
    normalized.asOf = dataset.asOf.trim();
  }

  if (isNonEmptyString(dataset.notes)) {
    normalized.notes = dataset.notes.trim();
  }

  return normalized;
}

/**
 * Read and validate a valuation dataset JSON file.
 */
export async function loadValuationDatasetFromFile(
  filePath: string,
): Promise<ValuationDataset> {
  if (!isNonEmptyString(filePath)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_VALUATION_PATH',
      'Valuation dataset path must be a non-empty string.',
    );
  }

  const resolved = path.resolve(filePath);

  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    throw new TrustlineExposureInspectorError(
      'VALUATION_FILE_NOT_FOUND',
      `Unable to read valuation dataset at ${resolved}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TrustlineExposureInspectorError(
      'INVALID_VALUATION_JSON',
      `Valuation dataset at ${resolved} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return validateValuationDataset(parsed);
}

/**
 * Load trustlines for the given account, reusing the existing account/trustline
 * inspection utilities. If trustlines are supplied directly they are used as-is.
 */
export async function loadTrustlinesForExposure(
  accountId: string,
  options: TrustlineExposureInspectorOptions,
): Promise<AccountTrustline[]> {
  if (Array.isArray(options.trustlines)) {
    return options.trustlines;
  }

  try {
    const trustlines = await loadAccountTrustlines(accountId, options.network);
    return Array.isArray(trustlines) ? trustlines : [];
  } catch (err) {
    throw new TrustlineExposureInspectorError(
      'TRUSTLINE_LOAD_FAILED',
      `Failed to load trustlines for account ${accountId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Resolve the optional valuation dataset from either an explicit dataset or a
 * file path. Throws if both are provided.
 */
export async function resolveValuationDataset(
  options: TrustlineExposureInspectorOptions,
): Promise<ValuationDataset | undefined> {
  if (options.valuationDataset && options.valuationDatasetPath) {
    throw new TrustlineExposureInspectorError(
      'CONFLICTING_VALUATION_INPUT',
      'Provide either a valuation dataset or a valuation dataset path, not both.',
    );
  }

  if (options.valuationDataset) {
    return validateValuationDataset(options.valuationDataset);
  }

  if (options.valuationDatasetPath) {
    return loadValuationDatasetFromFile(options.valuationDatasetPath);
  }

  return undefined;
}

/**
 * Entry point for the trustline exposure audit. Loads the account's trustlines
 * (or accepts pre-fetched records), optionally loads a valuation dataset, and
 * delegates to the exposure service.
 *
 * This function is read-only: it never modifies trustlines or account
 * configuration.
 */
export async function inspectTrustlineExposure(
  options: TrustlineExposureInspectorOptions,
): Promise<TrustlineExposureReport> {
  if (!isPlainObject(options)) {
    throw new TrustlineExposureInspectorError(
      'INVALID_OPTIONS',
      'Trustline exposure inspector options are required.',
    );
  }

  const accountId = validateInspectorAccountId(options.accountId);
  const valuationDataset = await resolveValuationDataset(options);
  const trustlines = await loadTrustlinesForExposure(accountId, options);

  const service = createTrustlineExposureService();

  const serviceOptions: TrustlineExposureOptions = {
    ...(options.serviceOptions ?? {}),
    accountId,
    network: options.network,
    trustlines,
    valuationDataset,
  };

  try {
    return await service.audit(serviceOptions);
  } catch (err) {
    if (err instanceof ExposureServiceError) {
      throw err;
    }
    throw new TrustlineExposureInspectorError(
      'EXPOSURE_AUDIT_FAILED',
      `Trustline exposure audit failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export default inspectTrustlineExposure;