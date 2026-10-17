/**
 * Soroban contract event retention and pagination audit service.
 *
 * This service inspects a saved collection of Soroban RPC `getEvents` response
 * pages (or a retrieval manifest describing them) and reports on retrieval
 * completeness and pagination integrity.
 *
 * It deliberately does NOT re-query the network, submit transactions, or modify
 * contract state. It also avoids inferring that empty ledger intervals contain
 * no matching events: an empty interval only means no events were *returned*
 * for that interval within the recorded query coverage.
 */

export type SorobanEventRetrievalStatus =
  | 'exhausted'
  | 'page-limit'
  | 'rpc-error'
  | 'expired-cursor'
  | 'incomplete'
  | 'unknown';

export interface SorobanEventQueryContext {
  /** Ledger sequence at which the query started (inclusive), if known. */
  startLedger?: number;
  /** Ledger sequence at which the query ended (inclusive), if known. */
  endLedger?: number;
  /** Opaque cursor supplied to the query, if any. */
  cursor?: string;
  /** Maximum number of events requested per page, if known. */
  limit?: number;
  /** Contract IDs included in the filter, if any. */
  contractIds?: string[];
  /** Topic filters included in the query, if any. */
  topics?: unknown[];
  /** Any additional, implementation-specific query parameters. */
  [key: string]: unknown;
}

export interface SorobanEventRecord {
  /** Stable identifier for the event, if provided by the RPC. */
  id?: string;
  /** Ledger sequence in which the event was emitted, if provided. */
  ledger?: number;
  /** Contract ID that emitted the event, if provided. */
  contractId?: string;
  /** Event type (e.g. "contract", "system", "diagnostic"), if provided. */
  type?: string;
  /** Topic values, if provided. */
  topic?: unknown[];
  /** Event value payload, if provided. */
  value?: unknown;
  /** Any additional fields present on the event. */
  [key: string]: unknown;
}

export interface SorobanEventResponsePage {
  /** Query parameters that produced this page, if recorded. */
  query?: SorobanEventQueryContext;
  /** Cursor to use for the next page, if the RPC returned one. */
  cursor?: string;
  /** Whether the RPC indicated that more results are available. */
  hasMore?: boolean;
  /** Events returned in this page. */
  events?: SorobanEventRecord[];
  /** Latest ledger known to the RPC at the time of the response, if provided. */
  latestLedger?: number;
  /** Ledger at which the query's coverage begins, if provided. */
  oldestLedger?: number;
  /** Error information if the page represents a failed retrieval. */
  error?: {
    code?: string | number;
    message?: string;
    /** Some RPCs indicate cursor expiry explicitly. */
    expiredCursor?: boolean;
    [key: string]: unknown;
  };
  /** Explicit retrieval status, if recorded. */
  status?: string;
  /** Any additional fields present on the page. */
  [key: string]: unknown;
}

export interface SorobanEventRetrievalManifest {
  /** Query context shared by the collected pages, if recorded. */
  query?: SorobanEventQueryContext;
  /** Ordered collection of saved response pages. */
  pages: SorobanEventResponsePage[];
  /** Explicit retrieval status for the whole session, if recorded. */
  status?: string;
  /** Maximum number of pages the retrieval was allowed to fetch, if known. */
  pageLimit?: number;
  /** Any additional manifest metadata. */
  [key: string]: unknown;
}

export interface SorobanEventRetentionAuditInput {
  /** A retrieval manifest, or a bare collection of response pages. */
  manifest?: SorobanEventRetrievalManifest;
  pages?: SorobanEventResponsePage[];
  /** Query context to use when pages do not carry their own. */
  query?: SorobanEventQueryContext;
  /** Maximum number of pages the retrieval was allowed to fetch, if known. */
  pageLimit?: number;
}

export interface SorobanEventQueryInconsistency {
  /** Index of the page that disagreed with the baseline query. */
  pageIndex: number;
  /** Field name that disagreed. */
  field: string;
  /** Value established as the baseline (from the first page or manifest). */
  expected: unknown;
  /** Value observed on the offending page. */
  actual: unknown;
}

export interface SorobanEventDuplicateFinding {
  /** The stable identifier shared by the duplicate records. */
  identifier: string;
  /** Page indices on which the duplicate records were found. */
  pageIndices: number[];
  /** The original event records, preserved unmodified. */
  events: SorobanEventRecord[];
}

