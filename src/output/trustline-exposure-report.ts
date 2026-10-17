import chalk from 'chalk';
import { formatTable } from './format-table';

/**
 * ISSUE-093: Trustline exposure and issuer concentration audit report.
 *
 * This module renders a human-readable view of a trustline exposure audit
 * result. It is a pure function with no I/O side effects.
 *
 * The audit is a read-only portfolio inspection aid. It is NOT a financial
 * risk rating, credit assessment, or investment recommendation. Concentration
 * figures describe the distribution of reported balances only and must not be
 * interpreted as an indicator of issuer safety, solvency, or fraud.
 */

export type TrustlineAuthorizationStatus =
  | 'authorized'
  | 'unauthorized'
  | 'authorized-to-maintain-liabilities'
  | 'unknown';

export interface TrustlineAssetIdentity {
  /** Asset code, e.g. "USDC". Never merged across issuers. */
  code: string;
  /** Issuer account ID (G...). */
  issuer: string;
}

export interface TrustlineExposureEntry {
  asset: TrustlineAssetIdentity;
  /** Reported balance as a decimal string to preserve precision. */
  balance: string;
  /** Trust limit as a decimal string, or null when unavailable. */
  limit: string | null;
  authorization: TrustlineAuthorizationStatus;
  /** Buying liabilities as a decimal string, or null when unavailable. */
  buyingLiabilities: string | null;
  /** Selling liabilities as a decimal string, or null when unavailable. */
  sellingLiabilities: string | null;
  /** True when this entry is a liquidity pool share, not an issued asset. */
  isLiquidityPoolShare?: boolean;
  /** True when the reported balance is negative. */
  isNegative?: boolean;
}

export interface IssuerClawbackConfig {
  /** Whether clawback is enabled for the issuer's asset, when known. */
  clawbackEnabled: boolean | null;
  /** Whether the issuer account has the auth-clawback-enabled flag, when known. */
  authClawbackEnabled: boolean | null;
  /** Whether auth-required is set on the issuer account, when known. */
  authRequired: boolean | null;
  /** Whether auth-revocable is set on the issuer account, when known. */
  authRevocable: boolean | null;
}

export interface IssuerGroup {
  issuer: string;
  /** Clawback / authorization configuration, when available. */
  clawback: IssuerClawbackConfig | null;
  entries: TrustlineExposureEntry[];
  /** Sum of positive reported balances across this issuer's entries, as a decimal string. */
  totalPositiveBalance: string;
  /** Number of trustlines associated with this issuer. */
  trustlineCount: number;
}

export interface ConcentrationShare {
  issuer: string;
  /** Share of total positive balance, as a decimal string percentage (e.g. "42.50"). */
  percentage: string;
}

export type ConcentrationMode = 'raw-quantity' | 'currency-valued';

export interface ConcentrationSummary {
  mode: ConcentrationMode;
  /**
   * Valuation currency when mode is 'currency-valued'. Null for raw-quantity
   * concentration.
   */
  currency: string | null;
  /** Source metadata describing the valuation dataset, when supplied. */
  valuationSource: string | null;
  /** Total positive balance used as the denominator, as a decimal string. */
  totalPositiveBalance: string;
  /** Per-issuer shares, ordered by descending percentage. */
  shares: ConcentrationShare[];
}

export interface ExcludedAsset {
  asset: TrustlineAssetIdentity;
  balance: string;
  /** Reason the asset was excluded from monetary totals. */
  reason: string;
}

export interface TrustlineExposureAuditResult {
  accountId: string;
  network: string;
  issuerGroups: IssuerGroup[];
  concentration: ConcentrationSummary;
  /** Assets excluded from monetary totals due to missing valuation data. */
  excludedFromValuation: ExcludedAsset[];
  /** Assets excluded because they are liquidity pool shares. */
  liquidityPoolShares: TrustlineExposureEntry[];
  /** Assets excluded because they carry a negative reported balance. */
  negativeBalances: TrustlineExposureEntry[];
  /** Human-readable calculation assumptions. */
  assumptions: string[];
  /** Human-readable findings. */
  findings: string[];
}

