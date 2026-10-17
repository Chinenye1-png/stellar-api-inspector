import chalk from 'chalk';
import { StrKey } from '@stellar/stellar-sdk';
import { formatTable, formatXlm } from '../utils/formatters';
import {
  SponsorshipLifecycleAuditService,
  SponsorshipLifecycleAuditResult,
  SponsorshipRelationship,
  SponsorshipEvent,
  SponsorshipLimitation,
  SponsorshipAuditStatus,
} from '../services/sponsorship-lifecycle-audit-service';

/**
 * Options accepted by the sponsorship lifecycle audit inspector.
 */
export interface SponsorshipLifecycleAuditOptions {
  /**
   * Optional Horizon server URL override. When omitted the service uses its
   * configured default client.
   */
  horizonUrl?: string;
  /**
   * Maximum number of pages to retrieve when paginating sponsorship-related
   * operations. When the limit is reached the audit flags incomplete
   * pagination rather than silently truncating.
   */
  maxOperationPages?: number;
  /**
   * Optional network parameters used to compute reserve estimates. When
   * omitted, reserve figures are reported as unavailable.
   */
  networkParams?: {
    baseReserve?: number;
    baseFee?: number;
  };
}

/**
 * Typed result returned by the inspector. Mirrors the service result but is
 * exposed here so callers do not need to depend on the service module
 * directly.
 */
export interface SponsorshipLifecycleAuditReport {
  accountId: string;
  status: SponsorshipAuditStatus;
  summary: {
    numSponsoring: number | null;
    numSponsored: number | null;
    sponsoringCount: number;
    sponsoredCount: number;
    unresolvedCount: number;
    sponsorshipStarts: number;
    sponsorshipEnds: number;
  };
  relationships: SponsorshipRelationship[];
  events: SponsorshipEvent[];
  limitations: SponsorshipLimitation[];
  reserveEstimate: {
    available: boolean;
    estimatedSponsoringReserveXlm: number | null;
    estimatedSponsoredReserveXlm: number | null;
    assumptions: string[];
  };
  notes: string[];
}

/**
 * Read-only inspector that audits the sponsorship lifecycle and reserve
 * responsibility for a Stellar account.
 *
 * This inspector never creates, ends, or modifies sponsorship arrangements.
 * It only retrieves and reports on data available from Horizon.
 */
export class SponsorshipLifecycleAuditInspector {
  private readonly service: SponsorshipLifecycleAuditService;

  constructor(service?: SponsorshipLifecycleAuditService) {
    this.service =
      service ?? new SponsorshipLifecycleAuditService();
  }