export interface SorobanEventRepeatedCursorFinding {
  /** The cursor value that was observed more than once. */
  cursor: string;
  /** Page indices that produced or carried the repeated cursor. */
  pageIndices: number[];
  /** Whether the repetition is consistent with a pagination loop. */
  potentialLoop: boolean;
}

export interface SorobanEventPageStatus {
  pageIndex: number;
  /** Number of events returned on this page. */
  eventCount: number;
  /** Cursor carried by this page, if any. */
  cursor?: string;
  /** Whether the page indicated more results were available. */
  hasMore?: boolean;
  /** Ledger bounds observed on this page, if any. */
  oldestLedger?: number;
  latestLedger?: number;
  /** Whether the page carried an error. */
  hasError: boolean;
  /** Whether the page is missing metadata that would be expected. */
  missingMetadata: string[];
}

export interface SorobanEventLedgerRange {
  /** Lowest ledger observed across collected events and page bounds. */
  min?: number;
  /** Highest ledger observed across collected events and page bounds. */
  max?: number;
  /** Ledger bounds recorded in the query context, if any. */
  queryStartLedger?: number;
  queryEndLedger?: number;
}

export interface SorobanEventRetentionAuditResult {
  /** Query context established for the audit, if any. */
  query?: SorobanEventQueryContext;
  /** Per-page status summary. */
  pages: SorobanEventPageStatus[];
  /** Total number of events collected across all pages. */
  eventCount: number;
  /** Observed ledger range across events and page bounds. */
  ledgerRange: SorobanEventLedgerRange;
  /** Query parameter inconsistencies across pages. */
  queryInconsistencies: SorobanEventQueryInconsistency[];
  /** Repeated cursor findings, including potential pagination loops. */
  repeatedCursors: SorobanEventRepeatedCursorFinding[];
  /** Duplicate event findings keyed by stable identifier. */
  duplicates: SorobanEventDuplicateFinding[];
  /** Gaps in the recorded retrieval sequence, where they can be established. */
  sequenceGaps: string[];
  /** Missing page metadata observations. */
  missingMetadata: string[];
  /** Classified termination reason. */
  termination: SorobanEventRetrievalStatus;
  /** Human-readable explanation of the termination classification. */
  terminationReason: string;
  /** Whether the retrieval can be considered exhaustively complete. */
  exhaustive: boolean;
  /** Limitations that qualify the audit's conclusions. */
  limitations: string[];
  /** The original pages, preserved unmodified. */
  originalPages: SorobanEventResponsePage[];
}

const QUERY_COMPARABLE_FIELDS: (keyof SorobanEventQueryContext)[] = [
  'startLedger',
  'endLedger',
  'cursor',
  'limit',
  'contractIds',
  'topics',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return stableStringify(a) === stableStringify(b);
}

function normalizeStatus(status: string | undefined): SorobanEventRetrievalStatus | undefined {
  if (!status) {
    return undefined;
  }
  const normalized = status.toLowerCase().replace(/[\s_]+/g, '-');
  switch (normalized) {
    case 'exhausted':
    case 'complete':
    case 'completed':
    case 'done':
      return 'exhausted';
    case 'page-limit':
    case 'pagelimit':
    case 'limit-reached':
    case 'truncated':
      return 'page-limit';
    case 'rpc-error':
    case 'error':
    case 'failed':
      return 'rpc-error';
    case 'expired-cursor':
    case 'cursor-expired':
    case 'expired':
      return 'expired-cursor';
    case 'incomplete':
    case 'partial':
      return 'incomplete';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

function pageHasError(page: SorobanEventResponsePage): boolean {
  return isPlainObject(page.error);
}

function pageIndicatesExpiredCursor(page: SorobanEventResponsePage): boolean {
  if (!isPlainObject(page.error)) {
    return false;
  }
  if (page.error.expiredCursor === true) {
    return true;
  }
  const code = page.error.code;
  const message = page.error.message;
  const haystack = `${typeof code === 'string' || typeof code === 'number' ? code : ''} ${
    typeof message === 'string' ? message : ''
  }`.toLowerCase();
  return haystack.includes('expired') && haystack.includes('cursor');
}

function collectEventIdentifier(event: SorobanEventRecord): string | undefined {
  if (typeof event.id === 'string' && event.id.length > 0) {
    return event.id;
  }
  if (typeof event.id === 'number') {
    return String(event.id);
  }
  return undefined;
}

function collectLedgerBounds(
  pages: SorobanEventResponsePage[],
  query: SorobanEventQueryContext | undefined,
): SorobanEventLedgerRange {
  let min: number | undefined;
  let max: number | undefined;

  const consider = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (min === undefined || value < min) {
        min = value;
      }
      if (max === undefined || value > max) {
        max = value;
      }
    }
  };

  for (const page of pages) {
    consider(page.oldestLedger);
    consider(page.latestLedger);
    if (Array.isArray(page.events)) {
      for (const event of page.events) {
        if (isPlainObject(event)) {
          consider(event.ledger);
        }
      }
    }
  }

  const range: SorobanEventLedgerRange = { min, max };
  if (query) {
    if (typeof query.startLedger === 'number') {
      range.queryStartLedger = query.startLedger;
    }
    if (typeof query.endLedger === 'number') {
      range.queryEndLedger = query.endLedger;
    }
  }
  return range;
}

