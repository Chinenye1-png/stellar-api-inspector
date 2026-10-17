import {
  HorizonClient,
  HorizonTransaction,
  HorizonOperation,
  HorizonPage,
} from './horizon-client';
import {
  normalizeOperation,
  normalizeOperationType,
  NormalizedOperation,
} from '../utils/operation-parser';
import {
  getAssetIdentity,
  AssetIdentity,
  formatAssetIdentity,
  isNativeAsset,
} from '../utils/assets';

/**
 * Payment flow and counterparty activity analysis.
 *
 * This module is strictly read-only. It summarizes *observable* on-chain
 * payment activity for a single Stellar account over a bounded time or ledger
 * range. It does not reconstruct off-chain transfers and does not infer the
 * real-world identity of any counterparty beyond the on-chain account IDs that
 * appear in the retrieved records.
 */

export type PaymentFlowDirection = 'incoming' | 'outgoing' | 'self';

export type PaymentOperationKind =
  | 'payment'
  | 'path_payment_strict_send'
  | 'path_payment_strict_receive'
  | 'account_merge'
  | 'clawback'
  | 'liquidity_pool_deposit'
  | 'liquidity_pool_withdraw'
  | 'other';

export interface PaymentFlowRange {
  /** Inclusive lower bound (ISO 8601 timestamp) for transaction created_at. */
  from?: string;
  /** Exclusive upper bound (ISO 8601 timestamp) for transaction created_at. */
  to?: string;
  /** Inclusive lower bound ledger sequence. */
  fromLedger?: number;
  /** Inclusive upper bound ledger sequence. */
  toLedger?: number;
}

export interface PaymentFlowOptions {
  accountId: string;
  range?: PaymentFlowRange;
  /** Include failed transaction attempts in a separate diagnostic summary. */
  includeFailed?: boolean;
  /** Maximum number of pages to retrieve before reporting incomplete history. */
  maxPages?: number;
  /** Page size passed to Horizon. */
  pageSize?: number;
}

export interface AssetTotals {
  asset: AssetIdentity;
  /** Exact total amount as an integer string of stroops. */
  totalStroops: string;
  /** Human-readable decimal representation of totalStroops. */
  total: string;
  /** Number of distinct operations contributing to this total. */
  operationCount: number;
  /** Number of distinct transactions contributing to this total. */
  transactionCount: number;
}

export interface CounterpartyActivity {
  /** On-chain account identifier of the counterparty. */
  counterparty: string;
  direction: PaymentFlowDirection;
  /** Totals grouped by asset identity (code + issuer). */
  assets: AssetTotals[];
  /** Distinct operation IDs observed for this counterparty/direction. */
  operationCount: number;
  /** Distinct transaction hashes observed for this counterparty/direction. */
  transactionCount: number;
}

export interface PaymentFlowTotals {
  incoming: AssetTotals[];
  outgoing: AssetTotals[];
  self: AssetTotals[];
}

export interface FailedTransactionSummary {
  transactionHash: string;
  ledger?: number;
  createdAt?: string;
  operationCount: number;
  kinds: PaymentOperationKind[];
}

export interface PaymentFlowLimitations {
  /** True when pagination stopped before exhausting available records. */
  incompletePagination: boolean;
  /** True when Horizon reported no records for the account/range. */
  missingHistory: boolean;
  /** Human-readable API / retrieval errors encountered. */
  errors: string[];
  /** Number of pages successfully retrieved. */
  pagesRetrieved: number;
}

export interface PaymentFlowReport {
  account: string;
  range: PaymentFlowRange;
  generatedAt: string;
  totals: PaymentFlowTotals;
  counterparties: CounterpartyActivity[];
  /** Diagnostic summary of failed transaction attempts (never counted as completed). */
  failedTransactions: FailedTransactionSummary[];
  limitations: PaymentFlowLimitations;
  /** Operation kinds included in this analysis. */
  includedOperationKinds: PaymentOperationKind[];
}

const INCLUDED_OPERATION_KINDS: PaymentOperationKind[] = [
  'payment',
  'path_payment_strict_send',
  'path_payment_strict_receive',
  'account_merge',
  'clawback',
  'liquidity_pool_deposit',
  'liquidity_pool_withdraw',
];

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_SIZE = 200;

