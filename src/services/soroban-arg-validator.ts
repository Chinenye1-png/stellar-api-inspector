import { xdr } from '@stellar/stellar-sdk';
import {
  ContractInterface,
  ContractFunction,
  ContractParameter,
  inspectContractInterface,
} from './soroban-contract';
import {
  encodeScVal,
  ScValEncodingError,
  ScValTypeDescriptor,
} from '../utils/xdr';

/**
 * ISSUE-092: Soroban contract invocation argument validation.
 *
 * This module validates proposed invocation arguments against a supplied
 * Soroban contract specification. It performs *local* validation only:
 *  - it never executes a contract,
 *  - it never submits a transaction,
 *  - it never modifies network state.
 *
 * A successful validation means the arguments are *compatible* with the
 * declared parameter types and can be encoded into ScVal representations.
 * It is NOT proof that the contract invocation will succeed.
 */

/** A single proposed invocation argument, as supplied by the caller. */
export type ProposedArgument = unknown;

/** The overall validation status for an invocation. */
export type ArgumentValidationStatus =
  | 'valid'
  | 'invalid'
  | 'unsupported'
  | 'unknown-function'
  | 'missing-specification';

/** A category describing why a parameter-level finding was produced. */
export type ParameterFindingCode =
  | 'type-mismatch'
  | 'unsupported-type'
  | 'missing-type-definition'
  | 'ambiguous-input'
  | 'precision-loss'
  | 'encoding-failure'
  | 'missing-argument'
  | 'extra-argument';

/** A parameter-level validation finding. */
export interface ParameterFinding {
  /** Zero-based index of the argument in the supplied argument list. */
  index: number;
  /** Declared parameter name, when available from the specification. */
  parameterName?: string;
  /** Declared parameter type, when available from the specification. */
  declaredType?: string;
  /** Machine-readable finding category. */
  code: ParameterFindingCode;
  /** Human-readable description of the finding. */
  message: string;
}

/** The encoded ScVal representation for a successfully validated argument. */
export interface EncodedArgument {
  /** Zero-based index of the argument in the supplied argument list. */
  index: number;
  /** Declared parameter name, when available from the specification. */
  parameterName?: string;
  /** Declared parameter type, when available from the specification. */
  declaredType?: string;
  /** The encoded ScVal representation. */
  scVal: xdr.ScVal;
  /** A JSON-friendly representation of the encoded ScVal for output. */
  scValJson: unknown;
}

/** The complete result of validating a set of invocation arguments. */
export interface ArgumentValidationResult {
  /** The target function name that was validated. */
  functionName: string;
  /** Overall validation status. */
  status: ArgumentValidationStatus;
  /** Whether all supplied arguments validated and encoded successfully. */
  valid: boolean;
  /** Per-parameter findings. Empty when validation succeeded. */
  findings: ParameterFinding[];
  /** Encoded ScVal representations for successfully validated arguments. */
  encoded: EncodedArgument[];
  /**
   * A human-readable summary. Describes argument compatibility and encoding
   * success only; it does not assert that the invocation will succeed.
   */
  summary: string;
}

/** Options controlling argument validation. */
export interface ValidateArgumentsOptions {
  /** The contract specification artifact or local interface source. */
  specification: unknown;
  /** The target function name. */
  functionName: string;
  /** The proposed invocation arguments. */
  args: ProposedArgument[];
}

/** Error thrown when the specification itself cannot be interpreted. */
export class SpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecificationError';
  }
}

/**
 * Resolve the contract interface from a supplied specification artifact or
 * local interface source, reusing the existing contract interface inspection
 * capability. Never invents type information for incomplete specifications.
 */
function resolveContractInterface(specification: unknown): ContractInterface {
  if (specification === null || specification === undefined) {
    throw new SpecificationError(
      'No contract specification was supplied. Provide a contract specification artifact or a supported local contract interface source.',
    );
  }

  let contractInterface: ContractInterface;
  try {
    contractInterface = inspectContractInterface(specification);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SpecificationError(
      `Unable to interpret the supplied contract specification: ${detail}`,
    );
  }

  if (!contractInterface || !Array.isArray(contractInterface.functions)) {
    throw new SpecificationError(
      'The supplied contract specification does not contain a usable contract interface. Type information will not be guessed.',
    );
  }

  return contractInterface;
}