function resolvePages(input: SorobanEventRetentionAuditInput): SorobanEventResponsePage[] {
  if (input.manifest && Array.isArray(input.manifest.pages)) {
    return input.manifest.pages;
  }
  if (Array.isArray(input.pages)) {
    return input.pages;
  }
  return [];
}

function resolveQuery(
  input: SorobanEventRetentionAuditInput,
  pages: SorobanEventResponsePage[],
): SorobanEventQueryContext | undefined {
  if (input.manifest && isPlainObject(input.manifest.query)) {
    return input.manifest.query;
  }
  if (isPlainObject(input.query)) {
    return input.query;
  }
  for (const page of pages) {
    if (isPlainObject(page.query)) {
      return page.query;
    }
  }
  return undefined;
}

function resolvePageLimit(
  input: SorobanEventRetentionAuditInput,
): number | undefined {
  if (input.manifest && typeof input.manifest.pageLimit === 'number') {
    return input.manifest.pageLimit;
  }
  if (typeof input.pageLimit === 'number') {
    return input.pageLimit;
  }
  return undefined;
}

function compareQueryContexts(
  baseline: SorobanEventQueryContext | undefined,
  pages: SorobanEventResponsePage[],
): SorobanEventQueryInconsistency[] {
  const inconsistencies: SorobanEventQueryInconsistency[] = [];
  if (!baseline) {
    return inconsistencies;
  }

  pages.forEach((page, pageIndex) => {
    if (!isPlainObject(page.query)) {
      return;
    }
    const pageQuery = page.query;
    for (const field of QUERY_COMPARABLE_FIELDS) {
      const expected = baseline[field];
      const actual = pageQuery[field];
      if (expected === undefined || actual === undefined) {
        continue;
      }
      if (!valuesEqual(expected, actual)) {
        inconsistencies.push({
          pageIndex,
          field: String(field),
          expected,
          actual,
        });
      }
    }
  });

  return inconsistencies;
}

function detectRepeatedCursors(
  pages: SorobanEventResponsePage[],
): SorobanEventRepeatedCursorFinding[] {
  const byCursor = new Map<string, number[]>();

  pages.forEach((page, pageIndex) => {
    const cursor = page.cursor;
    if (typeof cursor === 'string' && cursor.length > 0) {
      const existing = byCursor.get(cursor);
      if (existing) {
        existing.push(pageIndex);
      } else {
        byCursor.set(cursor, [pageIndex]);
      }
    }
  });

  const findings: SorobanEventRepeatedCursorFinding[] = [];
  for (const [cursor, pageIndices] of byCursor.entries()) {
    if (pageIndices.length > 1) {
      findings.push({
        cursor,
        pageIndices: [...pageIndices],
        potentialLoop: true,
      });
    }
  }
  return findings;
}

