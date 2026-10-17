import { Horizon } from '@stellar/stellar-sdk';
import { ServerApi } from '@stellar/stellar-sdk/lib/horizon';

/**
 * Ledger-entry ownership / dependency audit service.
 *
 * Read-only diagnostic that inspects the ownership and lifecycle implications of
 * Stellar ledger entries associated with an account. It produces a categorized
 * inventory of observable account-associated resources and explicitly reports
 * where the available information is insufficient to establish complete
 * ownership or lifecycle behavior.
 *
 * This service NEVER modifies, deletes, or migrates ledger entries.
 */

export type AuditStatus = 'complete' | 'partial' | 'failed';

export type ResourceCategory =
  | 'trustline'
  | 'offer'
  | 'claimable_balance'
  | 'data_entry'
  | 'sponsorship'
  | 'account';

export type RelationshipType =
  | 'directly_associated'
  | 'sponsored'
  | 'sponsoring'
  | 'referenced_by_operation'
  | 'unknown';

export interface ResourceRelationship {
  type: RelationshipType;
  /** Human-readable explanation of how the relationship was determined. */
  detail: string;
  /** Sponsor account ID when the resource is sponsored. */
  sponsor?: string;
  /** Account being sponsored when this account is the sponsor. */
  sponsoredAccount?: string;
}

export interface AuditedResource {
  category: ResourceCategory;
  /** Stable identifier for the resource (asset code/issuer, offer id, balance id, data name, ...). */
  identifier: string;
  /** Ownership / association fields observed from the API. Never contains secret material. */
  ownership: Record<string, unknown>;
  relationships: ResourceRelationship[];
  /** Raw, non-secret fields relevant to lifecycle / cleanup review. */
  lifecycle: Record<string, unknown>;
}

export interface RetrievalFailure {
  /** Endpoint or logical resource that failed to be retrieved. */
  source: string;
  message: string;
  /** HTTP status when available. */
  status?: number;
}

export interface PaginationIssue {
  source: string;
  message: string;
  /** Number of records successfully retrieved before the issue. */
  retrieved: number;
}

export interface ResourceCategorySummary {
  category: ResourceCategory;
  count: number;
  /** Whether the endpoint can guarantee complete enumeration of this category. */
  completelyEnumerable: boolean;
  /** Explanation of enumeration limitations for this category. */
  limitation?: string;
}

export interface LedgerEntryOwnershipAuditResult {
  accountId: string;
  status: AuditStatus;
  /** True when the inventory may be incomplete. Never claim a complete ownership map. */
  inventoryComplete: boolean;
  /** Explicit disclaimer that this is not a complete account ownership map. */
  disclaimer: string;
  categories: ResourceCategorySummary[];
  resources: AuditedResource[];
  relationships: ResourceRelationship[];
  failures: RetrievalFailure[];
  paginationIssues: PaginationIssue[];
  limitations: string[];
  /** Categories that cannot be completely enumerated through available endpoints. */
  nonEnumerableCategories: ResourceCategory[];
  /** Resources that may require separate review before migration / cleanup / config changes. */
  reviewRequired: string[];
  generatedAt: string;
}

export interface LedgerEntryOwnershipAuditOptions {
  /** Maximum number of pages to fetch per endpoint (safety bound). */
  maxPages?: number;
  /** Page size for paginated endpoints. */
  pageSize?: number;
}

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_SIZE = 200;

const DISCLAIMER =
  'This audit is a best-effort inventory of observable account-associated ledger ' +
  'entries. It is NOT a complete account ownership map. Some ledger entries cannot ' +
  'be enumerated through standard Horizon account endpoints, and ownership ' +
  'relationships may not be fully reconstructable from available data.';

/**
 * Categories that cannot be guaranteed to be completely enumerated via the
 * standard Horizon account endpoints used by this audit.
 */
const NON_ENUMERABLE_CATEGORIES: ResourceCategory[] = [
  'sponsorship',
  'account',
];

const CATEGORY_LIMITATIONS: Partial<Record<ResourceCategory, string>> = {
  sponsorship:
    'Sponsorship relationships are only observable where the API exposes sponsor ' +
    'fields on individual resources. There is no endpoint that enumerates every ' +
    'sponsorship relationship for an account.',
  account:
    'The account record itself does not enumerate every ledger entry owned by or ' +
    'referencing the account. Only a subset of account-associated resources is ' +
    'reachable through standard endpoints.',
  claimable_balance:
    'Claimable balances are enumerated via the account claimable balances endpoint; ' +
    'balances that reference the account only as a claimant may not all be returned.',
};