/**
 * Internal accumulator keyed by direction + counterparty + asset identity.
 */
interface FlowBucket {
  direction: PaymentFlowDirection;
  counterparty: string;
  asset: AssetIdentity;
  totalStroops: bigint;
  operationIds: Set<string>;
  transactionHashes: Set<string>;
}

/**
 * Convert a decimal amount string (as returned by Horizon) into an exact
 * integer number of stroops (1 XLM = 10^7 stroops). Issued assets are treated
 * with the same 7-decimal precision Horizon uses for display.
 */
export function amountToStroops(amount: string): bigint {
  if (amount === undefined || amount === null) {
    return 0n;
  }
  const trimmed = String(amount).trim();
  if (trimmed === '') {
    return 0n;
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPartRaw = ''] = unsigned.split('.');
  const fracPart = (fracPartRaw + '0000000').slice(0, 7);
  const whole = wholePart === '' ? '0' : wholePart;
  if (!/^\d+$/.test(whole) || !/^\d+$/.test(fracPart)) {
    throw new Error(`Invalid amount value: ${amount}`);
  }
  const stroops = BigInt(whole) * 10000000n + BigInt(fracPart);
  return negative ? -stroops : stroops;
}

/**
 * Convert an exact integer number of stroops into a decimal string.
 */