function detectDuplicates(
  pages: SorobanEventResponsePage[],
): SorobanEventDuplicateFinding[] {
  const byIdentifier = new Map<
    string,
    { pageIndices: number[]; events: SorobanEventRecord[] }
  >();

  pages.forEach((page, pageIndex) => {
    if (!Array.isArray(page.events)) {
      return;
    }
    for (const event of page.events) {
      if (!isPlainObject(event)) {
        continue;
      }
      const identifier = collectEventIdentifier(event as SorobanEventRecord);
      if (!identifier) {
        continue;
      }
      const existing = byIdentifier.get(identifier);
      if (existing) {
        existing.pageIndices.push(pageIndex);
        existing.events.push(event as SorobanEventRecord);
      } else {
        byIdentifier.set(identifier, {
          pageIndices: [pageIndex],
          events: [event as SorobanEventRecord],
        });
      }
    }
  });

  const findings: SorobanEventDuplicateFinding[] = [];
  for (const [identifier, entry] of byIdentifier.entries()) {
    if (entry.events.length > 1) {
      findings.push({
        identifier,
        pageIndices: [...entry.pageIndices],
        events: entry.events,
      });
    }
  }
  return findings;
}

function buildPageStatuses(
  pages: SorobanEventResponsePage[],
): { statuses: SorobanEventPageStatus[]; missingMetadata: string[] } {
  const statuses: SorobanEventPageStatus[] = [];
  const missingMetadata: string[] = [];

  pages.forEach((page, pageIndex) => {
    const events = Array.isArray(page.events) ? page.events : [];
    const missing: string[] = [];

    if (typeof page.cursor !== 'string' || page.cursor.length === 0) {
      missing.push('cursor');
    }
    if (typeof page.hasMore !== 'boolean') {
      missing.push('hasMore');
    }
    if (typeof page.latestLedger !== 'number') {
      missing.push('latestLedger');
    }
    if (!isPlainObject(page.query)) {
      missing.push('query');
    }

    if (missing.length > 0) {
      missingMetadata.push(`page ${pageIndex}: missing ${missing.join(', ')}`);
    }

    statuses.push({
      pageIndex,
      eventCount: events.length,
      cursor: typeof page.cursor === 'string' ? page.cursor : undefined,
      hasMore: typeof page.hasMore === 'boolean' ? page.hasMore : undefined,
      oldestLedger:
        typeof page.oldestLedger === 'number' ? page.oldestLedger : undefined,
      latestLedger:
        typeof page.latestLedger === 'number' ? page.latestLedger : undefined,
      hasError: pageHasError(page),
      missingMetadata: missing,
    });
  });

  return { statuses, missingMetadata };
}

function detectSequenceGaps(
  pages: SorobanEventResponsePage[],
  pageLimit: number | undefined,
): string[] {
  const gaps: string[] = [];

  if (pages.length === 0) {
    return gaps;
  }

  // A page that indicates more results but is the last collected page suggests
  // the retrieval stopped before exhausting the sequence.
  const lastIndex = pages.length - 1;
  const lastPage = pages[lastIndex];
  if (lastPage && lastPage.hasMore === true) {
    gaps.push(
      `page ${lastIndex} indicated more results (hasMore=true) but no further page was collected`,
    );
  }

  // If a page limit was recorded and the number of collected pages reached it,
  // the sequence may have been truncated.
  if (typeof pageLimit === 'number' && pages.length >= pageLimit) {
    gaps.push(
      `collected page count (${pages.length}) reached the recorded page limit (${pageLimit})`,
    );
  }

  // Pages that carry an error terminate the sequence prematurely.
  pages.forEach((page, pageIndex) => {
    if (pageHasError(page)) {
      gaps.push(`page ${pageIndex} recorded an error and may have truncated the sequence`);
    }
  });

  return gaps;
}

