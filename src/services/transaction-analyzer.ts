import { normalizeOperationType } from '../utils/operation-parser';
import { fetchTransaction, fetchOperationsForTransaction } from './horizon-client';

export interface TransactionDetails {
  hash: string;
  sourceAccount: string;
  ledger: number | null;
  successful: boolean;
  feeCharged: string;
  maxFee: string;
  memoType: string;
  memoValue: string;
  operationCount: number;
  createdAt: string;
  horizonUrl: string;
}

export interface AnalyzedOperation {
  index: number;
  type: string;
  description: string;
  details: Record<string, string>;
  supported: boolean;
}

export interface AssetMovement {
  type: string;
  description: string;
}

export interface AssetSummary {
  movements: AssetMovement[];
}

export interface TransactionAnalysis {
  transaction: TransactionDetails;
  operations: AnalyzedOperation[];
  assetSummary: AssetSummary;
}

export interface FetchTransactionOptions {
  horizonUrl: string;
  hash: string;
}

export interface PaymentReferenceAuditOptions {
  horizonUrl: string;
  reference: string;
  account?: string;
  asset?: { code: string; issuer?: string };
  expectedDestination?: string;
  expectedAmount?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export type ReferenceType = 'transaction_hash' | 'memo_text' | 'memo_id' | 'memo_hash' | 'unknown';

export interface ReferenceValidation {
  type: ReferenceType;
  valid: boolean;
  error?: string;
}

export interface MatchedPaymentOperation {
  operationIndex: number;
  type: string;
  sender: string;
  destination: string;
  assetCode: string;
  assetIssuer: string;
  amount: string;
  exactAmount: boolean;
}

export interface MatchedTransaction {
  hash: string;
  ledger: number | null;
  createdAt: string;
  successful: boolean;
  status: string;
  memoType: string;
  memoValue: string;
  matchKind: 'transaction_hash' | 'memo_reference';
  payments: MatchedPaymentOperation[];
}

export interface RetrievalLimitations {
  incomplete: boolean;
  paginationFailures: string[];
  unavailableHistory: boolean;
  notes: string[];
}

export interface PaymentReferenceAuditResult {
  reference: string;
  referenceType: ReferenceType;
  validation: ReferenceValidation;
  constraints: {
    account?: string;
    asset?: { code: string; issuer?: string };
    expectedDestination?: string;
    expectedAmount?: string;
    since?: string;
    until?: string;
  };
  matches: MatchedTransaction[];
  ambiguous: boolean;
  matchCount: number;
  limitations: RetrievalLimitations;
  readOnly: true;
  settlementClaimed: false;
}

const MEMO_HASH_REGEX = /^[0-9a-fA-F]{64}$/;
const MEMO_ID_REGEX = /^\d+$/;

export function classifyReference(reference: string): ReferenceValidation {
  const trimmed = reference?.trim() ?? '';
  if (!trimmed) {
    return { type: 'unknown', valid: false, error: 'Payment reference must not be empty.' };
  }
  if (MEMO_HASH_REGEX.test(trimmed)) {
    const hashCheck = validateTransactionHash(trimmed);
    if (hashCheck.valid) {
      return { type: 'transaction_hash', valid: true };
    }
  }
  if (MEMO_ID_REGEX.test(trimmed)) {
    return { type: 'memo_id', valid: true };
  }
  return { type: 'memo_text', valid: true };
}

function normalizeAssetCode(code: string | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

function assetMatches(
  op: Record<string, unknown>,
  expected: { code: string; issuer?: string },
): boolean {
  const assetType = (op.asset_type as string) || 'native';
  const expectedCode = normalizeAssetCode(expected.code);
  if (expectedCode === 'XLM' || expectedCode === 'NATIVE') {
    return assetType === 'native';
  }
  if (assetType === 'native') return false;
  const code = normalizeAssetCode(op.asset_code as string | undefined);
  if (code !== expectedCode) return false;
  if (expected.issuer) {
    const issuer = (op.asset_issuer as string) || '';
    return issuer === expected.issuer;
  }
  return true;
}

function amountsEqual(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    return a.trim() === b.trim();
  }
  return na === nb;
}

function withinTimeWindow(createdAt: string, since?: string, until?: string): boolean {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return true;
  if (since) {
    const sinceTs = Date.parse(since);
    if (!Number.isNaN(sinceTs) && ts < sinceTs) return false;
  }
  if (until) {
    const untilTs = Date.parse(until);
    if (!Number.isNaN(untilTs) && ts > untilTs) return false;
  }
  return true;
}

function extractPaymentOperations(
  rawOps: unknown[],
  options: PaymentReferenceAuditOptions,
): MatchedPaymentOperation[] {
  const payments: MatchedPaymentOperation[] = [];
  rawOps.forEach((raw, index) => {
    const op = raw as Record<string, unknown>;
    const type = normalizeOperationType((op.type as string) || 'unknown');
    if (
      type !== 'payment' &&
      type !== 'path_payment_strict_receive' &&
      type !== 'path_payment_strict_send'
    ) {
      return;
    }

    const sender = (op.from as string) || (op.source_account as string) || '';
    const destination = (op.to as string) || '';
    const amount = (op.amount as string) || '0';
    const assetType = (op.asset_type as string) || 'native';
    const assetCode = assetType === 'native' ? 'XLM' : (op.asset_code as string) || '';
    const assetIssuer = assetType === 'native' ? '' : (op.asset_issuer as string) || '';

    if (options.expectedDestination && destination !== options.expectedDestination) return;
    if (options.asset && !assetMatches(op, options.asset)) return;
    if (options.expectedAmount && !amountsEqual(amount, options.expectedAmount)) return;

    payments.push({
      operationIndex: index,
      type,
      sender,
      destination,
      assetCode,
      assetIssuer,
      amount,
      exactAmount: options.expectedAmount ? amountsEqual(amount, options.expectedAmount) : true,
    });
  });
  return payments;
}

function memoMatches(
  memoType: string,
  memoValue: string,
  reference: string,
  referenceType: ReferenceType,
): boolean {
  const value = (memoValue ?? '').trim();
  const ref = reference.trim();
  switch (memoType) {
    case 'text':
      return referenceType === 'memo_text' && value === ref;
    case 'id':
      return referenceType === 'memo_id' && value === ref;
    case 'hash':
    case 'return':
      return referenceType === 'transaction_hash' && value.toLowerCase() === ref.toLowerCase();
    default:
      return false;
  }
}

export async function auditPaymentReference(
  options: PaymentReferenceAuditOptions,
): Promise<PaymentReferenceAuditResult> {
  const reference = options.reference?.trim() ?? '';
  const validation = classifyReference(reference);
  const limitations: RetrievalLimitations = {
    incomplete: false,
    paginationFailures: [],
    unavailableHistory: false,
    notes: [],
  };

  const constraints = {
    account: options.account,
    asset: options.asset,
    expectedDestination: options.expectedDestination,
    expectedAmount: options.expectedAmount,
    since: options.since,
    until: options.until,
  };

  const baseResult: PaymentReferenceAuditResult = {
    reference,
    referenceType: validation.type,
    validation,
    constraints,
    matches: [],
    ambiguous: false,
    matchCount: 0,
    limitations,
    readOnly: true,
    settlementClaimed: false,
  };

  if (!validation.valid) {
    return baseResult;
  }

  const matches: MatchedTransaction[] = [];

  // Exact transaction-hash lookup path.
  if (validation.type === 'transaction_hash') {
    try {
      const tx = await fetchTransaction(options.horizonUrl, reference);
      if (tx) {
        const rawOps = await fetchOperationsForTransaction(options.horizonUrl, reference).catch(
          (err: unknown) => {
            limitations.paginationFailures.push(
              `Failed to load operations for ${reference}: ${(err as Error).message}`,
            );
            limitations.incomplete = true;
            return [] as unknown[];
          },
        );
        const payments = extractPaymentOperations(rawOps, options);
        if (withinTimeWindow(tx.created_at, options.since, options.until)) {
          matches.push({
            hash: tx.hash,
            ledger: tx.ledger ?? null,
            createdAt: tx.created_at,
            successful: tx.successful,
            status: tx.successful ? 'success' : 'failed',
            memoType: tx.memo_type,
            memoValue: tx.memo ?? '',
            matchKind: 'transaction_hash',
            payments,
          });
        }
      }
    } catch (err) {
      limitations.unavailableHistory = true;
      limitations.incomplete = true;
      limitations.notes.push(
        `Transaction ${reference} could not be retrieved: ${(err as Error).message}`,
      );
    }
    const result: PaymentReferenceAuditResult = {
      ...baseResult,
      matches,
      matchCount: matches.length,
      ambiguous: false,
    };
    return result;
  }

  // Application-level memo/reference search path.
  if (!options.account) {
    limitations.incomplete = true;
    limitations.notes.push(
      'Memo-based reference search requires an account filter; no account was supplied so no records were searched.',
    );
    return baseResult;
  }

  try {
    const { fetchAccountTransactions } = await import('./horizon-client');
    const records = await fetchAccountTransactions(options.horizonUrl, options.account, {
      limit: options.limit ?? 200,
    });
    for (const tx of records) {
      if (!withinTimeWindow(tx.created_at, options.since, options.until)) continue;
      if (!memoMatches(tx.memo_type, tx.memo ?? '', reference, validation.type)) continue;
      const rawOps = await fetchOperationsForTransaction(options.horizonUrl, tx.hash).catch(
        (err: unknown) => {
          limitations.paginationFailures.push(
            `Failed to load operations for ${tx.hash}: ${(err as Error).message}`,
          );
          limitations.incomplete = true;
          return [] as unknown[];
        },
      );
      const payments = extractPaymentOperations(rawOps, options);
      matches.push({
        hash: tx.hash,
        ledger: tx.ledger ?? null,
        createdAt: tx.created_at,
        successful: tx.successful,
        status: tx.successful ? 'success' : 'failed',
        memoType: tx.memo_type,
        memoValue: tx.memo ?? '',
        matchKind: 'memo_reference',
        payments,
      });
    }
  } catch (err) {
    limitations.unavailableHistory = true;
    limitations.incomplete = true;
    limitations.notes.push(
      `Account transaction history could not be retrieved: ${(err as Error).message}`,
    );
  }

  return {
    ...baseResult,
    matches,
    matchCount: matches.length,
    ambiguous: matches.length > 1,
  };
}

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

export function validateTransactionHash(hash: string): { valid: boolean; error?: string } {
  if (!hash?.trim()) {
    return { valid: false, error: 'Transaction hash must not be empty.' };
  }
  if (!TX_HASH_REGEX.test(hash.trim())) {
    return {
      valid: false,
      error: 'Transaction hash must be a 64-character hexadecimal string.',
    };
  }
  return { valid: true };
}

function formatAsset(op: Record<string, unknown>): string {
  const assetType = (op.asset_type as string) || 'native';
  if (assetType === 'native') return 'XLM';
  const code = (op.asset_code as string) || 'Unknown';
  const issuer = (op.asset_issuer as string) || '';
  if (assetType === 'credit_alphanum4' || assetType === 'credit_alphanum12') {
    return `${code}:${issuer.slice(0, 8)}...`;
  }
  return `${code} (${assetType})`;
}

function formatPrice(price: string | { n: string; d: string }): string {
  if (!price) return '0';
  if (typeof price === 'string') return price;
  const n = parseFloat(price.n || '0');
  const d = parseFloat(price.d || '1');
  if (d === 0) return '0';
  return (n / d).toFixed(7);
}

function analyzePayment(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || (op.source_account as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const asset = formatAsset(op);
  const description = `${from} sent ${amount} ${asset} to ${to}`;
  return {
    index,
    type: 'payment',
    description,
    details: { source: from, destination: to, amount, asset },
    supported: true,
  };
}

function analyzePathPayment(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const sourceAmount = (op.source_amount as string) || '0';
  const sourceMax = (op.source_max as string) || '0';
  const asset = formatAsset(op);
  const sourceAssetType = (op.source_asset_type as string) || 'native';
  const sourceAssetCode = op.source_asset_code as string | undefined;
  const sourceAssetIssuer = op.source_asset_issuer as string | undefined;
  let sourceAssetLabel = 'XLM';
  if (sourceAssetType !== 'native' && sourceAssetCode && sourceAssetIssuer) {
    sourceAssetLabel = `${sourceAssetCode}:${sourceAssetIssuer}`;
  } else if (sourceAssetType !== 'native' && sourceAssetCode) {
    sourceAssetLabel = sourceAssetCode;
  }
  const description = `${from} sent ${sourceAmount} ${sourceAssetLabel} (max ${sourceMax}) for ${amount} ${asset} to ${to}`;
  return {
    index,
    type: 'path_payment_strict_receive',
    description,
    details: {
      source: from,
      destination: to,
      amount,
      sourceAmount,
      sourceMax,
      asset,
      sourceAsset: sourceAssetLabel,
    },
    supported: true,
  };
}

function analyzePathPaymentStrictSend(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const destinationMin = (op.destination_min as string) || '0';
  const sourceAmount = (op.source_amount as string) || '0';
  const sourceMax = (op.source_max as string) || '0';
  const asset = formatAsset(op);
  const sourceAssetType = (op.source_asset_type as string) || 'native';
  const sourceAssetCode = op.source_asset_code as string | undefined;
  const sourceAssetIssuer = op.source_asset_issuer as string | undefined;
  let sourceAssetLabel = 'XLM';
  if (sourceAssetType !== 'native' && sourceAssetCode && sourceAssetIssuer) {
    sourceAssetLabel = `${sourceAssetCode}:${sourceAssetIssuer}`;
  } else if (sourceAssetType !== 'native' && sourceAssetCode) {
    sourceAssetLabel = sourceAssetCode;
  }
  const description = `${from} sent ${sourceAmount} ${sourceAssetLabel} (max ${sourceMax}) for ${amount} ${asset} to ${to} (strict send, min ${destinationMin})`;
  return {
    index,
    type: 'path_payment_strict_send',
    description,
    details: {
      source: from,
      destination: to,
      amount,
      destinationMin,
      sourceAmount,
      sourceMax,
      asset,
      sourceAsset: sourceAssetLabel,
    },
    supported: true,
  };
}

function analyzeCreateAccount(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const funder = (op.funder as string) || (op.source_account as string) || '-';
  const account = (op.account as string) || '-';
  const startingBalance = (op.starting_balance as string) || '0';
  const description = `${funder} funded new account ${account} with ${startingBalance} XLM`;
  return {
    index,
    type: 'create_account',
    description,
    details: { funder, account, startingBalance },
    supported: true,
  };
}

function analyzeChangeTrust(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const trustor = (op.trustor as string) || '-';
  const asset = formatAsset(op);
  const limit = (op.limit as string) || 'Unlimited';
  const trustee = op.trustee as string | undefined;
  const description = trustee
    ? `${trustor} updated trustline for ${asset} (trustee: ${trustee}, limit: ${limit})`
    : `${trustor} created trustline for ${asset} with limit ${limit}`;
  return {
    index,
    type: 'change_trust',
    description,
    details: { trustor, asset, limit, trustee: trustee || '-' },
    supported: true,
  };
}

function analyzeManageSellOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const sourceAccount = (op.source_account as string) || '-';
  const description = `${sourceAccount} ${amount} ${sellingAsset} for ${buyingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'manage_sell_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeManageBuyOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const sourceAccount = (op.source_account as string) || '-';
  const description = `${sourceAccount} wants to buy ${amount} ${buyingAsset} with ${sellingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'manage_buy_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeAccountMerge(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const into = (op.into as string) || '-';
  const description = `${sourceAccount} merged into account ${into}`;
  return {
    index,
    type: 'account_merge',
    description,
    details: { source: sourceAccount, into },
    supported: true,
  };
}

function analyzeSetOptions(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const details: Record<string, string> = { source: sourceAccount };
  const parts: string[] = [];

  const lowThreshold = op.low_threshold as number | undefined;
  const medThreshold = op.med_threshold as number | undefined;
  const highThreshold = op.high_threshold as number | undefined;
  if (lowThreshold !== undefined || medThreshold !== undefined || highThreshold !== undefined) {
    parts.push(
      `thresholds: low=${lowThreshold ?? 0}, med=${medThreshold ?? 0}, high=${highThreshold ?? 0}`,
    );
    details.lowThreshold = String(lowThreshold ?? 0);
    details.medThreshold = String(medThreshold ?? 0);
    details.highThreshold = String(highThreshold ?? 0);
  }

  const signerKey = op.signer_key as string | undefined;
  const signerWeight = op.signer_weight as number | undefined;
  if (signerKey !== undefined) {
    parts.push(`signer ${signerKey} weight=${signerWeight ?? 0}`);
    details.signerKey = signerKey;
    details.signerWeight = String(signerWeight ?? 0);
  }

  const setFlags = (op.set_flags as number[]) || [];
  const setFlagsS = (op.set_flags_s as string[]) || [];
  const clearFlags = (op.clear_flags as number[]) || [];
  const clearFlagsS = (op.clear_flags_s as string[]) || [];
  if (setFlags.length > 0 || setFlagsS.length > 0) {
    const flagStr = setFlagsS.length > 0 ? setFlagsS.join(', ') : setFlags.map(String).join(', ');
    parts.push(`set flags: ${flagStr}`);
    details.setFlags = flagStr;
  }
  if (clearFlags.length > 0 || clearFlagsS.length > 0) {
    const flagStr =
      clearFlagsS.length > 0 ? clearFlagsS.join(', ') : clearFlags.map(String).join(', ');
    parts.push(`clear flags: ${flagStr}`);
    details.clearFlags = flagStr;
  }

  const masterKeyWeight = op.master_key_weight as number | undefined;
  if (masterKeyWeight !== undefined) {
    parts.push(`master key weight=${masterKeyWeight}`);
    details.masterKeyWeight = String(masterKeyWeight);
  }

  const homeDomain = op.home_domain as string | undefined;
  if (homeDomain) {
    parts.push(`home domain: ${homeDomain}`);
    details.homeDomain = homeDomain;
  }

  const description = `${sourceAccount} updated account settings${parts.length > 0 ? ` -- ${parts.join('; ')}` : ' (no changes detected)'}`;
  return {
    index,
    type: 'set_options',
    description,
    details,
    supported: true,
  };
}

function analyzeAllowTrust(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const trustor = (op.trustor as string) || '-';
  const trustee = (op.trustee as string) || '-';
  const assetCode = (op.asset_code as string) || 'Unknown';
  const assetIssuer = (op.asset_issuer as string) || '';
  const asset = op.asset_type === 'native' ? 'XLM' : `${assetCode}:${assetIssuer}`;
  const authorize = op.authorize as boolean | undefined;
  const action = authorize ? 'authorized' : 'deauthorized';
  const description = `${trustee} ${action} trustline for ${asset} on behalf of ${trustor}`;
  return {
    index,
    type: 'allow_trust',
    description,
    details: { trustor, trustee, asset, authorize: String(authorize ?? '') },
    supported: true,
  };
}

function analyzeInflation(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  return {
    index,
    type: 'inflation',
    description: `${sourceAccount} participated in inflation`,
    details: { source: sourceAccount },
    supported: true,
  };
}

function analyzeManageData(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const name = (op.name as string) || '-';
  const value = (op.value as string) !== undefined ? String(op.value) : null;
  const description =
    value !== null
      ? `${sourceAccount} set data "${name}" = "${value}"`
      : `${sourceAccount} deleted data "${name}"`;
  return {
    index,
    type: 'manage_data',
    description,
    details: { source: sourceAccount, name, value: value ?? '' },
    supported: true,
  };
}

function analyzeBumpSequence(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const bumpTo = (op.bump_to as string) || '-';
  return {
    index,
    type: 'bump_sequence',
    description: `${sourceAccount} bumped sequence to ${bumpTo}`,
    details: { source: sourceAccount, bumpTo },
    supported: true,
  };
}

function analyzeCreateClaimableBalance(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const amount = (op.amount as string) || '0';
  const cod = op.asset_code as string | undefined;
  const iss = op.asset_issuer as string | undefined;
  const ast = op.asset_type as string;
  let assetLabel = 'Unknown';
  if (ast === 'native') assetLabel = 'XLM';
  else if (cod && iss) assetLabel = `${cod}:${iss}`;
  else if (cod) assetLabel = cod;
  const claimantCount = (op.claimants as unknown[])?.length ?? 0;
  const description = `${sourceAccount} created claimable balance of ${amount} ${assetLabel} with ${claimantCount} claimant(s)`;
  return {
    index,
    type: 'create_claimable_balance',
    description,
    details: {
      source: sourceAccount,
      asset: assetLabel,
      amount,
      claimantCount: String(claimantCount),
    },
    supported: true,
  };
}

function analyzeClaimClaimableBalance(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const balanceId = (op.balance_id as string) || '-';
  return {
    index,
    type: 'claim_claimable_balance',
    description: `${sourceAccount} claimed balance ${balanceId}`,
    details: { source: sourceAccount, balanceId },
    supported: true,
  };
}

function analyzeBeginSponsoring(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const sponsoredId = (op.sponsored_id as string) || '-';
  return {
    index,
    type: 'begin_sponsoring_future_reserves',
    description: `${sourceAccount} began sponsoring ${sponsoredId}`,
    details: { source: sourceAccount, sponsoredId },
    supported: true,
  };
}

function analyzeEndSponsoring(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const beginSponsor = (op.begin_sponsor as string) || '-';
  return {
    index,
    type: 'end_sponsoring_future_reserves',
    description: `${sourceAccount} ended sponsorship (sponsored by ${beginSponsor})`,
    details: { source: sourceAccount, beginSponsor },
    supported: true,
  };
}

function analyzeRevokeSponsorship(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const details: Record<string, string> = { source: sourceAccount };
  if (op.account_id) details.accountId = op.account_id as string;
  if (op.signer_account_id) details.signerAccountId = op.signer_account_id as string;
  if (op.signer_key) details.signerKey = op.signer_key as string;
  if (op.trustline_account_id) details.trustlineAccountId = op.trustline_account_id as string;
  if (op.trustline_asset) details.trustlineAsset = op.trustline_asset as string;
  if (op.offer_id) details.offerId = String(op.offer_id);
  const desc = Object.entries(details)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return {
    index,
    type: 'revoke_sponsorship',
    description: `${sourceAccount} revoked sponsorship (${desc || 'unknown target'})`,
    details,
    supported: true,
  };
}

function analyzeClawback(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const asset = formatAsset(op);
  const amount = (op.amount as string) || '0';
  const description = `${from} clawback ${amount} ${asset}`;
  return {
    index,
    type: 'clawback',
    description,
    details: { from, asset, amount },
    supported: true,
  };
}

function analyzeLiquidityPoolDeposit(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const asset = formatAsset({
    asset_type: op.asset_a_type,
    asset_code: op.asset_a_code,
    asset_issuer: op.asset_a_issuer,
  });
  const maxAmountA = (op.max_amount_a as string) || '0';
  const maxAmountB = (op.max_amount_b as string) || '0';
  const minPrice = formatPrice((op.min_price ?? '') as string | { n: string; d: string });
  const maxPrice = formatPrice((op.max_price ?? '') as string | { n: string; d: string });
  const description = `${sourceAccount} deposited into liquidity pool: ${maxAmountA} ${asset} (max ${maxAmountB}), price range ${minPrice} - ${maxPrice}`;
  return {
    index,
    type: 'liquidity_pool_deposit',
    description,
    details: { source: sourceAccount, asset, maxAmountA, maxAmountB, minPrice, maxPrice },
    supported: true,
  };
}

function analyzeLiquidityPoolWithdraw(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const asset = formatAsset({
    asset_type: op.asset_a_type,
    asset_code: op.asset_a_code,
    asset_issuer: op.asset_a_issuer,
  });
  const amount = (op.amount as string) || '0';
  const minPrice = formatPrice((op.min_price ?? '') as string | { n: string; d: string });
  const maxPrice = formatPrice((op.max_price ?? '') as string | { n: string; d: string });
  const description = `${sourceAccount} withdrew ${amount} ${asset} from liquidity pool (price range ${minPrice} - ${maxPrice})`;
  return {
    index,
    type: 'liquidity_pool_withdraw',
    description,
    details: { source: sourceAccount, asset, amount, minPrice, maxPrice },
    supported: true,
  };
}

function analyzeCreatePassiveOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const description = `${sourceAccount} created passive sell offer: ${amount} ${sellingAsset} for ${buyingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'create_passive_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeOperation(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const type = (op.type as string) || 'unknown';
  const normalizedType = normalizeOperationType(type);

  switch (normalizedType) {
    case 'payment':
      return analyzePayment(op, index);
    case 'path_payment_strict_receive':
      return analyzePathPayment(op, index);
    case 'path_payment_strict_send':
      return analyzePathPaymentStrictSend(op, index);
    case 'create_account':
      return analyzeCreateAccount(op, index);
    case 'change_trust':
      return analyzeChangeTrust(op, index);
    case 'manage_sell_offer':
      return analyzeManageSellOffer(op, index);
    case 'manage_buy_offer':
      return analyzeManageBuyOffer(op, index);
    case 'create_passive_sell_offer':
      return analyzeCreatePassiveOffer(op, index);
    case 'account_merge':
      return analyzeAccountMerge(op, index);
    case 'set_options':
      return analyzeSetOptions(op, index);
    case 'allow_trust':
      return analyzeAllowTrust(op, index);
    case 'inflation':
      return analyzeInflation(op, index);
    case 'manage_data':
      return analyzeManageData(op, index);
    case 'bump_sequence':
      return analyzeBumpSequence(op, index);
    case 'create_claimable_balance':
      return analyzeCreateClaimableBalance(op, index);
    case 'claim_claimable_balance':
      return analyzeClaimClaimableBalance(op, index);
    case 'begin_sponsoring_future_reserves':
      return analyzeBeginSponsoring(op, index);
    case 'end_sponsoring_future_reserves':
      return analyzeEndSponsoring(op, index);
    case 'revoke_sponsorship':
      return analyzeRevokeSponsorship(op, index);
    case 'clawback':
      return analyzeClawback(op, index);
    case 'liquidity_pool_deposit':
      return analyzeLiquidityPoolDeposit(op, index);
    case 'liquidity_pool_withdraw':
      return analyzeLiquidityPoolWithdraw(op, index);
    default:
      return {
        index,
        type: normalizedType,
        description: `Unsupported operation type: ${normalizedType}`,
        details: { rawType: normalizedType },
        supported: false,
      };
  }
}

export function buildAssetMovements(operations: AnalyzedOperation[]): AssetSummary {
  const movements: AssetMovement[] = [];
  const seen = new Set<string>();

  for (const op of operations) {
    if (!op.supported) continue;

    const key = `${op.index}-${op.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      op.type === 'payment' ||
      op.type === 'path_payment_strict_receive' ||
      op.type === 'path_payment_strict_send'
    ) {
      movements.push({ type: 'payment', description: op.description });
    }

    if (op.type === 'create_account') {
      movements.push({ type: 'account_funded', description: op.description });
    }

    if (op.type === 'change_trust' && op.description.includes('created')) {
      movements.push({ type: 'trustline_created', description: op.description });
    }

    if (
      op.type === 'manage_sell_offer' ||
      op.type === 'manage_buy_offer' ||
      op.type === 'create_passive_sell_offer'
    ) {
      movements.push({ type: 'asset_exchanged', description: op.description });
    }

    if (op.type === 'account_merge') {
      movements.push({ type: 'account_merged', description: op.description });
    }
  }

