import chalk from 'chalk';
import { formatTable, formatXlm } from './format-helpers';
import type {
  BalanceReconciliationResult,
  BalanceReconciliationFinding,
  TrustlineBalanceChange,
  LiabilityComparison,
  InferredExplanation,
} from '../types/balance-reconciliation';

/**
 * Formats a balance reconciliation result into a human-readable string.
 *
 * This is a pure function with no I/O. It renders:
 *  - account/network validation findings
 *  - native XLM before/after/difference
 *  - issued-asset trustline changes grouped by code+issuer
 *  - liability/reserve/sponsorship comparisons (only when compatible data is present)
 *  - an explicitly labeled "Inferred explanations (not confirmed)" section
 *
 * The output makes clear that the tool does not claim complete accounting
 * reconciliation when ledger events or intermediate snapshots are missing.
 */
export function formatBalanceReconciliationReport(
  result: BalanceReconciliationResult,
): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Account Balance Reconciliation'));
  lines.push('');

  // ---------------------------------------------------------------------------
  // Account / network validation findings
  // ---------------------------------------------------------------------------
  lines.push(chalk.bold('Account & Network Validation'));
  lines.push('');

  const validationFindings = result.findings.filter(
    (f) =>
      f.category === 'account' ||
      f.category === 'network' ||
      f.category === 'snapshot',
  );

  if (validationFindings.length === 0) {
    lines.push(chalk.green('  ✓ Snapshots refer to the same account and compatible networks.'));
  } else {
    for (const finding of validationFindings) {
      lines.push(`  ${formatFinding(finding)}`);
    }
  }
  lines.push('');

  // ---------------------------------------------------------------------------
  // Native XLM balance
  // ---------------------------------------------------------------------------
  lines.push(chalk.bold('Native XLM Balance'));
  lines.push('');

  if (result.nativeBalance) {
    const nb = result.nativeBalance;
    const rows: string[][] = [
      ['Before', formatXlm(nb.before)],
      ['After', formatXlm(nb.after)],
      ['Difference', formatSignedXlm(nb.difference)],
    ];
    lines.push(indent(formatTable(['Field', 'Value'], rows), '  '));
    if (nb.status) {
      lines.push(`  Status: ${formatStatus(nb.status)}`);
    }
  } else {
    lines.push(chalk.yellow('  Native XLM balance comparison unavailable (missing or incompatible data).'));
  }
  lines.push('');

  // ---------------------------------------------------------------------------
  // Issued-asset trustline changes
  // ---------------------------------------------------------------------------
  lines.push(chalk.bold('Issued-Asset Trustline Changes'));
  lines.push('');

  const trustlineChanges = result.trustlineChanges ?? [];
  if (trustlineChanges.length === 0) {
    lines.push(chalk.dim('  No issued-asset trustline changes detected.'));
  } else {
    const added = trustlineChanges.filter((c) => c.classification === 'added');
    const removed = trustlineChanges.filter((c) => c.classification === 'removed');
    const changed = trustlineChanges.filter((c) => c.classification === 'changed');
    const unchanged = trustlineChanges.filter((c) => c.classification === 'unchanged');

    if (added.length > 0) {
      lines.push(chalk.bold('  Added Trustlines'));
      lines.push(indent(formatTrustlineTable(added), '    '));
      lines.push('');
    }

    if (removed.length > 0) {
      lines.push(chalk.bold('  Removed Trustlines'));
      lines.push(indent(formatTrustlineTable(removed), '    '));
      lines.push('');
    }

    if (changed.length > 0) {
      lines.push(chalk.bold('  Balance Changes on Existing Trustlines'));
      lines.push(indent(formatTrustlineTable(changed), '    '));
      lines.push('');
    }

    if (unchanged.length > 0) {
      lines.push(chalk.bold('  Unchanged Trustlines'));
      lines.push(indent(formatTrustlineTable(unchanged), '    '));
      lines.push('');
    }
  }

  // ---------------------------------------------------------------------------
  // Liability / reserve / sponsorship comparisons
  // ---------------------------------------------------------------------------
  const liabilityComparisons = result.liabilityComparisons ?? [];
  const reserveComparisons = result.reserveComparisons ?? [];
  const sponsorshipComparisons = result.sponsorshipComparisons ?? [];

  if (
    liabilityComparisons.length > 0 ||
    reserveComparisons.length > 0 ||
    sponsorshipComparisons.length > 0
  ) {
    lines.push(chalk.bold('Liability, Reserve & Sponsorship Comparisons'));
    lines.push('');

    if (liabilityComparisons.length > 0) {
      lines.push(chalk.bold('  Liabilities'));
      lines.push(indent(formatLiabilityTable(liabilityComparisons), '    '));
      lines.push('');
    }

    if (reserveComparisons.length > 0) {
      lines.push(chalk.bold('  Reserves'));
      lines.push(indent(formatFieldComparisonTable(reserveComparisons), '    '));
      lines.push('');
    }

    if (sponsorshipComparisons.length > 0) {
      lines.push(chalk.bold('  Sponsorship'));
      lines.push(indent(formatFieldComparisonTable(sponsorshipComparisons), '    '));
      lines.push('');
    }
  } else {
    lines.push(chalk.bold('Liability, Reserve & Sponsorship Comparisons'));
    lines.push('');
    lines.push(chalk.dim('  No compatible liability, reserve, or sponsorship data available for comparison.'));
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Inferred explanations (not confirmed)
  // ---------------------------------------------------------------------------
  const inferred = result.inferredExplanations ?? [];
  lines.push(chalk.bold('Inferred explanations (not confirmed)'));
  lines.push('');

  if (inferred.length === 0) {
    lines.push(chalk.dim('  No transaction or operation records supplied for correlation.'));
  } else {
    lines.push(
      chalk.yellow(
        '  The following explanations are inferred from available activity records and are NOT confirmed causes.',
      ),
    );
    lines.push('');
    for (const explanation of inferred) {
      lines.push(formatInferredExplanation(explanation));
    }
  }
  lines.push('');

  // ---------------------------------------------------------------------------
  // Unmatched / low-confidence findings
  // ---------------------------------------------------------------------------
  const unmatchedFindings = result.findings.filter(
    (f) =>
      f.category === 'unmatched' ||
      f.category === 'incomplete' ||
      f.category === 'inconsistent',
  );

  if (unmatchedFindings.length > 0) {
    lines.push(chalk.bold('Unmatched or Low-Confidence Items'));
    lines.push('');
    for (const finding of unmatchedFindings) {
      lines.push(`  ${formatFinding(finding)}`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Overall reconciliation status & disclaimer
  // ---------------------------------------------------------------------------
  lines.push(chalk.bold('Reconciliation Status'));
  lines.push('');
  lines.push(`  ${formatStatus(result.status)}`);
  lines.push('');
  lines.push(
    chalk.dim(
      '  Note: This tool does not claim complete accounting reconciliation. Fees, reserves,',
    ),
  );
  lines.push(
    chalk.dim(
      '  sponsorship, clawbacks, liquidity pool interactions, and other ledger changes can',
    ),
  );
  lines.push(
    chalk.dim(
      '  affect balances. A balance difference cannot always be explained by the available',
    ),
  );
  lines.push(
    chalk.dim(
      '  activity records, and unexplained differences are not evidence of loss or fraud.',
    ),
  );

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

function formatSignedXlm(value: string): string {
  const formatted = formatXlm(value);
  if (value.startsWith('-')) {
    return chalk.red(formatted);
  }
  if (value === '0' || value === '0.0000000' || /^0(\.0+)?$/.test(value)) {
    return chalk.dim(formatted);
  }
  return chalk.green(`+${formatted}`);
}

function formatStatus(status: string): string {
  switch (status) {
    case 'reconciled':
      return chalk.green('reconciled');
    case 'partially-reconciled':
      return chalk.yellow('partially reconciled');
    case 'unreconciled':
      return chalk.red('unreconciled');
    case 'incompatible':
      return chalk.red('incompatible snapshots');
    case 'incomplete':
      return chalk.yellow('incomplete data');
    default:
      return status;
  }
}

function formatFinding(finding: BalanceReconciliationFinding): string {
  const icon =
    finding.severity === 'error'
      ? chalk.red('✗')
      : finding.severity === 'warning'
        ? chalk.yellow('!')
        : chalk.blue('i');
  const message =
    finding.severity === 'error'
      ? chalk.red(finding.message)
      : finding.severity === 'warning'
        ? chalk.yellow(finding.message)
        : finding.message;
  return `${icon} ${message}`;
}

function formatAssetIdentity(code: string, issuer?: string): string {
  if (code === 'XLM' || !issuer) {
    return code;
  }
  return `${code}:${issuer}`;
}

function formatTrustlineTable(changes: TrustlineBalanceChange[]): string {
  const rows: string[][] = changes.map((change) => {
    const asset = formatAssetIdentity(change.assetCode, change.assetIssuer);
    const before = change.before != null ? formatXlm(change.before) : chalk.dim('—');
    const after = change.after != null ? formatXlm(change.after) : chalk.dim('—');
    const diff =
      change.difference != null
        ? formatSignedXlm(change.difference)
        : chalk.dim('—');
    return [asset, before, after, diff, formatStatus(change.classification)];
  });
  return formatTable(['Asset', 'Before', 'After', 'Difference', 'Status'], rows);
}

function formatLiabilityTable(comparisons: LiabilityComparison[]): string {
  const rows: string[][] = comparisons.map((c) => {
    const asset = formatAssetIdentity(c.assetCode, c.assetIssuer);
    const before = c.before != null ? formatXlm(c.before) : chalk.dim('—');
    const after = c.after != null ? formatXlm(c.after) : chalk.dim('—');
    const diff =
      c.difference != null ? formatSignedXlm(c.difference) : chalk.dim('—');
    return [asset, c.field, before, after, diff];
  });
  return formatTable(['Asset', 'Field', 'Before', 'After', 'Difference'], rows);
}

function formatFieldComparisonTable(
  comparisons: Array<{
    field: string;
    before?: string | null;
    after?: string | null;
    difference?: string | null;
  }>,
): string {
  const rows: string[][] = comparisons.map((c) => {
    const before = c.before != null ? c.before : chalk.dim('—');
    const after = c.after != null ? c.after : chalk.dim('—');
    const diff =
      c.difference != null ? formatSignedXlm(c.difference) : chalk.dim('—');
    return [c.field, before, after, diff];
  });
  return formatTable(['Field', 'Before', 'After', 'Difference'], rows);
}

function formatInferredExplanation(explanation: InferredExplanation): string {
  const asset = explanation.assetCode
    ? formatAssetIdentity(explanation.assetCode, explanation.assetIssuer)
    : undefined;
  const header = asset
    ? chalk.yellow(`  • ${asset}`)
    : chalk.yellow('  •');
  const lines: string[] = [header];
  lines.push(`      ${explanation.description}`);
  if (explanation.confidence) {
    lines.push(`      Confidence: ${explanation.confidence}`);
  }
  if (explanation.evidence && explanation.evidence.length > 0) {
    for (const ev of explanation.evidence) {
      lines.push(chalk.dim(`      - ${ev}`));
    }
  }
  return lines.join('\n');
}