const DISCLAIMER_LINES = [
  'This audit is a read-only portfolio inspection aid.',
  'It is NOT a financial risk rating, credit assessment, or investment recommendation.',
  'Concentration figures describe the distribution of reported balances only and do not',
  'indicate issuer safety, solvency, or fraud.',
];

function formatAuthorization(status: TrustlineAuthorizationStatus): string {
  switch (status) {
    case 'authorized':
      return chalk.green('authorized');
    case 'unauthorized':
      return chalk.yellow('unauthorized');
    case 'authorized-to-maintain-liabilities':
      return chalk.cyan('auth-to-maintain-liabilities');
    case 'unknown':
    default:
      return chalk.gray('unknown');
  }
}

function formatNullable(value: string | null): string {
  if (value === null || value === undefined || value === '') {
    return chalk.gray('n/a');
  }
  return value;
}

function formatBoolean(value: boolean | null): string {
  if (value === null || value === undefined) {
    return chalk.gray('n/a');
  }
  return value ? chalk.green('yes') : chalk.gray('no');
}

function formatAssetIdentity(asset: TrustlineAssetIdentity): string {
  return `${asset.code} / ${asset.issuer}`;
}

function formatConcentrationMode(mode: ConcentrationMode): string {
  if (mode === 'currency-valued') {
    return chalk.cyan('currency-valued concentration');
  }
  return chalk.yellow('raw-quantity concentration');
}

function renderIssuerGroupTable(groups: IssuerGroup[]): string {
  const lines: string[] = [];

  if (groups.length === 0) {
    lines.push(chalk.gray('No issued-asset trustlines found.'));
    return lines.join('\n');
  }

  for (const group of groups) {
    lines.push('');
    lines.push(
      chalk.bold(
        `Issuer ${group.issuer}  ` +
          chalk.gray(`(${group.trustlineCount} trustline${group.trustlineCount === 1 ? '' : 's'})`),
      ),
    );

    if (group.clawback) {
      const c = group.clawback;
      lines.push(
        chalk.gray('  Issuer config: ') +
          `clawback=${formatBoolean(c.clawbackEnabled)} ` +
          `auth-clawback=${formatBoolean(c.authClawbackEnabled)} ` +
          `auth-required=${formatBoolean(c.authRequired)} ` +
          `auth-revocable=${formatBoolean(c.authRevocable)}`,
      );
    } else {
      lines.push(chalk.gray('  Issuer config: ') + chalk.gray('unavailable'));
    }

    const rows: string[][] = group.entries.map((entry) => {
      const identity = entry.isLiquidityPoolShare
        ? `${entry.asset.code} / ${entry.asset.issuer} ${chalk.magenta('(LP share)')}`
        : formatAssetIdentity(entry.asset);

      const balance = entry.isNegative
        ? chalk.red(entry.balance)
        : entry.balance;

      return [
        identity,
        balance,
        formatNullable(entry.limit),
        formatAuthorization(entry.authorization),
        formatNullable(entry.buyingLiabilities),
        formatNullable(entry.sellingLiabilities),
      ];
    });

    lines.push(
      formatTable(
        ['Asset (code / issuer)', 'Balance', 'Limit', 'Authorization', 'Buying liab.', 'Selling liab.'],
        rows,
      ),
    );

    lines.push(
      chalk.gray('  Total positive balance: ') + group.totalPositiveBalance,
    );
  }

  return lines.join('\n');
}

