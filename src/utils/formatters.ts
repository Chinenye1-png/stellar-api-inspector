import { table, TableUserConfig } from 'table';
import chalk from 'chalk';

export function formatTable(data: string[][], headerColor = chalk.bold.cyan): string {
  if (data.length === 0) return '';

  const formattedData = data.map((row, index) => {
    if (index === 0) {
      return row.map((cell) => headerColor(cell));
    }
    return row;
  });

  const config: TableUserConfig = {
    border: {
      topBody: `─`,
      topJoin: `┬`,
      topLeft: `┌`,
      topRight: `┐`,
      bottomBody: `─`,
      bottomJoin: `┴`,
      bottomLeft: `└`,
      bottomRight: `┘`,
      bodyLeft: `│`,
      bodyRight: `│`,
      bodyJoin: `│`,
      joinBody: `─`,
      joinLeft: `├`,
      joinRight: `┤`,
      joinJoin: `┼`,
    },
  };

  return table(formattedData, config);
}

export function formatXlm(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} XLM`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Convert a base-reserve / ledger-header numeric value into a
 * human-readable string. Horizon returns base_reserve/base_fee as
 * either strings or numbers depending on version; normalize here.
 * Always suffix the unit ("stroops") so the table column reads
 * consistently whether the value is known or Unknown.
 */
function formatStroopValue(value: number | string | undefined | null): string {
  if (value === undefined || value === null) return 'Unknown stroops';
  return `${value} stroops`;
}

export function formatLedgerRows(ledger: {
  sequence: number;
  hash: string;
  prev_hash?: string;
  transaction_count: number;
  operation_count: number;
  successful_transaction_count?: number;
  closed_at: string;
  protocol_version?: number;
  base_fee?: number | string;
  base_reserve?: number | string;
  total_coins?: string;
  fee_pool?: string;
  max_tx_set_size?: number;
}): string[][] {
  const unknownValue = 'Unknown';
  const rows: string[][] = [
    ['Field', 'Value'],
    ['Sequence', String(ledger.sequence)],
    ['Hash', ledger.hash],
    ['Previous Hash', ledger.prev_hash || unknownValue],
    ['Transaction Count', String(ledger.transaction_count)],
    [
      'Successful Transaction Count',
      ledger.successful_transaction_count !== undefined
        ? String(ledger.successful_transaction_count)
        : unknownValue,
    ],
    ['Operation Count', String(ledger.operation_count)],
    ['Close Time', ledger.closed_at],
    [
      'Protocol Version',
      ledger.protocol_version !== undefined ? String(ledger.protocol_version) : unknownValue,
    ],
    ['Base Fee', formatStroopValue(ledger.base_fee)],
    ['Base Reserve', formatStroopValue(ledger.base_reserve)],
    [
      'Max Transaction Set Size',
      ledger.max_tx_set_size !== undefined ? String(ledger.max_tx_set_size) : unknownValue,
    ],
    ['Total Coins', ledger.total_coins ?? unknownValue],
    ['Fee Pool', ledger.fee_pool ?? unknownValue],
  ];
  return rows;
}

/**
 * Format a Horizon `_links.transactions.href` (or any templated link URL)
 * so it can be displayed in the CLI without overwhelming the output.
 */
export function formatLedgerLinksRows(ledger: {
  _links?: {
    transactions?: { href?: string };
    operations?: { href?: string };
    self?: { href?: string };
  };
}): string[][] {
  const rows: string[][] = [['Related Resource', 'URL']];
  const links = ledger._links;

  if (links?.self?.href) rows.push(['Self', links.self.href]);
  if (links?.transactions?.href) rows.push(['Transactions', links.transactions.href]);
  if (links?.operations?.href) rows.push(['Operations', links.operations.href]);

  if (rows.length === 1) {
    rows.push(['Related Resources', 'No related resources available']);
  }
  return rows;
}

export function formatFeeStatsRows(stats: {
  last_ledger_base_fee: string | number;
  ledger_capacity_usage: string;
  fee_charged: {
    min: string | number;
    mode?: string | number;
    max: string | number;
    p10: string | number;
    p50: string | number;
    p95?: string | number;
    p99: string | number;
  };
}): string[][] {
  return [
    ['Metric', 'Value'],
    ['Latest Ledger Base Fee', `${stats.last_ledger_base_fee} stroops`],
    ['Ledger Capacity Usage', `${Math.round(parseFloat(stats.ledger_capacity_usage) * 100)}%`],
    ['Min Accepted Fee', `${stats.fee_charged.min} stroops`],
    ['Mode Fee', `${stats.fee_charged.mode ?? stats.fee_charged.max} stroops`],
    ['P10 Fee', `${stats.fee_charged.p10} stroops`],
    ['P50 Fee', `${stats.fee_charged.p50} stroops`],
    ['P95 Fee', `${stats.fee_charged.p95 ?? stats.fee_charged.p99} stroops`],
    ['Maximum Fee', `${stats.fee_charged.max} stroops`],
  ];
}

/**
 * Severity labels shared by the audit report formatters below. Kept as a
 * small helper so each report renders severities consistently.
 */
function formatSeverity(severity: string): string {
  const normalized = severity.toLowerCase();
  switch (normalized) {
    case 'error':
    case 'critical':
    case 'high':
      return chalk.red(severity);
    case 'warning':
    case 'warn':
    case 'medium':
      return chalk.yellow(severity);
    case 'info':
    case 'low':
      return chalk.blue(severity);
    case 'pass':
    case 'ok':
    case 'success':
      return chalk.green(severity);
    default:
      return severity;
  }
}

/**
 * Render a list of findings as a table. Each finding may carry a severity,
 * a field/rule identifier, and a message. Used by the SEP-10 challenge audit
 * and the Horizon response consistency audit.
 */
export function formatFindingRows(
  findings: Array<{
    severity?: string;
    field?: string;
    rule?: string;
    message: string;
  }>,
): string[][] {
  const rows: string[][] = [['Severity', 'Field / Rule', 'Finding']];
  if (findings.length === 0) {
    rows.push(['pass', '-', 'No findings']);
    return rows;
  }
  for (const finding of findings) {
    rows.push([
      finding.severity ? formatSeverity(finding.severity) : 'info',
      finding.field ?? finding.rule ?? '-',
      finding.message,
    ]);
  }
  return rows;
}

/**
 * SEP-10 challenge transaction security audit report.
 *
 * Structural validation, signature verification, time-bound findings and
 * overall eligibility are reported separately so a decoded envelope or a
 * valid signature is never presented as complete authentication success.
 */
export function formatSep10ChallengeAuditRows(audit: {
  serverAccount: string;
  clientAccount: string;
  networkPassphrase?: string;
  structure: {
    sourceAccount?: string;
    sequenceNumber?: string;
    memo?: string;
    operationCount?: number;
    findings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  };
  signatures: {
    serverSignature?: string;
    clientSignature?: string;
    findings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  };
  timeBounds: {
    minTime?: string | number;
    maxTime?: string | number;
    findings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  };
  eligibility: string;
  limitations: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Server Account', audit.serverAccount]);
  rows.push(['Client Account', audit.clientAccount]);
  rows.push(['Network Passphrase', audit.networkPassphrase ?? 'Unknown']);
  rows.push(['Transaction Source', audit.structure.sourceAccount ?? 'Unknown']);
  rows.push(['Sequence Number', audit.structure.sequenceNumber ?? 'Unknown']);
  rows.push(['Memo', audit.structure.memo ?? 'None']);
  rows.push([
    'Operation Count',
    audit.structure.operationCount !== undefined ? String(audit.structure.operationCount) : 'Unknown',
  ]);
  rows.push(['Server Signature', audit.signatures.serverSignature ?? 'Not verified']);
  rows.push(['Client Signature', audit.signatures.clientSignature ?? 'Not verified']);
  rows.push(['Time Bounds (min)', audit.timeBounds.minTime ?? 'None']);
  rows.push(['Time Bounds (max)', audit.timeBounds.maxTime ?? 'None']);
  rows.push(['Challenge Eligibility', audit.eligibility]);
  rows.push([
    'Validation Limitations',
    audit.limitations.length > 0 ? audit.limitations.join('; ') : 'None reported',
  ]);
  return rows;
}

/**
 * SEP-10 challenge audit section tables: structure, signatures and time
 * bounds are each rendered as their own findings table.
 */
export function formatSep10ChallengeAuditSections(audit: {
  structure: { findings: Array<{ severity?: string; field?: string; rule?: string; message: string }> };
  signatures: { findings: Array<{ severity?: string; field?: string; rule?: string; message: string }> };
  timeBounds: { findings: Array<{ severity?: string; field?: string; rule?: string; message: string }> };
}): {
  structure: string[][];
  signatures: string[][];
  timeBounds: string[][];
} {
  return {
    structure: formatFindingRows(audit.structure.findings),
    signatures: formatFindingRows(audit.signatures.findings),
    timeBounds: formatFindingRows(audit.timeBounds.findings),
  };
}

/**
 * Account payment flow analysis report. Incoming and outgoing activity is
 * grouped by counterparty and asset identity (code + issuer). Transaction
 * and operation counts are reported separately to avoid double counting.
 */
export function formatPaymentFlowRows(flow: {
  account: string;
  range?: { from?: string | number; to?: string | number };
  incoming: Array<{
    counterparty: string;
    asset: string;
    transactionCount: number;
    operationCount: number;
    total: string;
  }>;
  outgoing: Array<{
    counterparty: string;
    asset: string;
    transactionCount: number;
    operationCount: number;
    total: string;
  }>;
  operationTypes?: Array<{ type: string; count: number }>;
  failedTransactions?: { count: number; note?: string };
  limitations: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Account', flow.account]);
  rows.push(['Range From', flow.range?.from ?? 'Unbounded']);
  rows.push(['Range To', flow.range?.to ?? 'Unbounded']);
  rows.push(['Incoming Groups', String(flow.incoming.length)]);
  rows.push(['Outgoing Groups', String(flow.outgoing.length)]);
  rows.push([
    'Failed Transactions',
    flow.failedTransactions
      ? `${flow.failedTransactions.count}${flow.failedTransactions.note ? ` (${flow.failedTransactions.note})` : ''}`
      : 'None reported',
  ]);
  rows.push([
    'Retrieval Limitations',
    flow.limitations.length > 0 ? flow.limitations.join('; ') : 'None reported',
  ]);
  return rows;
}

/**
 * Payment flow direction tables, rendered separately for incoming and
 * outgoing activity. Each row is a counterparty/asset group.
 */
export function formatPaymentFlowDirectionRows(
  groups: Array<{
    counterparty: string;
    asset: string;
    transactionCount: number;
    operationCount: number;
    total: string;
  }>,
): string[][] {
  const rows: string[][] = [['Counterparty', 'Asset', 'Transactions', 'Operations', 'Total']];
  if (groups.length === 0) {
    rows.push(['-', '-', '0', '0', '0']);
    return rows;
  }
  for (const group of groups) {
    rows.push([
      group.counterparty,
      group.asset,
      String(group.transactionCount),
      String(group.operationCount),
      group.total,
    ]);
  }
  return rows;
}

/**
 * Payment flow operation-type breakdown table.
 */
export function formatPaymentFlowOperationTypeRows(
  operationTypes: Array<{ type: string; count: number }>,
): string[][] {
  const rows: string[][] = [['Operation Type', 'Count']];
  if (operationTypes.length === 0) {
    rows.push(['-', '0']);
    return rows;
  }
  for (const entry of operationTypes) {
    rows.push([entry.type, String(entry.count)]);
  }
  return rows;
}

/**
 * Soroban contract event retention and pagination audit report. Summarizes
 * query context, observed ledger bounds, page status and completeness
 * limitations without asserting that missing events did not occur.
 */
export function formatSorobanEventRetentionRows(audit: {
  query?: {
    contractId?: string;
    topics?: string[];
    fromLedger?: number | string;
    toLedger?: number | string;
  };
  observedLedgerBounds?: { min?: number | string; max?: number | string };
  pageStatus: {
    pageCount: number;
    exhausted?: boolean;
    terminationReason?: string;
  };
  eventCount: number;
  duplicateFindings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  cursorFindings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  limitations: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Contract ID', audit.query?.contractId ?? 'Unknown']);
  rows.push([
    'Topics',
    audit.query?.topics && audit.query.topics.length > 0 ? audit.query.topics.join(', ') : 'None',
  ]);
  rows.push(['From Ledger', audit.query?.fromLedger ?? 'Unbounded']);
  rows.push(['To Ledger', audit.query?.toLedger ?? 'Unbounded']);
  rows.push(['Observed Min Ledger', audit.observedLedgerBounds?.min ?? 'Unknown']);
  rows.push(['Observed Max Ledger', audit.observedLedgerBounds?.max ?? 'Unknown']);
  rows.push(['Page Count', String(audit.pageStatus.pageCount)]);
  rows.push([
    'Retrieval Exhausted',
    audit.pageStatus.exhausted === undefined ? 'Unknown' : String(audit.pageStatus.exhausted),
  ]);
  rows.push(['Termination Reason', audit.pageStatus.terminationReason ?? 'Unknown']);
  rows.push(['Event Count', String(audit.eventCount)]);
  rows.push(['Duplicate Findings', String(audit.duplicateFindings.length)]);
  rows.push(['Cursor Findings', String(audit.cursorFindings.length)]);
  rows.push([
    'Completeness Limitations',
    audit.limitations.length > 0 ? audit.limitations.join('; ') : 'None reported',
  ]);
  return rows;
}

/**
 * Soroban event retention findings tables (duplicates and cursor issues).
 */
export function formatSorobanEventRetentionSections(audit: {
  duplicateFindings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
  cursorFindings: Array<{ severity?: string; field?: string; rule?: string; message: string }>;
}): {
  duplicates: string[][];
  cursors: string[][];
} {
  return {
    duplicates: formatFindingRows(audit.duplicateFindings),
    cursors: formatFindingRows(audit.cursorFindings),
  };
}

/**
 * Horizon transaction response consistency audit report. Separates
 * structural consistency checks from cryptographic verification and server
 * authenticity, and reports input metadata alongside the overall status.
 */
export function formatTransactionConsistencyRows(audit: {
  overallStatus: string;
  input?: {
    source?: string;
    transactionHash?: string;
    networkPassphrase?: string;
    horizonVersion?: string;
  };
  findings: Array<{
    severity?: string;
    field?: string;
    rule?: string;
    message: string;
    expected?: string;
    observed?: string;
  }>;
  limitations?: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Overall Status', formatSeverity(audit.overallStatus)]);
  rows.push(['Input Source', audit.input?.source ?? 'Unknown']);
  rows.push(['Transaction Hash', audit.input?.transactionHash ?? 'Unknown']);
  rows.push(['Network Passphrase', audit.input?.networkPassphrase ?? 'Unknown']);
  rows.push(['Horizon Version', audit.input?.horizonVersion ?? 'Unknown']);
  rows.push(['Finding Count', String(audit.findings.length)]);
  rows.push([
    'Limitations',
    audit.limitations && audit.limitations.length > 0 ? audit.limitations.join('; ') : 'None reported',
  ]);
  return rows;
}

/**
 * Horizon transaction response consistency findings table. Includes the
 * responsible field, severity, message and expected/observed values where
 * a comparison was possible.
 */
export function formatTransactionConsistencyFindingRows(
  findings: Array<{
    severity?: string;
    field?: string;
    rule?: string;
    message: string;
    expected?: string;
    observed?: string;
  }>,
): string[][] {
  const rows: string[][] = [['Severity', 'Field / Rule', 'Expected', 'Observed', 'Finding']];
  if (findings.length === 0) {
    rows.push(['pass', '-', '-', '-', 'No findings']);
    return rows;
  }
  for (const finding of findings) {
    rows.push([
      finding.severity ? formatSeverity(finding.severity) : 'info',
      finding.field ?? finding.rule ?? '-',
      finding.expected ?? '-',
      finding.observed ?? '-',
      finding.message,
    ]);
  }
  return rows;
}
