import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractCodeFromLedgerEntry,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../utils/xdr';

export type SorobanEventQueryValidationStatus = 'valid' | 'invalid' | 'warning';

export type SorobanEventQueryFindingSeverity = 'error' | 'warning' | 'info';

export interface SorobanEventQueryFinding {
  path: string;
  severity: SorobanEventQueryFindingSeverity;
  message: string;
  code: string;
}

export interface SorobanEventQueryTopicFilterResult {
  index: number;
  raw: unknown;
  valid: boolean;
  decoded?: string;
  findings: SorobanEventQueryFinding[];
}

export interface SorobanEventQueryEndpointCompatibility {
  endpoint: string;
  checked: boolean;
  compatible?: boolean;
  message: string;
}

export interface SorobanEventQueryValidationResult {
  status: SorobanEventQueryValidationStatus;
  valid: boolean;
  query: {
    type?: string;
    contractIds?: string[];
    topics?: SorobanEventQueryTopicFilterResult[];
    startLedger?: number;
    endLedger?: number;
  };
  requiredParameters: string[];
  optionalParameters: string[];
  findings: SorobanEventQueryFinding[];
  topicFilters: SorobanEventQueryTopicFilterResult[];
  ledgerRange: {
    startLedger?: number;
    endLedger?: number;
    valid: boolean;
    reversed: boolean;
  };
  endpointCompatibility?: SorobanEventQueryEndpointCompatibility;
  limitations: string[];
}

export interface SorobanEventQueryValidationOptions {
  endpoint?: string;
}

const SUPPORTED_EVENT_TYPES = ['contract', 'system', 'diagnostic'];
const REQUIRED_QUERY_PARAMETERS = ['type'];
const OPTIONAL_QUERY_PARAMETERS = ['contractIds', 'topics', 'startLedger', 'endLedger'];

const OFFLINE_LIMITATIONS = [
  'Local validation checks query structure and filter syntax only.',
  'A locally valid query does not guarantee that matching events exist.',
  'A locally valid query does not guarantee that any RPC endpoint will accept it.',
  'Historical coverage depends on the endpoint and its retained ledger range.',
];