/** Find a function by name within a contract interface. */
function findFunction(
  contractInterface: ContractInterface,
  functionName: string,
): ContractFunction | undefined {
  return contractInterface.functions.find(
    (fn) => fn.name === functionName,
  );
}

/** Build a type descriptor from a declared parameter type. */
function toTypeDescriptor(
  parameter: ContractParameter | undefined,
): ScValTypeDescriptor | undefined {
  if (!parameter || !parameter.type) {
    return undefined;
  }
  return parameter.type as ScValTypeDescriptor;
}

/**
 * Validate a set of proposed invocation arguments against a supplied Soroban
 * contract specification.
 *
 * This is a pure function: it does not execute the contract, submit a
 * transaction, or modify network state.
 */
export function validateArguments(
  options: ValidateArgumentsOptions,
): ArgumentValidationResult {
  const { specification, functionName, args } = options;

  const proposedArgs = Array.isArray(args) ? args : [];

  let contractInterface: ContractInterface;
  try {
    contractInterface = resolveContractInterface(specification);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      functionName,
      status: 'missing-specification',
      valid: false,
      findings: [
        {
          index: -1,
          code: 'missing-type-definition',
          message,
        },
      ],
      encoded: [],
      summary:
        'Argument validation could not proceed: the contract specification is missing or could not be interpreted.',
    };
  }

  const fn = findFunction(contractInterface, functionName);
  if (!fn) {
    return {
      functionName,
      status: 'unknown-function',
      valid: false,
      findings: [
        {
          index: -1,
          code: 'type-mismatch',
          message: `Function "${functionName}" was not found in the supplied contract specification.`,
        },
      ],
      encoded: [],
      summary: `Argument validation failed: function "${functionName}" is not declared in the supplied contract specification.`,
    };
  }

  const parameters: ContractParameter[] = Array.isArray(fn.parameters)
    ? fn.parameters
    : [];

  const findings: ParameterFinding[] = [];
  const encoded: EncodedArgument[] = [];

  // Argument count validation.
  if (proposedArgs.length < parameters.length) {
    for (let i = proposedArgs.length; i < parameters.length; i += 1) {
      const parameter = parameters[i];
      findings.push({
        index: i,
        parameterName: parameter?.name,
        declaredType: describeType(parameter),
        code: 'missing-argument',
        message: `Missing argument for parameter "${parameter?.name ?? i}" (expected ${describeType(parameter) ?? 'unknown type'}).`,
      });
    }
  } else if (proposedArgs.length > parameters.length) {
    for (let i = parameters.length; i < proposedArgs.length; i += 1) {
      findings.push({
        index: i,
        code: 'extra-argument',
        message: `Unexpected extra argument at index ${i}; function "${functionName}" declares ${parameters.length} parameter(s).`,
      });
    }
  }

  // Per-argument validation for the overlapping range.
  const overlap = Math.min(proposedArgs.length, parameters.length);
  for (let i = 0; i < overlap; i += 1) {
    const parameter = parameters[i];
    const value = proposedArgs[i];
    const parameterName = parameter?.name;
    const declaredType = describeType(parameter);

    const descriptor = toTypeDescriptor(parameter);
    if (!descriptor) {
      findings.push({
        index: i,
        parameterName,
        declaredType,
        code: 'missing-type-definition',
        message: `No type definition is available for parameter "${parameterName ?? i}". The type will not be guessed.`,
      });
      continue;
    }

    let scVal: xdr.ScVal;
    try {
      scVal = encodeScVal(descriptor, value);
    } catch (error) {
      findings.push(
        toFindingFromEncodingError(error, i, parameterName, declaredType),
      );
      continue;
    }

    encoded.push({
      index: i,
      parameterName,
      declaredType,
      scVal,
      scValJson: safeScValToJson(scVal),
    });
  }

  const valid = findings.length === 0;
  const status: ArgumentValidationStatus = valid ? 'valid' : 'invalid';

  return {
    functionName,
    status,
    valid,
    findings,
    encoded,
    summary: buildSummary(functionName, valid, findings, encoded),
  };
}