  if (movements.length === 0 && operations.length > 0) {
    movements.push({ type: 'general', description: 'Transaction executed' });
  }

  return { movements };
}

export async function fetchTransactionDetails(
  options: FetchTransactionOptions,
): Promise<TransactionDetails> {
  const { horizonUrl, hash } = options;
  const response = await fetchTransaction(horizonUrl, hash);

  return {
    hash: response.hash,
    sourceAccount: response.source_account,
    ledger: response.ledger ?? null,
    successful: response.successful,
    feeCharged: String(response.fee_charged),
    maxFee: String(response.max_fee),
    memoType: response.memo_type,
    memoValue: response.memo ?? '',
    operationCount: response.operation_count,
    createdAt: response.created_at,
    horizonUrl,
  };
}

export async function fetchTransactionOperations(
  options: FetchTransactionOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  return fetchOperationsForTransaction(options.horizonUrl, options.hash);
}

export async function analyzeTransaction(
  options: FetchTransactionOptions,
): Promise<TransactionAnalysis> {
  const validation = validateTransactionHash(options.hash);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const transaction = await fetchTransactionDetails(options);
  const rawOps = await fetchTransactionOperations(options);

  const operations: AnalyzedOperation[] = rawOps.map((rec, index) =>
    analyzeOperation(rec as Record<string, unknown>, index),
  );

  const assetSummary = buildAssetMovements(operations);

  return { transaction, operations, assetSummary };
}

export { analyzeOperation, formatAsset };