export class LedgerEntryOwnershipAuditService {
  private readonly server: Horizon.Server;
  private readonly options: Required<LedgerEntryOwnershipAuditOptions>;

  constructor(server: Horizon.Server, options: LedgerEntryOwnershipAuditOptions = {}) {
    this.server = server;
    this.options = {
      maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    };
  }

  /**
   * Run the read-only ledger-entry ownership / dependency audit for an account.
   */
  async audit(accountId: string): Promise<LedgerEntryOwnershipAuditResult> {
    const resources: AuditedResource[] = [];
    const relationships: ResourceRelationship[] = [];
    const failures: RetrievalFailure[] = [];
    const paginationIssues: PaginationIssue[] = [];
    const limitations: string[] = [];
    const categoryCounts = new Map<ResourceCategory, number>();

    const bump = (category: ResourceCategory) => {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    };

    // 1. Fetch the account itself.
    let account: ServerApi.AccountRecord | undefined;
    try {
      account = await this.server.accounts().accountId(accountId).call();
    } catch (err) {
      const failure = this.toFailure(`/accounts/${accountId}`, err);
      failures.push(failure);
      return this.buildResult({
        accountId,
        status: 'failed',
        resources,
        relationships,
        failures,
        paginationIssues,
        limitations: [
          'The account record could not be retrieved; no resource inventory could be produced.',
        ],
        categoryCounts,
      });
    }

    // Record the account record as an observable resource (non-secret fields only).
    resources.push({
      category: 'account',
      identifier: accountId,
      ownership: {
        accountId: account.account_id,
        homeDomain: account.home_domain ?? null,
        thresholds: account.thresholds
          ? {
              low: account.thresholds.low_threshold,
              medium: account.thresholds.med_threshold,
              high: account.thresholds.high_threshold,
            }
          : null,
        flags: account.flags ?? null,
      },
      relationships: [
        {
          type: 'directly_associated',
          detail: 'Account record retrieved directly from Horizon.',
        },
      ],
      lifecycle: {
        sequence: account.sequence,
        numSponsoring: account.num_sponsoring ?? 0,
        numSponsored: account.num_sponsored ?? 0,
        sponsor: account.sponsor ?? null,
        lastModifiedLedger: account.last_modified_ledger ?? null,
      },
    });
    bump('account');

    // 2. Trustlines.
    await this.collectPaginated<ServerApi.AccountRecord['balances'][number]>(
      `/accounts/${accountId}/trustlines`,
      (page) => this.server.accounts().accountId(accountId).balances ? null : null,
      resources,
      relationships,
      failures,
      paginationIssues,
      bump,
      'trustline',
      async (cursor) => {
        const builder = this.server
          .accounts()
          .accountId(accountId)
          .balances
          ? null
          : null;
        // Use the dedicated trustlines endpoint via the server's generic call.
        const callBuilder = (this.server as unknown as {
          accounts: () => {
            accountId: (id: string) => {
              trustlines: () => {
                limit: (n: number) => {
                  cursor: (c: string) => {
                    call: () => Promise<ServerApi.CollectionPage<ServerApi.TrustLineRecord>>;
                  };
                  call: () => Promise<ServerApi.CollectionPage<ServerApi.TrustLineRecord>>;
                };
              };
            };
          };
        })
          .accounts()
          .accountId(accountId)
          .trustlines()
          .limit(this.options.pageSize);

        const page = cursor
          ? await callBuilder.cursor(cursor).call()
          : await callBuilder.call();
        return page as ServerApi.CollectionPage<ServerApi.TrustLineRecord>;
      },
      (record) => this.mapTrustline(record),
    );

    // 3. Offers.
    await this.collectPaginated<ServerApi.OfferRecord>(
      `/accounts/${accountId}/offers`,
      (page) => page,
      resources,
      relationships,
      failures,
      paginationIssues,
      bump,
      'offer',
      async (cursor) => {
        const builder = this.server
          .offers()
          .forAccount(accountId)
          .limit(this.options.pageSize);
        const page = cursor ? await builder.cursor(cursor).call() : await builder.call();
        return page as ServerApi.CollectionPage<ServerApi.OfferRecord>;
      },
      (record) => this.mapOffer(record),
    );

    // 4. Claimable balances.
    await this.collectPaginated<ServerApi.ClaimableBalanceRecord>(
      `/accounts/${accountId}/claimable_balances`,
      (page) => page,
      resources,
      relationships,
      failures,
      paginationIssues,
      bump,
      'claimable_balance',
      async (cursor) => {
        const builder = this.server
          .claimableBalances()
          .claimant(accountId)
          .limit(this.options.pageSize);
        const page = cursor ? await builder.cursor(cursor).call() : await builder.call();
        return page as ServerApi.CollectionPage<ServerApi.ClaimableBalanceRecord>;
      },
      (record) => this.mapClaimableBalance(record, accountId),
    );

    // 5. Data entries (from the account record's `data` map).
    this.collectDataEntries(account, resources, relationships, bump);

    // 6. Sponsorship information derived from the account record and observed resources.
    this.collectSponsorship(account, resources, relationships, bump);

    // Determine limitations for non-enumerable categories.
    for (const category of NON_ENUMERABLE_CATEGORIES) {
      const limitation = CATEGORY_LIMITATIONS[category];
      if (limitation) {
        limitations.push(limitation);
      }
    }
    for (const [category, limitation] of Object.entries(CATEGORY_LIMITATIONS)) {
      if (limitation && !NON_ENUMERABLE_CATEGORIES.includes(category as ResourceCategory)) {
        limitations.push(limitation);
      }
    }

    const hasFailures = failures.length > 0;
    const hasPaginationIssues = paginationIssues.length > 0;
    const status: AuditStatus =
      hasFailures || hasPaginationIssues ? 'partial' : 'complete';

    return this.buildResult({
      accountId,
      status,
      resources,
      relationships,
      failures,
      paginationIssues,
      limitations,
      categoryCounts,
    });
  }