export function validateSorobanEventQuery(
  config: unknown,
  options: SorobanEventQueryValidationOptions = {},
): SorobanEventQueryValidationResult {
  const findings: SorobanEventQueryFinding[] = [];
  const topicFilters: SorobanEventQueryTopicFilterResult[] = [];

  const result: SorobanEventQueryValidationResult = {
    status: 'valid',
    valid: true,
    query: {},
    requiredParameters: [...REQUIRED_QUERY_PARAMETERS],
    optionalParameters: [...OPTIONAL_QUERY_PARAMETERS],
    findings,
    topicFilters,
    ledgerRange: {
      valid: true,
      reversed: false,
    },
    limitations: [...OFFLINE_LIMITATIONS],
  };

  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    findings.push({
      path: '$',
      severity: 'error',
      code: 'invalid-config',
      message: 'Event query configuration must be a JSON object.',
    });
    return finalizeResult(result);
  }

  const query = config as Record<string, unknown>;

  const knownKeys = new Set([
    ...REQUIRED_QUERY_PARAMETERS,
    ...OPTIONAL_QUERY_PARAMETERS,
  ]);
  for (const key of Object.keys(query)) {
    if (!knownKeys.has(key)) {
      findings.push({
        path: key,
        severity: 'error',
        code: 'unsupported-field',
        message: `Unsupported event query field "${key}". Supported fields: ${[...knownKeys].join(', ')}.`,
      });
    }
  }

  // Required: type
  if (query.type === undefined) {
    findings.push({
      path: 'type',
      severity: 'error',
      code: 'missing-required-field',
      message: 'Missing required field "type".',
    });
  } else if (typeof query.type !== 'string') {
    findings.push({
      path: 'type',
      severity: 'error',
      code: 'malformed-value',
      message: 'Field "type" must be a string.',
    });
  } else if (!SUPPORTED_EVENT_TYPES.includes(query.type)) {
    findings.push({
      path: 'type',
      severity: 'error',
      code: 'unsupported-event-type',
      message: `Unsupported event type "${query.type}". Supported types: ${SUPPORTED_EVENT_TYPES.join(', ')}.`,
    });
  } else {
    result.query.type = query.type;
  }

  // Optional: contractIds
  if (query.contractIds !== undefined) {
    if (!Array.isArray(query.contractIds)) {
      findings.push({
        path: 'contractIds',
        severity: 'error',
        code: 'malformed-value',
        message: 'Field "contractIds" must be an array of contract identifier strings.',
      });
    } else {
      const contractIds: string[] = [];
      query.contractIds.forEach((contractId, index) => {
        if (typeof contractId !== 'string') {
          findings.push({
            path: `contractIds[${index}]`,
            severity: 'error',
            code: 'malformed-value',
            message: `Contract identifier at index ${index} must be a string.`,
          });
          return;
        }
        const validation = validateContractId(contractId);
        if (!validation.valid) {
          findings.push({
            path: `contractIds[${index}]`,
            severity: 'error',
            code: 'invalid-contract-id',
            message: validation.error ?? `Invalid contract identifier "${contractId}".`,
          });
          return;
        }
        contractIds.push(contractId);
      });
      result.query.contractIds = contractIds;
    }
  }

  // Optional: topics
  if (query.topics !== undefined) {
    if (!Array.isArray(query.topics)) {
      findings.push({
        path: 'topics',
        severity: 'error',
        code: 'malformed-value',
        message: 'Field "topics" must be an array of topic filter entries.',
      });
    } else {
      query.topics.forEach((topic, index) => {
        const topicResult = validateTopicFilter(topic, index);
        topicFilters.push(topicResult);
        findings.push(...topicResult.findings);
      });
    }
  }

  // Optional: ledger range
  const startLedger = query.startLedger;
  const endLedger = query.endLedger;

  if (startLedger !== undefined) {
    if (!isValidLedgerNumber(startLedger)) {
      findings.push({
        path: 'startLedger',
        severity: 'error',
        code: 'malformed-value',
        message: 'Field "startLedger" must be a non-negative integer.',
      });
    } else {
      result.query.startLedger = startLedger as number;
      result.ledgerRange.startLedger = startLedger as number;
    }
  }

  if (endLedger !== undefined) {
    if (!isValidLedgerNumber(endLedger)) {
      findings.push({
        path: 'endLedger',
        severity: 'error',
        code: 'malformed-value',
        message: 'Field "endLedger" must be a non-negative integer.',
      });
    } else {
      result.query.endLedger = endLedger as number;
      result.ledgerRange.endLedger = endLedger as number;
    }
  }

  if (
    result.ledgerRange.startLedger !== undefined &&
    result.ledgerRange.endLedger !== undefined
  ) {
    if (result.ledgerRange.endLedger < result.ledgerRange.startLedger) {
      result.ledgerRange.valid = false;
      result.ledgerRange.reversed = true;
      findings.push({
        path: 'endLedger',
        severity: 'error',
        code: 'reversed-ledger-range',
        message: `Ledger range is reversed: endLedger (${result.ledgerRange.endLedger}) is less than startLedger (${result.ledgerRange.startLedger}).`,
      });
    }
  }

  if (options.endpoint) {
    result.endpointCompatibility = {
      endpoint: options.endpoint,
      checked: false,
      message:
        'Endpoint compatibility was not verified. Local schema validation does not confirm that the endpoint accepts this query or retains the requested ledger range.',
    };
    findings.push({
      path: 'endpoint',
      severity: 'info',
      code: 'endpoint-not-checked',
      message:
        'Endpoint information was supplied, but only local schema validation was performed. Endpoint acceptance and historical coverage were not verified.',
    });
  }

  return finalizeResult(result);
}

function validateTopicFilter(
  topic: unknown,
  index: number,
): SorobanEventQueryTopicFilterResult {
  const findings: SorobanEventQueryFinding[] = [];
  const result: SorobanEventQueryTopicFilterResult = {
    index,
    raw: topic,
    valid: true,
    findings,
  };

  if (topic === null || topic === undefined) {
    result.valid = false;
    findings.push({
      path: `topics[${index}]`,
      severity: 'error',
      code: 'malformed-topic',
      message: `Topic filter at index ${index} must not be null.`,
    });
    return result;
  }

  if (Array.isArray(topic)) {
    if (topic.length === 0) {
      findings.push({
        path: `topics[${index}]`,
        severity: 'warning',
        code: 'empty-topic-filter',
        message: `Topic filter at index ${index} is an empty array and will match any topic at this position.`,
      });
      return result;
    }
    topic.forEach((segment, segmentIndex) => {
      validateTopicSegment(segment, `topics[${index}][${segmentIndex}]`, findings, result);
    });
    return result;
  }

  if (typeof topic === 'string') {
    validateTopicSegment(topic, `topics[${index}]`, findings, result);
    return result;
  }

  result.valid = false;
  findings.push({
    path: `topics[${index}]`,
    severity: 'error',
    code: 'malformed-topic',
    message: `Topic filter at index ${index} must be a string or an array of strings.`,
  });
  return result;
}