function classifyTermination(
  pages: SorobanEventResponsePage[],
  manifestStatus: SorobanEventRetrievalStatus | undefined,
  pageLimit: number | undefined,
): { termination: SorobanEventRetrievalStatus; reason: string; exhaustive: boolean } {
  if (pages.length === 0) {
    return {
      termination: 'incomplete',
      reason: 'No event response pages were provided for audit.',
      exhaustive: false,
    };
  }

  const errorPageIndex = pages.findIndex((page) => pageHasError(page));
  if (errorPageIndex !== -1) {
    const page = pages[errorPageIndex];
    if (pageIndicatesExpiredCursor(page)) {
      return {
        termination: 'expired-cursor',
        reason: `Page ${errorPageIndex} reported an expired cursor; retrieval did not complete.`,
        exhaustive: false,
      };
    }
    return {
      termination: 'rpc-error',
      reason: `Page ${errorPageIndex} reported an RPC error; retrieval did not complete.`,
      exhaustive: false,
    };
  }

  if (manifestStatus === 'expired-cursor') {
    return {
      termination: 'expired-cursor',
      reason: 'Manifest recorded an expired cursor; retrieval did not complete.',
      exhaustive: false,
    };
  }
  if (manifestStatus === 'rpc-error') {
    return {
      termination: 'rpc-error',
      reason: 'Manifest recorded an RPC error; retrieval did not complete.',
      exhaustive: false,
    };
  }
  if (manifestStatus === 'page-limit') {
    return {
      termination: 'page-limit',
      reason: 'Manifest recorded a page-limit termination; retrieval may be truncated.',
      exhaustive: false,
    };
  }
  if (manifestStatus === 'incomplete') {
    return {
      termination: 'incomplete',
      reason: 'Manifest recorded an incomplete retrieval.',
      exhaustive: false,
    };
  }

  const lastPage = pages[pages.length - 1];
  if (lastPage && lastPage.hasMore === true) {
    return {
      termination: 'page-limit',
      reason:
        'The final collected page indicated more results were available; retrieval stopped before exhaustion.',
      exhaustive: false,
    };
  }

  if (typeof pageLimit === 'number' && pages.length >= pageLimit) {
    return {
      termination: 'page-limit',
      reason: `Collected page count reached the recorded page limit (${pageLimit}); retrieval may be truncated.`,
      exhaustive: false,
    };
  }

  if (manifestStatus === 'exhausted') {
    return {
      termination: 'exhausted',
      reason: 'Manifest recorded an exhausted retrieval sequence.',
      exhaustive: true,
    };
  }

  if (lastPage && lastPage.hasMore === false) {
    return {
      termination: 'exhausted',
      reason:
        'The final collected page indicated no further results (hasMore=false).',
      exhaustive: true,
    };
  }

  return {
    termination: 'unknown',
    reason:
      'Retrieval termination could not be established from the collected pages; completeness is unverified.',
    exhaustive: false,
  };
}

function buildLimitations(
  termination: SorobanEventRetrievalStatus,
  exhaustive: boolean,
  pages: SorobanEventResponsePage[],
  missingMetadata: string[],
): string[] {
  const limitations: string[] = [];

  limitations.push(
    'Absence of returned events does not prove that no matching events occurred; empty ledger intervals are not evidence of event absence.',
  );

  if (!exhaustive) {
    limitations.push(
      `Retrieval termination was classified as "${termination}"; the collected results may not represent the full matching event set.`,
    );
  }

  if (missingMetadata.length > 0) {
    limitations.push(
      'Some pages were missing metadata (cursor, hasMore, latestLedger, or query context), which limits pagination and coverage analysis.',
    );
  }

  const hasLatestLedger = pages.some((page) => typeof page.latestLedger === 'number');
  if (!hasLatestLedger) {
    limitations.push(
      'No latestLedger information was available; historical coverage relative to the RPC tip cannot be established.',
    );
  }

  limitations.push(
    'Historical data availability depends on the configured RPC implementation and its retention policy; this audit cannot verify retention beyond the recorded responses.',
  );

  return limitations;
}

/**
 * Audit a saved collection of Soroban event response pages or a retrieval
 * manifest. This function performs no network access and does not modify any
 * input data.
 */
export function auditSorobanEventRetention(
  input: SorobanEventRetentionAuditInput,
): SorobanEventRetentionAuditResult {
  const pages = resolvePages(input);
  const query = resolveQuery(input, pages);
  const pageLimit = resolvePageLimit(input);
  const manifestStatus = input.manifest
    ? normalizeStatus(input.manifest.status)
    : undefined;

  const { statuses, missingMetadata } = buildPageStatuses(pages);
  const queryInconsistencies = compareQueryContexts(query, pages);
  const repeatedCursors = detectRepeatedCursors(pages);
  const duplicates = detectDuplicates(pages);
  const sequenceGaps = detectSequenceGaps(pages, pageLimit);
  const ledgerRange = collectLedgerBounds(pages, query);

  let eventCount = 0;
  for (const page of pages) {
    if (Array.isArray(page.events)) {
      eventCount += page.events.length;
    }
  }

  const { termination, reason, exhaustive } = classifyTermination(
    pages,
    manifestStatus,
    pageLimit,
  );

  const limitations = buildLimitations(
    termination,
    exhaustive,
    pages,
    missingMetadata,
  );

  return {
    query,
    pages: statuses,
    eventCount,
    ledgerRange,
    queryInconsistencies,
    repeatedCursors,
    duplicates,
    sequenceGaps,
    missingMetadata,
    termination,
    terminationReason: reason,
    exhaustive,
    limitations,
    originalPages: pages,
  };
}