/** Convert an encoding error into a parameter-level finding. */
function toFindingFromEncodingError(
  error: unknown,
  index: number,
  parameterName: string | undefined,
  declaredType: string | undefined,
): ParameterFinding {
  if (error instanceof ScValEncodingError) {
    return {
      index,
      parameterName,
      declaredType,
      code: error.code,
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    index,
    parameterName,
    declaredType,
    code: 'encoding-failure',
    message: `Failed to encode argument for parameter "${parameterName ?? index}": ${message}`,
  };
}

/** Produce a readable description of a parameter's declared type. */
function describeType(parameter: ContractParameter | undefined): string | undefined {
  if (!parameter || !parameter.type) {
    return undefined;
  }
  const type = parameter.type as { name?: string; kind?: string };
  if (typeof type.name === 'string') {
    return type.name;
  }
  if (typeof type.kind === 'string') {
    return type.kind;
  }
  return undefined;
}

/** Safely convert an ScVal to a JSON-friendly representation. */
function safeScValToJson(scVal: xdr.ScVal): unknown {
  try {
    return scVal.toXDR('base64');
  } catch {
    try {
      return scVal.toJSON();
    } catch {
      return null;
    }
  }
}

/** Build a human-readable summary that does not overstate success. */
function buildSummary(
  functionName: string,
  valid: boolean,
  findings: ParameterFinding[],
  encoded: EncodedArgument[],
): string {
  if (valid) {
    return `Arguments for function "${functionName}" are compatible with the declared parameter types and were encoded successfully (${encoded.length} argument(s)). This confirms argument compatibility and encoding only; it does not guarantee that the contract invocation will succeed.`;
  }
  return `Argument validation failed for function "${functionName}" with ${findings.length} finding(s). Arguments were not encoded for the affected parameters.`;
}

/** Serialize a validation result to a machine-readable JSON object. */
export function toJsonResult(result: ArgumentValidationResult): unknown {
  return {
    function: result.functionName,
    status: result.status,
    valid: result.valid,
    summary: result.summary,
    findings: result.findings.map((finding) => ({
      index: finding.index,
      parameterName: finding.parameterName ?? null,
      declaredType: finding.declaredType ?? null,
      code: finding.code,
      message: finding.message,
    })),
    encoded: result.encoded.map((entry) => ({
      index: entry.index,
      parameterName: entry.parameterName ?? null,
      declaredType: entry.declaredType ?? null,
      scVal: entry.scValJson,
    })),
  };
}

/** Render a validation result as readable terminal output. */
export function formatResult(result: ArgumentValidationResult): string {
  const lines: string[] = [];
  lines.push(`Function: ${result.functionName}`);
  lines.push(`Status: ${result.status}`);
  lines.push('');

  if (result.encoded.length > 0) {
    lines.push('Encoded arguments:');
    for (const entry of result.encoded) {
      const label = entry.parameterName
        ? `${entry.index} (${entry.parameterName})`
        : `${entry.index}`;
      lines.push(`  [${label}] ${entry.declaredType ?? 'unknown type'}`);
      lines.push(`    ${JSON.stringify(entry.scValJson)}`);
    }
    lines.push('');
  }

  if (result.findings.length > 0) {
    lines.push('Findings:');
    for (const finding of result.findings) {
      const label =
        finding.index >= 0
          ? finding.parameterName
            ? `[${finding.index}] ${finding.parameterName}`
            : `[${finding.index}]`
          : '[specification]';
      lines.push(`  ${label} ${finding.code}: ${finding.message}`);
    }
    lines.push('');
  }

  lines.push(result.summary);
  return lines.join('\n');
}