export function stroopsToAmount(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10000000n;
  const frac = abs % 10000000n;
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

function bucketKey(
  direction: PaymentFlowDirection,
  counterparty: string,
  asset: AssetIdentity,
): string {
  return `${direction}|${counterparty}|${formatAssetIdentity(asset)}`;
}

function classifyOperationKind(op: NormalizedOperation): PaymentOperationKind {
  const type = normalizeOperationType(op);
  switch (type) {
    case 'payment':
      return 'payment';
    case 'path_payment_strict_send':
      return 'path_payment_strict_send';
    case 'path_payment_strict_receive':
      return 'path_payment_strict_receive';
    case 'account_merge':
      return 'account_merge';
    case 'clawback':
      return 'clawback';
    case 'liquidity_pool_deposit':
      return 'liquidity_pool_deposit';
    case 'liquidity_pool_withdraw':
      return 'liquidity_pool_withdraw';
    default:
      return 'other';
  }
}

/**
 * Determine the counterparty and asset identity for a payment-related
 * operation, relative to the analyzed account. Returns null when the operation
 * is not a supported payment-related operation or does not involve the account.
 */
function resolveFlow(
  op: NormalizedOperation,
  accountId: string,
): { direction: PaymentFlowDirection; counterparty: string; asset: AssetIdentity } | null {
  const kind = classifyOperationKind(op);
  if (!INCLUDED_OPERATION_KINDS.includes(kind)) {
    return null;
  }

  const source = op.sourceAccount ?? op.source_account;
  const raw = op.raw ?? op;

  switch (kind) {
    case 'payment': {
      const from = raw.from ?? source;
      const to = raw.to;
      const asset = getAssetIdentity(raw.asset ?? raw);
      if (from === accountId && to === accountId) {
        return { direction: 'self', counterparty: accountId, asset };
      }
      if (from === accountId && to) {
        return { direction: 'outgoing', counterparty: to, asset };
      }
      if (to === accountId && from) {
        return { direction: 'incoming', counterparty: from, asset };
      }
      return null;
    }
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive': {
      const from = raw.from ?? source;
      const to = raw.to;
      const asset =
        kind === 'path_payment_strict_send'
          ? getAssetIdentity(raw.source_asset ?? raw.sourceAsset ?? raw.asset ?? raw)
          : getAssetIdentity(raw.destination_asset ?? raw.destinationAsset ?? raw.asset ?? raw);
      if (from === accountId && to === accountId) {
        return { direction: 'self', counterparty: accountId, asset };
      }
      if (from === accountId && to) {
        return { direction: 'outgoing', counterparty: to, asset };
      }
      if (to === accountId && from) {
        return { direction: 'incoming', counterparty: from, asset };
      }
      return null;
    }
    case 'account_merge': {
      const into = raw.into ?? raw.destination;
      const from = raw.account ?? source;
      const asset = getAssetIdentity({ native: true });
      if (from === accountId && into === accountId) {
        return { direction: 'self', counterparty: accountId, asset };
      }
      if (from === accountId && into) {
        return { direction: 'outgoing', counterparty: into, asset };
      }
      if (into === accountId && from) {
        return { direction: 'incoming', counterparty: from, asset };
      }
      return null;
    }
    case 'clawback': {
      const from = raw.from ?? raw.account ?? source;
      const to = raw.asset_issuer ?? raw.assetIssuer;
      const asset = getAssetIdentity(raw.asset ?? raw);
      if (from === accountId && to === accountId) {
        return { direction: 'self', counterparty: accountId, asset };
      }
      if (from === accountId && to) {
        return { direction: 'outgoing', counterparty: to, asset };
      }
      if (to === accountId && from) {
        return { direction: 'incoming', counterparty: from, asset };
      }
      return null;
    }
    case 'liquidity_pool_deposit':
    case 'liquidity_pool_withdraw': {
      const from = raw.source ?? source;
      const poolId = raw.liquidity_pool_id ?? raw.liquidityPoolId;
      const asset = getAssetIdentity(raw.asset ?? raw);
      if (from === accountId && poolId) {
        return { direction: 'outgoing', counterparty: poolId, asset };
      }
      if (poolId === accountId && from) {
        return { direction: 'incoming', counterparty: from, asset };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract the amount for a payment-related operation as an exact stroop value.
 */
function resolveAmount(op: NormalizedOperation): bigint {
  const raw = op.raw ?? op;
  const amount = raw.amount ?? raw.starting_balance ?? raw.startingBalance ?? '0';
  return amountToStroops(String(amount));
}

function isFailedTransaction(tx: HorizonTransaction): boolean {
  return tx.successful === false;
}

function txCreatedAt(tx: HorizonTransaction): string | undefined {
  return tx.created_at ?? tx.createdAt;
}

function txLedger(tx: HorizonTransaction): number | undefined {
  return tx.ledger;
}

function inRange(tx: HorizonTransaction, range: PaymentFlowRange): boolean {
  const createdAt = txCreatedAt(tx);
  if (range.from && createdAt && createdAt < range.from) {
    return false;
  }
  if (range.to && createdAt && createdAt >= range.to) {
    return false;
  }
  const ledger = txLedger(tx);
  if (range.fromLedger !== undefined && ledger !== undefined && ledger < range.fromLedger) {
    return false;
  }
  if (range.toLedger !== undefined && ledger !== undefined && ledger > range.toLedger) {
    return false;
  }
  return true;
}

/**
 * Analyze observable payment flow for an account over a bounded range.
 */
export async function analyzePaymentFlow(
  client: HorizonClient,
  options: PaymentFlowOptions,
): Promise<PaymentFlowReport> {
  const accountId = options.accountId;
  const range = options.range ?? {};
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const buckets = new Map<string, FlowBucket>();
  const failedTransactions: FailedTransactionSummary[] = [];
  const errors: string[] = [];
  let pagesRetrieved = 0;
  let incompletePagination = false;
  let missingHistory = false;
  let sawAnyRecord = false;

  const seenOperationIds = new Set<string>();

  let page: HorizonPage<HorizonTransaction> | undefined;
  try {
    page = await client.getAccountTransactions(accountId, { limit: pageSize });
  } catch (err) {
    errors.push(`Failed to retrieve transactions: ${(err as Error).message}`);
    missingHistory = true;
  }

  while (page) {
    pagesRetrieved += 1;
    const records = page.records ?? [];
    if (records.length > 0) {
      sawAnyRecord = true;
    }

    for (const tx of records) {
      if (!inRange(tx, range)) {
        continue;
      }

      let operations: HorizonOperation[] = [];
      try {
        operations = await client.getTransactionOperations(tx.hash);
      } catch (err) {
        errors.push(
          `Failed to retrieve operations for transaction ${tx.hash}: ${(err as Error).message}`,
        );
        continue;
      }

      const normalized = operations.map((op) => normalizeOperation(op));

      if (isFailedTransaction(tx)) {
        if (options.includeFailed) {
          const kinds = normalized
            .map((op) => classifyOperationKind(op))
            .filter((kind) => INCLUDED_OPERATION_KINDS.includes(kind));
          if (kinds.length > 0) {
            failedTransactions.push({
              transactionHash: tx.hash,
              ledger: txLedger(tx),
              createdAt: txCreatedAt(tx),
              operationCount: kinds.length,
              kinds,
            });
          }
        }
        // Failed transactions are never counted as completed transfers.
        continue;
      }

      for (const op of normalized) {
        const opId = op.id ?? op.operationId ?? `${tx.hash}:${op.index ?? op.applicationOrder ?? ''}`;
        if (seenOperationIds.has(opId)) {
          // Avoid double-counting the same operation across pages/records.
          continue;
        }

        const flow = resolveFlow(op, accountId);
        if (!flow) {
          continue;
        }

        seenOperationIds.add(opId);

        const key = bucketKey(flow.direction, flow.counterparty, flow.asset);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            direction: flow.direction,
            counterparty: flow.counterparty,
            asset: flow.asset,
            totalStroops: 0n,
            operationIds: new Set<string>(),
            transactionHashes: new Set<string>(),
          };
          buckets.set(key, bucket);
        }

        bucket.totalStroops += resolveAmount(op);
        bucket.operationIds.add(opId);
        bucket.transactionHashes.add(tx.hash);
      }
    }

    if (pagesRetrieved >= maxPages && page.next) {
      incompletePagination = true;
      break;
    }

    if (!page.next) {
      break;
    }

    try {
      page = await client.getPage<HorizonTransaction>(page.next);
    } catch (err) {
      errors.push(`Failed to retrieve next page: ${(err as Error).message}`);
      incompletePagination = true;
      break;
    }
  }

  if (!sawAnyRecord) {
    missingHistory = true;
  }

  const counterparties = buildCounterpartyActivities(buckets);
  const totals = buildTotals(buckets);

  return {
    account: accountId,
    range,
    generatedAt: new Date().toISOString(),
    totals,
    counterparties,
    failedTransactions,
    limitations: {
      incompletePagination,
      missingHistory,
      errors,
      pagesRetrieved,
    },
    includedOperationKinds: INCLUDED_OPERATION_KINDS,
  };
}

function buildCounterpartyActivities(buckets: Map<string, FlowBucket>): CounterpartyActivity[] {
  const byCounterparty = new Map<string, CounterpartyActivity>();

  for (const bucket of buckets.values()) {
    const key = `${bucket.direction}|${bucket.counterparty}`;
    let activity = byCounterparty.get(key);
    if (!activity) {
      activity = {
        counterparty: bucket.counterparty,
        direction: bucket.direction,
        assets: [],
        operationCount: 0,
        transactionCount: 0,
      };
      byCounterparty.set(key, activity);
    }

    activity.assets.push({
      asset: bucket.asset,
      totalStroops: bucket.totalStroops.toString(),
      total: stroopsToAmount(bucket.totalStroops),
      operationCount: bucket.operationIds.size,
      transactionCount: bucket.transactionHashes.size,
    });
    activity.operationCount += bucket.operationIds.size;
    activity.transactionCount += bucket.transactionHashes.size;
  }

  const result = Array.from(byCounterparty.values());
  for (const activity of result) {
    activity.assets.sort((a, b) =>
      formatAssetIdentity(a.asset).localeCompare(formatAssetIdentity(b.asset)),
    );
  }
  result.sort((a, b) => {
    if (a.direction !== b.direction) {
      return a.direction.localeCompare(b.direction);
    }
    return a.counterparty.localeCompare(b.counterparty);
  });
  return result;
}

function buildTotals(buckets: Map<string, FlowBucket>): PaymentFlowTotals {
  const incoming = new Map<string, AssetTotals>();
  const outgoing = new Map<string, AssetTotals>();
  const self = new Map<string, AssetTotals>();

  const targetFor = (direction: PaymentFlowDirection) => {
    if (direction === 'incoming') return incoming;
    if (direction === 'outgoing') return outgoing;
    return self;
  };

  for (const bucket of buckets.values()) {
    const target = targetFor(bucket.direction);
    const assetKey = formatAssetIdentity(bucket.asset);
    let entry = target.get(assetKey);
    if (!entry) {
      entry = {
        asset: bucket.asset,
        totalStroops: '0',
        total: '0',
        operationCount: 0,
        transactionCount: 0,
      };
      target.set(assetKey, entry);
    }
    const combined = BigInt(entry.totalStroops) + bucket.totalStroops;
    entry.totalStroops = combined.toString();
    entry.total = stroopsToAmount(combined);
    entry.operationCount += bucket.operationIds.size;
    entry.transactionCount += bucket.transactionHashes.size;
  }

  const toSortedArray = (map: Map<string, AssetTotals>): AssetTotals[] =>
    Array.from(map.values()).sort((a, b) =>
      formatAssetIdentity(a.asset).localeCompare(formatAssetIdentity(b.asset)),
    );

  return {
    incoming: toSortedArray(incoming),
    outgoing: toSortedArray(outgoing),
    self: toSortedArray(self),
  };
}

/**
 * Render a human-readable terminal report.
 */
export function formatPaymentFlowReport(report: PaymentFlowReport): string {
  const lines: string[] = [];
  lines.push(`Payment Flow Analysis`);
  lines.push(`Account: ${report.account}`);
  lines.push(`Generated: ${report.generatedAt}`);

  const rangeParts: string[] = [];
  if (report.range.from) rangeParts.push(`from ${report.range.from}`);
  if (report.range.to) rangeParts.push(`to ${report.range.to}`);
  if (report.range.fromLedger !== undefined) rangeParts.push(`fromLedger ${report.range.fromLedger}`);
  if (report.range.toLedger !== undefined) rangeParts.push(`toLedger ${report.range.toLedger}`);
  lines.push(`Range: ${rangeParts.length > 0 ? rangeParts.join(', ') : 'unbounded'}`);
  lines.push('');

  const renderTotals = (label: string, totals: AssetTotals[]) => {
    lines.push(`${label}:`);
    if (totals.length === 0) {
      lines.push('  (none)');
    } else {
      for (const t of totals) {
        lines.push(
          `  ${formatAssetIdentity(t.asset)}: ${t.total} ` +
            `(${t.operationCount} ops, ${t.transactionCount} txs)`,
        );
      }
    }
    lines.push('');
  };

  renderTotals('Incoming totals', report.totals.incoming);
  renderTotals('Outgoing totals', report.totals.outgoing);
  if (report.totals.self.length > 0) {
    renderTotals('Self-transfers', report.totals.self);
  }

  lines.push('Counterparties:');
  if (report.counterparties.length === 0) {
    lines.push('  (none)');
  } else {
    for (const cp of report.counterparties) {
      lines.push(`  [${cp.direction}] ${cp.counterparty}`);
      for (const asset of cp.assets) {
        lines.push(
          `    ${formatAssetIdentity(asset.asset)}: ${asset.total} ` +
            `(${asset.operationCount} ops, ${asset.transactionCount} txs)`,
        );
      }
    }
  }
  lines.push('');

  if (report.failedTransactions.length > 0) {
    lines.push('Failed transaction attempts (not counted as completed payments):');
    for (const failed of report.failedTransactions) {
      lines.push(
        `  ${failed.transactionHash} (${failed.operationCount} ops: ${failed.kinds.join(', ')})`,
      );
    }
    lines.push('');
  }

  lines.push('Limitations:');
  lines.push(`  Pages retrieved: ${report.limitations.pagesRetrieved}`);
  if (report.limitations.incompletePagination) {
    lines.push('  Incomplete pagination: additional records may exist.');
  }
  if (report.limitations.missingHistory) {
    lines.push('  Missing history: no records found for the account/range.');
  }
  for (const error of report.limitations.errors) {
    lines.push(`  Error: ${error}`);
  }
  lines.push('');
  lines.push(
    'Note: This report summarizes observable on-chain activity only. It does not ' +
      'reconstruct off-chain transfers or identify real-world counterparties.',
  );

  return lines.join('\n');
}

/**
 * Serialize the report to machine-readable JSON.
 */
export function toPaymentFlowJson(report: PaymentFlowReport): string {
  return JSON.stringify(report, null, 2);
}