  // ---------------------------------------------------------------------------
  // Collection helpers
  // ---------------------------------------------------------------------------

  private async collectPaginated<T>(
    source: string,
    _pageSelector: (page: ServerApi.CollectionPage<T>) => unknown,
    resources: AuditedResource[],
    relationships: ResourceRelationship[],
    failures: RetrievalFailure[],
    paginationIssues: PaginationIssue[],
    bump: (category: ResourceCategory) => void,
    category: ResourceCategory,
    fetchPage: (
      cursor: string | undefined,
    ) => Promise<ServerApi.CollectionPage<T>>,
    map: (record: T) => { resource: AuditedResource; relationships: ResourceRelationship[] },
  ): Promise<void> {
    let cursor: string | undefined;
    let retrieved = 0;
    let pages = 0;

    while (pages < this.options.maxPages) {
      let page: ServerApi.CollectionPage<T>;
      try {
        page = await fetchPage(cursor);
      } catch (err) {
        failures.push(this.toFailure(source, err));
        return;
      }

      const records = (page.records ?? []) as T[];
      for (const record of records) {
        const mapped = map(record);
        resources.push(mapped.resource);
        relationships.push(...mapped.relationships);
        bump(category);
        retrieved += 1;
      }

      pages += 1;

      const next = page.next ? page.next() : undefined;
      if (!next) {
        return;
      }

      // Extract the cursor from the next-page link.
      const nextCursor = this.extractCursor(next);
      if (!nextCursor) {
        paginationIssues.push({
          source,
          message:
            'A next-page link was present but no cursor could be extracted; ' +
            'pagination may be incomplete.',
          retrieved,
        });
        return;
      }

      if (nextCursor === cursor) {
        paginationIssues.push({
          source,
          message: 'Pagination cursor did not advance; stopping to avoid an infinite loop.',
          retrieved,
        });
        return;
      }

      cursor = nextCursor;
    }

    // Reached the page bound without exhausting the collection.
    paginationIssues.push({
      source,
      message:
        `Reached the maximum page bound (${this.options.maxPages}) before the ` +
        'collection was exhausted; results may be incomplete.',
      retrieved,
    });
  }