/**
 * Serialize an audit result to a machine-readable JSON string. The original
 * event payloads are preserved unmodified.
 */
export function serializeSorobanEventRetentionAudit(
  result: SorobanEventRetentionAuditResult,
): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Render a human-readable summary of an audit result for terminal output.
 */
export function formatSorobanEventRetentionAudit(
  result: SorobanEventRetentionAuditResult,
): string {
  const lines: string[] = [];
  lines.push('Soroban Event Retention & Pagination Audit');
  lines.push('==========================================');

  if (result.query) {
    lines.push('Query context:');
    if (typeof result.query.startLedger === 'number') {
      lines.push(`  startLedger: ${result.query.startLedger}`);
    }
    if (typeof result.query.endLedger === 'number') {
      lines.push(`  endLedger: ${result.query.endLedger}`);
    }
    if (typeof result.query.limit === 'number') {
      lines.push(`  limit: ${result.query.limit}`);
    }
    if (Array.isArray(result.query.contractIds)) {
      lines.push(`  contractIds: ${result.query.contractIds.join(', ')}`);
    }
  } else {
    lines.push('Query context: (not recorded)');
  }

  lines.push('');
  lines.push(`Pages collected: ${result.pages.length}`);
  lines.push(`Events collected: ${result.eventCount}`);

  const { min, max, queryStartLedger, queryEndLedger } = result.ledgerRange;
  if (min !== undefined || max !== undefined) {
    lines.push(
      `Observed ledger range: ${min !== undefined ? min : '?'} .. ${
        max !== undefined ? max : '?'
      }`,
    );
  } else {
    lines.push('Observed ledger range: (unknown)');
  }
  if (queryStartLedger !== undefined || queryEndLedger !== undefined) {
    lines.push(
      `Query ledger bounds: ${queryStartLedger !== undefined ? queryStartLedger : '?'} .. ${
        queryEndLedger !== undefined ? queryEndLedger : '?'
      }`,
    );
  }

  lines.push('');
  lines.push(`Termination: ${result.termination}`);
  lines.push(`  ${result.terminationReason}`);
  lines.push(`Exhaustive: ${result.exhaustive ? 'yes' : 'no'}`);

  if (result.queryInconsistencies.length > 0) {
    lines.push('');
    lines.push('Query inconsistencies:');
    for (const inconsistency of result.queryInconsistencies) {
      lines.push(
        `  page ${inconsistency.pageIndex}: ${inconsistency.field} expected ${JSON.stringify(
          inconsistency.expected,
        )} but found ${JSON.stringify(inconsistency.actual)}`,
      );
    }
  }

  if (result.repeatedCursors.length > 0) {
    lines.push('');
    lines.push('Repeated cursors:');
    for (const finding of result.repeatedCursors) {
      lines.push(
        `  cursor "${finding.cursor}" on pages ${finding.pageIndices.join(
          ', ',
        )}${finding.potentialLoop ? ' (potential pagination loop)' : ''}`,
      );
    }
  }

  if (result.duplicates.length > 0) {
    lines.push('');
    lines.push('Duplicate events:');
    for (const finding of result.duplicates) {
      lines.push(
        `  id "${finding.identifier}" on pages ${finding.pageIndices.join(', ')}`,
      );
    }
  }

  if (result.sequenceGaps.length > 0) {
    lines.push('');
    lines.push('Sequence gaps:');
    for (const gap of result.sequenceGaps) {
      lines.push(`  ${gap}`);
    }
  }

  if (result.missingMetadata.length > 0) {
    lines.push('');
    lines.push('Missing metadata:');
    for (const missing of result.missingMetadata) {
      lines.push(`  ${missing}`);
    }
  }

  if (result.limitations.length > 0) {
    lines.push('');
    lines.push('Limitations:');
    for (const limitation of result.limitations) {
      lines.push(`  - ${limitation}`);
    }
  }

  return lines.join('\n');
}