function validateTopicSegment(
  segment: unknown,
  path: string,
  findings: SorobanEventQueryFinding[],
  result: SorobanEventQueryTopicFilterResult,
): void {
  if (segment === null || segment === undefined) {
    result.valid = false;
    findings.push({
      path,
      severity: 'error',
      code: 'malformed-topic',
      message: 'Topic segment must not be null.',
    });
    return;
  }

  if (typeof segment !== 'string') {
    result.valid = false;
    findings.push({
      path,
      severity: 'error',
      code: 'malformed-topic',
      message: 'Topic segment must be a base64-encoded ScVal string.',
    });
    return;
  }

  if (segment.length === 0) {
    findings.push({
      path,
      severity: 'warning',
      code: 'empty-topic-segment',
      message: 'Topic segment is an empty string and will match any value at this position.',
    });
    return;
  }

  const decoded = tryDecodeScValTopic(segment);
  if (!decoded.valid) {
    result.valid = false;
    findings.push({
      path,
      severity: 'error',
      code: 'malformed-scval-topic',
      message: decoded.error,
    });
    return;
  }

  if (decoded.decoded !== undefined) {
    result.decoded = decoded.decoded;
  }
}

function tryDecodeScValTopic(segment: string): { valid: boolean; decoded?: string; error: string } {
  const normalized = segment.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return {
      valid: false,
      error: `Topic segment "${segment}" is not valid base64 and cannot be decoded as an ScVal.`,
    };
  }

  try {
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) {
      return {
        valid: false,
        error: `Topic segment "${segment}" decoded to an empty ScVal payload.`,
      };
    }
    return { valid: true, decoded: buffer.toString('hex'), error: '' };
  } catch {
    return {
      valid: false,
      error: `Topic segment "${segment}" could not be decoded as an ScVal.`,
    };
  }
}

function isValidLedgerNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function finalizeResult(
  result: SorobanEventQueryValidationResult,
): SorobanEventQueryValidationResult {
  const hasError = result.findings.some((finding) => finding.severity === 'error');
  const hasWarning = result.findings.some((finding) => finding.severity === 'warning');

  result.valid = !hasError;
  if (hasError) {
    result.status = 'invalid';
  } else if (hasWarning) {
    result.status = 'warning';
  } else {
    result.status = 'valid';
  }

  return result;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface LatestLedgerResult {
  sequence?: number;
}

interface LedgerEntryResponse {
  key?: string;
  xdr?: string;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
  expirationLedgerSeq?: number;
  entry?: {
    xdr?: string;
    lastModifiedLedgerSeq?: number;
    liveUntilLedgerSeq?: number;
    expirationLedgerSeq?: number;
  };
  val?: {
    xdr?: string;
  };
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
  latestLedger?: number;
  latestLedgerSequence?: number;
}

export interface ContractInspectionOptions {
  rpcUrl: string;
  contractId: string;
  ttlWarningLedgers?: number;
}

export interface ContractInspectionResult {
  contractId: string;
  rpcUrl: string;
  wasmHash?: string;
  owner?: string;
  currentLedger?: number;
  instance: {
    found: boolean;
    lastModifiedLedger?: number;
    liveUntilLedger?: number;
    currentTtl?: number;
    remainingLedgers?: number;
  };
  code: {
    found: boolean;
    wasmSizeBytes?: number;
  };
  storage: {
    footprint: string[];
    instanceStorageEntryCount: number;
    queriedEntryCount: number;
    foundEntryCount: number;
  };
  warnings: string[];
}

export async function inspectSorobanContract(
  options: ContractInspectionOptions,
): Promise<ContractInspectionResult> {
  const ttlWarningLedgers = options.ttlWarningLedgers ?? 17280;
  const validation = validateContractId(options.contractId);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const instanceKey = buildContractInstanceLedgerKey(options.contractId);
  const currentLedger = await getLatestLedgerSequence(options.rpcUrl);
  const instanceEntries = await getLedgerEntries(options.rpcUrl, [instanceKey]);
  const instanceEntry = instanceEntries.entries[0];

  const result: ContractInspectionResult = {
    contractId: options.contractId,
    rpcUrl: options.rpcUrl,
    currentLedger,
    instance: {
      found: Boolean(instanceEntry),
    },
    code: {
      found: false,
    },
    storage: {
      footprint: [instanceKey],
      instanceStorageEntryCount: 0,
      queriedEntryCount: 1,
      foundEntryCount: instanceEntry ? 1 : 0,
    },
    warnings: [],
  };

  if (!instanceEntry) {
    result.warnings.push('Contract instance ledger entry was not found.');
    return result;
  }

  const instanceXdr = extractLedgerEntryXdr(instanceEntry);
  if (!instanceXdr) {
    result.warnings.push('Contract instance ledger entry did not include XDR payload.');
    return result;
  }

  const instanceMetadata = parseContractInstanceFromLedgerEntry(instanceXdr);
  result.wasmHash = instanceMetadata.wasmHash;
  result.owner = instanceMetadata.owner;
  result.storage.instanceStorageEntryCount = instanceMetadata.storageEntryCount;
  result.instance.lastModifiedLedger = extractLastModifiedLedger(instanceEntry);
  result.instance.liveUntilLedger = extractExpirationLedger(instanceEntry);
  result.instance.currentTtl = result.instance.liveUntilLedger;

  if (result.instance.liveUntilLedger !== undefined && currentLedger !== undefined) {
    result.instance.remainingLedgers = Math.max(0, result.instance.liveUntilLedger - currentLedger);

    if (result.instance.remainingLedgers <= ttlWarningLedgers) {
      result.warnings.push(
        `Contract TTL is below warning threshold (${result.instance.remainingLedgers} ledgers remaining; threshold ${ttlWarningLedgers}).`,
      );
    }
  }

  if (result.wasmHash) {
    const codeKey = buildContractCodeLedgerKey(result.wasmHash);
    result.storage.footprint.push(codeKey);
    result.storage.queriedEntryCount += 1;

    const codeEntries = await getLedgerEntries(options.rpcUrl, [codeKey]);
    const codeEntry = codeEntries.entries[0];
    result.code.found = Boolean(codeEntry);
    if (codeEntry) {
      result.storage.foundEntryCount += 1;
      const codeXdr = extractLedgerEntryXdr(codeEntry);
      if (codeXdr) {
        const codeMetadata = parseContractCodeFromLedgerEntry(codeXdr);
        result.code.wasmSizeBytes = codeMetadata.wasmSizeBytes;
      }
    } else {
      result.warnings.push('Contract WASM code ledger entry was not found.');
    }
  } else {
    result.warnings.push('Contract instance did not reference a WASM code hash.');
  }

  return result;
}

async function getLatestLedgerSequence(rpcUrl: string): Promise<number | undefined> {
  try {
    const result = await sendJsonRpc<LatestLedgerResult>(rpcUrl, 'getLatestLedger');
    return result.sequence;
  } catch {
    return undefined;
  }
}

async function getLedgerEntries(
  rpcUrl: string,
  keys: string[],
): Promise<{ entries: LedgerEntryResponse[] }> {
  const result = await sendJsonRpc<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', { keys });
  return { entries: result.entries ?? [] };
}

async function sendJsonRpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  }

  return json.result;
}

function extractLedgerEntryXdr(entry: LedgerEntryResponse): string | undefined {
  return entry.xdr ?? entry.entry?.xdr ?? entry.val?.xdr;
}

function extractLastModifiedLedger(entry: LedgerEntryResponse): number | undefined {
  return entry.lastModifiedLedgerSeq ?? entry.entry?.lastModifiedLedgerSeq;
}

function extractExpirationLedger(entry: LedgerEntryResponse): number | undefined {
  return (
    entry.liveUntilLedgerSeq ??
    entry.expirationLedgerSeq ??
    entry.entry?.liveUntilLedgerSeq ??
    entry.entry?.expirationLedgerSeq
  );
}