  private extractCursor(nextUrl: string): string | undefined {
    try {
      const url = new URL(nextUrl);
      return url.searchParams.get('cursor') ?? undefined;
    } catch {
      const match = /[?&]cursor=([^&]+)/.exec(nextUrl);
      return match ? decodeURIComponent(match[1]) : undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private mapTrustline(record: ServerApi.TrustLineRecord): {
    resource: AuditedResource;
    relationships: ResourceRelationship[];
  } {
    const relationships: ResourceRelationship[] = [
      {
        type: 'directly_associated',
        detail: 'Trustline is held by the audited account.',
      },
    ];

    const sponsor = (record as unknown as { sponsor?: string }).sponsor;
    if (sponsor) {
      relationships.push({
        type: 'sponsored',
        detail: 'Trustline reserve is sponsored by another account.',
        sponsor,
      });
    }

    return {
      resource: {
        category: 'trustline',
        identifier: `${record.asset_code ?? record.asset_type}:${record.asset_issuer ?? ''}`,
        ownership: {
          account: record.account ?? null,
          assetType: record.asset_type,
          assetCode: record.asset_code ?? null,
          assetIssuer: record.asset_issuer ?? null,
          sponsor: sponsor ?? null,
        },
        relationships,
        lifecycle: {
          balance: record.balance,
          limit: record.limit,
          authorized: (record as unknown as { authorized?: boolean }).authorized ?? null,
          authorizedToMaintainLiabilities:
            (record as unknown as { authorized_to_maintain_liabilities?: boolean })
              .authorized_to_maintain_liabilities ?? null,
          lastModifiedLedger:
            (record as unknown as { last_modified_ledger?: number }).last_modified_ledger ??
            null,
        },
      },
      relationships,
    };
  }

  private mapOffer(record: ServerApi.OfferRecord): {
    resource: AuditedResource;
    relationships: ResourceRelationship[];
  } {
    const relationships: ResourceRelationship[] = [
      {
        type: 'directly_associated',
        detail: 'Offer is owned by the audited account.',
      },
    ];

    const sponsor = (record as unknown as { sponsor?: string }).sponsor;
    if (sponsor) {
      relationships.push({
        type: 'sponsored',
        detail: 'Offer reserve is sponsored by another account.',
        sponsor,
      });
    }

    return {
      resource: {
        category: 'offer',
        identifier: String(record.id),
        ownership: {
          seller: record.seller ?? null,
          sponsor: sponsor ?? null,
        },
        relationships,
        lifecycle: {
          selling: record.selling ?? null,
          buying: record.buying ?? null,
          amount: record.amount ?? null,
          price: record.price ?? null,
          priceR: record.price_r ?? null,
          lastModifiedLedger:
            (record as unknown as { last_modified_ledger?: number }).last_modified_ledger ??
            null,
        },
      },
      relationships,
    };
  }

  private mapClaimableBalance(
    record: ServerApi.ClaimableBalanceRecord,
    accountId: string,
  ): { resource: AuditedResource; relationships: ResourceRelationship[] } {
    const relationships: ResourceRelationship[] = [];
    const claimants = (record.claimants ?? []) as Array<{
      destination: string;
      predicate?: unknown;
    }>;

    const isClaimant = claimants.some((c) => c.destination === accountId);
    if (isClaimant) {
      relationships.push({
        type: 'referenced_by_operation',
        detail: 'Audited account is a claimant of this claimable balance.',
      });
    }

    const sponsor = (record as unknown as { sponsor?: string }).sponsor;
    if (sponsor) {
      relationships.push({
        type: 'sponsored',
        detail: 'Claimable balance reserve is sponsored by another account.',
        sponsor,
      });
    }

    if (relationships.length === 0) {
      relationships.push({
        type: 'unknown',
        detail:
          'Claimable balance was returned by the claimant query but no direct ' +
          'relationship could be established from available fields.',
      });
    }

    return {
      resource: {
        category: 'claimable_balance',
        identifier: record.id,
        ownership: {
          sponsor: sponsor ?? null,
          claimants: claimants.map((c) => ({
            destination: c.destination,
            predicate: c.predicate ?? null,
          })),
        },
        relationships,
        lifecycle: {
          asset: record.asset ?? null,
          amount: record.amount ?? null,
          lastModifiedLedger:
            (record as unknown as { last_modified_ledger?: number }).last_modified_ledger ??
            null,
        },
      },
      relationships,
    };
  }

  private collectDataEntries(
    account: ServerApi.AccountRecord,
    resources: AuditedResource[],
    relationships: ResourceRelationship[],
    bump: (category: ResourceCategory) => void,
  ): void {
    const data = (account as unknown as { data?: Record<string, string> }).data;
    if (!data || typeof data !== 'object') {
      return;
    }

    for (const [name, value] of Object.entries(data)) {
      const rel: ResourceRelationship = {
        type: 'directly_associated',
        detail: 'Data entry is stored on the audited account.',
      };
      relationships.push(rel);
      resources.push({
        category: 'data_entry',
        identifier: name,
        ownership: {
          account: account.account_id,
          name,
        },
        relationships: [rel],
        lifecycle: {
          // Value is base64-encoded data; report presence and length only to
          // avoid exposing potentially sensitive payloads.
          valuePresent: typeof value === 'string' && value.length > 0,
          valueLength: typeof value === 'string' ? value.length : 0,
        },
      });
      bump('data_entry');
    }
  }

  private collectSponsorship(
    account: ServerApi.AccountRecord,
    resources: AuditedResource[],
    relationships: ResourceRelationship[],
    bump: (category: ResourceCategory) => void,
  ): void {
    const numSponsoring = account.num_sponsoring ?? 0;
    const numSponsored = account.num_sponsored ?? 0;
    const sponsor = (account as unknown as { sponsor?: string }).sponsor;

    if (numSponsoring === 0 && numSponsored === 0 && !sponsor) {
      return;
    }

    const rels: ResourceRelationship[] = [];
    if (numSponsoring > 0) {
      rels.push({
        type: 'sponsoring',
        detail:
          `Account is sponsoring reserves for ${numSponsoring} ledger entr` +
          `${numSponsoring === 1 ? 'y' : 'ies'}. Individual sponsored entries ` +
          'may not all be enumerable through available endpoints.',
      });
    }
    if (numSponsored > 0) {
      rels.push({
        type: 'sponsored',
        detail:
          `Account has ${numSponsored} ledger entr` +
          `${numSponsored === 1 ? 'y' : 'ies'} whose reserves are sponsored by ` +
          'another account.',
        sponsor: sponsor ?? undefined,
      });
    }
    if (sponsor) {
      rels.push({
        type: 'sponsored',
        detail: 'Account record itself is sponsored.',
        sponsor,
      });
    }

    relationships.push(...rels);
    resources.push({
      category: 'sponsorship',
      identifier: account.account_id,
      ownership: {
        account: account.account_id,
        sponsor: sponsor ?? null,
      },
      relationships: rels,
      lifecycle: {
        numSponsoring,
        numSponsored,
      },
    });
    bump('sponsorship');
  }

  // ---------------------------------------------------------------------------
  // Result assembly
  // ---------------------------------------------------------------------------

  private buildResult(input: {
    accountId: string;
    status: AuditStatus;
    resources: AuditedResource[];
    relationships: ResourceRelationship[];
    failures: RetrievalFailure[];
    paginationIssues: PaginationIssue[];
    limitations: string[];
    categoryCounts: Map<ResourceCategory, number>;
  }): LedgerEntryOwnershipAuditResult {
    const categories: ResourceCategorySummary[] = [];
    const seen = new Set<ResourceCategory>();

    const allCategories: ResourceCategory[] = [
      'account',
      'trustline',
      'offer',
      'claimable_balance',
      'data_entry',
      'sponsorship',
    ];

    for (const category of allCategories) {
      const count = input.categoryCounts.get(category) ?? 0;
      const completelyEnumerable = !NON_ENUMERABLE_CATEGORIES.includes(category);
      categories.push({
        category,
        count,
        completelyEnumerable,
        limitation: CATEGORY_LIMITATIONS[category],
      });
      seen.add(category);
    }

    const nonEnumerableCategories = categories
      .filter((c) => !c.completelyEnumerable)
      .map((c) => c.category);

    const inventoryComplete =
      input.status === 'complete' &&
      input.failures.length === 0 &&
      input.paginationIssues.length === 0 &&
      nonEnumerableCategories.length === 0;

    const reviewRequired = this.buildReviewList(input.resources);

    return {
      accountId: input.accountId,
      status: input.status,
      inventoryComplete,
      disclaimer: DISCLAIMER,
      categories,
      resources: input.resources,
      relationships: input.relationships,
      failures: input.failures,
      paginationIssues: input.paginationIssues,
      limitations: input.limitations,
      nonEnumerableCategories,
      reviewRequired,
      generatedAt: new Date().toISOString(),
    };
  }

  private buildReviewList(resources: AuditedResource[]): string[] {
    const review: string[] = [];
    for (const resource of resources) {
      const sponsored = resource.relationships.some((r) => r.type === 'sponsored');
      const sponsoring = resource.relationships.some((r) => r.type === 'sponsoring');
      const unknown = resource.relationships.some((r) => r.type === 'unknown');

      if (sponsored) {
        review.push(
          `${resource.category}:${resource.identifier} is sponsored; removing it may ` +
            'affect the sponsor and reserve accounting.',
        );
      }
      if (sponsoring) {
        review.push(
          `${resource.category}:${resource.identifier} involves sponsorship this ` +
            'account provides; review before migration or cleanup.',
        );
      }
      if (unknown) {
        review.push(
          `${resource.category}:${resource.identifier} has an unclear ownership ` +
            'relationship; requires separate review.',
        );
      }
    }
    return review;
  }

  private toFailure(source: string, err: unknown): RetrievalFailure {
    const anyErr = err as {
      message?: string;
      response?: { status?: number };
      status?: number;
    };
    return {
      source,
      message: anyErr?.message ?? String(err),
      status: anyErr?.response?.status ?? anyErr?.status,
    };
  }
}

export default LedgerEntryOwnershipAuditService;