function renderConcentration(summary: ConcentrationSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Issuer Concentration'));
  lines.push(
    chalk.gray('  Mode: ') +
      formatConcentrationMode(summary.mode) +
      (summary.mode === 'raw-quantity'
        ? chalk.gray('  (assets are not valued in a common currency)')
        : ''),
  );

  if (summary.mode === 'currency-valued') {
    lines.push(
      chalk.gray('  Valuation currency: ') + (summary.currency ?? chalk.gray('n/a')),
    );
    lines.push(
      chalk.gray('  Valuation source: ') + (summary.valuationSource ?? chalk.gray('n/a')),
    );
  }

  lines.push(
    chalk.gray('  Total positive balance (denominator): ') + summary.totalPositiveBalance,
  );

  if (summary.shares.length === 0) {
    lines.push(chalk.gray('  No concentration shares available.'));
    return lines.join('\n');
  }

  const rows: string[][] = summary.shares.map((share) => [
    share.issuer,
    `${share.percentage}%`,
  ]);

  lines.push('');
  lines.push(formatTable(['Issuer', 'Share of total positive balance'], rows));

  return lines.join('\n');
}

function renderExcludedAssets(excluded: ExcludedAsset[]): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Assets Excluded From Monetary Totals'));

  if (excluded.length === 0) {
    lines.push(chalk.gray('  None.'));
    return lines.join('\n');
  }

  const rows: string[][] = excluded.map((item) => [
    formatAssetIdentity(item.asset),
    item.balance,
    item.reason,
  ]);

  lines.push(formatTable(['Asset (code / issuer)', 'Balance', 'Reason'], rows));

  return lines.join('\n');
}

function renderHandlingNotes(
  negativeBalances: TrustlineExposureEntry[],
  liquidityPoolShares: TrustlineExposureEntry[],
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Handling Notes'));

  lines.push('');
  lines.push(chalk.gray('  Negative balances:'));
  if (negativeBalances.length === 0) {
    lines.push(chalk.gray('    None.'));
  } else {
    for (const entry of negativeBalances) {
      lines.push(
        `    ${formatAssetIdentity(entry.asset)}: ${chalk.red(entry.balance)} ` +
          chalk.gray('(excluded from positive-balance totals)'),
      );
    }
  }

  lines.push('');
  lines.push(chalk.gray('  Liquidity pool shares:'));
  if (liquidityPoolShares.length === 0) {
    lines.push(chalk.gray('    None.'));
  } else {
    for (const entry of liquidityPoolShares) {
      lines.push(
        `    ${formatAssetIdentity(entry.asset)}: ${entry.balance} ` +
          chalk.gray('(not treated as an issued-asset balance)'),
      );
    }
  }

  return lines.join('\n');
}

function renderAssumptions(assumptions: string[]): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Calculation Assumptions'));

  if (assumptions.length === 0) {
    lines.push(chalk.gray('  None recorded.'));
    return lines.join('\n');
  }

  for (const assumption of assumptions) {
    lines.push(`  - ${assumption}`);
  }

  return lines.join('\n');
}

function renderFindings(findings: string[]): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Findings'));

  if (findings.length === 0) {
    lines.push(chalk.gray('  None recorded.'));
    return lines.join('\n');
  }

  for (const finding of findings) {
    lines.push(`  - ${finding}`);
  }

  return lines.join('\n');
}

function renderDisclaimer(): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Disclaimer'));
  for (const line of DISCLAIMER_LINES) {
    lines.push(chalk.gray(`  ${line}`));
  }

  return lines.join('\n');
}

/**
 * Render a trustline exposure audit result as human-readable terminal output.
 *
 * Pure function: performs no I/O and does not mutate its input.
 */
export function formatTrustlineExposureReport(result: TrustlineExposureAuditResult): string {
  const sections: string[] = [];

  sections.push(chalk.bold('Trustline Exposure & Issuer Concentration Audit'));
  sections.push(
    chalk.gray('  Account: ') +
      result.accountId +
      chalk.gray('  Network: ') +
      result.network,
  );

  sections.push('');
  sections.push(chalk.bold('Issuer-Grouped Trustline Summary'));
  sections.push(renderIssuerGroupTable(result.issuerGroups));

  sections.push(renderConcentration(result.concentration));
  sections.push(renderExcludedAssets(result.excludedFromValuation));
  sections.push(renderHandlingNotes(result.negativeBalances, result.liquidityPoolShares));
  sections.push(renderAssumptions(result.assumptions));
  sections.push(renderFindings(result.findings));
  sections.push(renderDisclaimer());

  return sections.join('\n');
}