  /**
   * Validate the supplied account ID. Returns the normalized account ID on
   * success, or throws a descriptive error when the input is not a valid
   * Stellar account ID.
   */
  public validateAccountId(accountId: string): string {
    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      throw new Error('A Stellar account ID is required.');
    }
    const trimmed = accountId.trim();
    if (!StrKey.isValidEd25519PublicKey(trimmed)) {
      throw new Error(
        `Invalid Stellar account ID: "${accountId}". Expected a valid ed25519 public key (G...).`,
      );
    }
    return trimmed;
  }

  /**
   * Run the sponsorship lifecycle audit for the given account.
   *
   * @param accountId Stellar account ID to inspect.
   * @param options Optional audit options.
   * @returns A typed audit report.
   */
  public async audit(
    accountId: string,
    options: SponsorshipLifecycleAuditOptions = {},
  ): Promise<SponsorshipLifecycleAuditReport> {
    const normalizedAccountId = this.validateAccountId(accountId);

    const serviceResult: SponsorshipLifecycleAuditResult =
      await this.service.audit(normalizedAccountId, {
        horizonUrl: options.horizonUrl,
        maxOperationPages: options.maxOperationPages,
        networkParams: options.networkParams,
      });

    return this.toReport(normalizedAccountId, serviceResult);
  }

  /**
   * Convert the raw service result into the inspector's typed report shape.
   * This normalizes optional fields so callers never encounter undefined
   * collections.
   */
  private toReport(
    accountId: string,
    result: SponsorshipLifecycleAuditResult,
  ): SponsorshipLifecycleAuditReport {
    const relationships = result.relationships ?? [];
    const events = result.events ?? [];
    const limitations = result.limitations ?? [];
    const notes = result.notes ?? [];

    const sponsoringCount = relationships.filter(
      (r) => r.direction === 'sponsoring',
    ).length;
    const sponsoredCount = relationships.filter(
      (r) => r.direction === 'sponsored',
    ).length;
    const unresolvedCount = relationships.filter(
      (r) => r.direction === 'unresolved',
    ).length;

    const sponsorshipStarts = events.filter(
      (e) => e.type === 'start',
    ).length;
    const sponsorshipEnds = events.filter((e) => e.type === 'end').length;

    const reserveEstimate = result.reserveEstimate ?? {
      available: false,
      estimatedSponsoringReserveXlm: null,
      estimatedSponsoredReserveXlm: null,
      assumptions: [
        'Reserve estimate unavailable: network parameters were not provided.',
      ],
    };

    return {
      accountId,
      status: result.status ?? 'inconclusive',
      summary: {
        numSponsoring: result.numSponsoring ?? null,
        numSponsored: result.numSponsored ?? null,
        sponsoringCount,
        sponsoredCount,
        unresolvedCount,
        sponsorshipStarts,
        sponsorshipEnds,
      },
      relationships,
      events,
      limitations,
      reserveEstimate,
      notes,
    };
  }

  /**
   * Render a human-readable report for the audit result.
   *
   * The report clearly distinguishes entries the account sponsors from
   * entries sponsored on its behalf, and labels reserve figures as
   * estimates.
   */
  public formatReport(report: SponsorshipLifecycleAuditReport): string {
    const lines: string[] = [];

    lines.push(chalk.bold('Sponsorship Lifecycle Audit'));
    lines.push(chalk.gray('─'.repeat(48)));
    lines.push(`${chalk.bold('Account:')} ${report.accountId}`);
    lines.push(
      `${chalk.bold('Status:')} ${this.formatStatus(report.status)}`,
    );
    lines.push('');

    lines.push(chalk.bold('Sponsorship Counters'));
    lines.push(
      formatTable(
        ['Counter', 'Value', 'Meaning'],
        [
          [
            'num_sponsoring',
            this.formatCounter(report.summary.numSponsoring),
            'Ledger entries this account sponsors for others',
          ],
          [
            'num_sponsored',
            this.formatCounter(report.summary.numSponsored),
            'Ledger entries sponsored by another account for this account',
          ],
        ],
      ),
    );
    lines.push('');

    lines.push(chalk.bold('Observed Relationships'));
    if (report.relationships.length === 0) {
      lines.push(
        chalk.gray(
          'No sponsorship relationships could be established from retrieved data.',
        ),
      );
    } else {
      const rows = report.relationships.map((rel) => [
        this.formatDirection(rel.direction),
        rel.sponsoringAccount ?? chalk.gray('unknown'),
        rel.sponsoredAccount ?? chalk.gray('unknown'),
        rel.entryType ?? chalk.gray('unsupported'),
        rel.entryId ?? chalk.gray('n/a'),
      ]);
      lines.push(
        formatTable(
          ['Direction', 'Sponsoring Account', 'Sponsored Account', 'Entry Type', 'Entry ID'],
          rows,
        ),
      );
    }
    lines.push('');

    lines.push(chalk.bold('Sponsorship Events'));
    if (report.events.length === 0) {
      lines.push(
        chalk.gray(
          'No sponsorship start or end events were found in the retrieved operation history.',
        ),
      );
    } else {
      const rows = report.events.map((evt) => [
        evt.type === 'start' ? chalk.green('start') : chalk.yellow('end'),
        evt.entryType ?? chalk.gray('unsupported'),
        evt.entryId ?? chalk.gray('n/a'),
        evt.counterparty ?? chalk.gray('unknown'),
        evt.ledger != null ? String(evt.ledger) : chalk.gray('n/a'),
        evt.createdAt ?? chalk.gray('n/a'),
      ]);
      lines.push(
        formatTable(
          ['Event', 'Entry Type', 'Entry ID', 'Counterparty', 'Ledger', 'Time'],
          rows,
        ),
      );
    }
    lines.push('');

    lines.push(chalk.bold('Reserve Responsibility (Estimates)'));
    if (report.reserveEstimate.available) {
      lines.push(
        formatTable(
          ['Responsibility', 'Estimated Reserve (XLM)'],
          [
            [
              'Sponsoring (this account pays)',
              this.formatReserve(
                report.reserveEstimate.estimatedSponsoringReserveXlm,
              ),
            ],
            [
              'Sponsored (another account pays)',
              this.formatReserve(
                report.reserveEstimate.estimatedSponsoredReserveXlm,
              ),
            ],
          ],
        ),
      );
      lines.push(
        chalk.yellow(
          'These reserve figures are estimates based on the assumptions below and are not authoritative ledger calculations.',
        ),
      );
      for (const assumption of report.reserveEstimate.assumptions) {
        lines.push(chalk.gray(`  • ${assumption}`));
      }
    } else {
      lines.push(
        chalk.gray(
          'Reserve estimates unavailable. Exact reserve requirements could not be established from retrieved data and current network parameters.',
        ),
      );
      for (const assumption of report.reserveEstimate.assumptions) {
        lines.push(chalk.gray(`  • ${assumption}`));
      }
    }
    lines.push('');

    lines.push(chalk.bold('Limitations'));
    if (report.limitations.length === 0) {
      lines.push(chalk.gray('No limitations detected.'));
    } else {
      for (const limitation of report.limitations) {
        lines.push(
          `${chalk.yellow('!')} ${limitation.message}${
            limitation.detail ? chalk.gray(` (${limitation.detail})`) : ''
          }`,
        );
      }
    }

    if (report.notes.length > 0) {
      lines.push('');
      lines.push(chalk.bold('Notes'));
      for (const note of report.notes) {
        lines.push(chalk.gray(`  • ${note}`));
      }
    }

    lines.push('');
    lines.push(
      chalk.gray(
        'This audit is read-only and performs no sponsorship changes or state-changing operations.',
      ),
    );

    return lines.join('\n');
  }

  private formatStatus(status: SponsorshipAuditStatus): string {
    switch (status) {
      case 'complete':
        return chalk.green('complete');
      case 'partial':
        return chalk.yellow('partial');
      case 'inconclusive':
      default:
        return chalk.red('inconclusive');
    }
  }

  private formatCounter(value: number | null): string {
    if (value === null || value === undefined) {
      return chalk.gray('unavailable');
    }
    return String(value);
  }

  private formatDirection(direction: SponsorshipRelationship['direction']): string {
    switch (direction) {
      case 'sponsoring':
        return chalk.cyan('sponsoring');
      case 'sponsored':
        return chalk.magenta('sponsored');
      case 'unresolved':
      default:
        return chalk.gray('unresolved');
    }
  }

  private formatReserve(value: number | null): string {
    if (value === null || value === undefined) {
      return chalk.gray('unavailable');
    }
    return `${formatXlm(value)} (est.)`;
  }
}

export default SponsorshipLifecycleAuditInspector;