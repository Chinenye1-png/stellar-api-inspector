import * as fs from 'fs';
import * as path from 'path';

import {
  SorobanArgsValidator,
  SorobanArgsValidationResult,
  SorobanArgsValidationOptions,
  SorobanArgsInput,
  SorobanArgsInputFormat,
  SorobanArgsValidationError,
  SorobanArgsValidationErrorCode,
  SorobanArgsValidatorService,
} from '../services/soroban-args-validator';

export {
  SorobanArgsValidator,
  SorobanArgsValidationResult,
  SorobanArgsValidationOptions,
  SorobanArgsInput,
  SorobanArgsInputFormat,
  SorobanArgsValidationError,
  SorobanArgsValidationErrorCode,
  SorobanArgsValidatorService,
};

/**
 * Supported input file extensions for the contract specification artifact and
 * the proposed arguments payload.
 */
const SPEC_EXTENSIONS = ['.json', '.wasm', '.contractspec', '.spec'];
const ARGS_EXTENSIONS = ['.json'];

/**
 * Result of reading and parsing an input file prior to validation.
 */
export interface SorobanArgsFileInput {
  /** Absolute or resolved path the content was read from, or `<stdin>`. */
  source: string;
  /** Raw textual content of the input. */
  raw: string;
  /** Parsed representation of the input. */
  parsed: unknown;
  /** Detected input format. */
  format: SorobanArgsInputFormat;
}

/**
 * Options controlling how the inspector reads its inputs.
 */
export interface SorobanArgsInspectorOptions extends SorobanArgsValidationOptions {
  /** Path to the contract specification artifact. */
  specPath?: string;
  /** Path to the proposed arguments JSON payload. */
  argsPath?: string;
  /** Raw specification content, used instead of `specPath` when provided. */
  specContent?: string;
  /** Raw arguments content, used instead of `argsPath` when provided. */
  argsContent?: string;
  /** Read the specification from stdin when no path or content is supplied. */
  specFromStdin?: boolean;
  /** Read the arguments payload from stdin when no path or content is supplied. */
  argsFromStdin?: boolean;
}

/**
 * Determine the input format for a given file path based on its extension.
 *
 * @throws {SorobanArgsValidationError} when the extension is not supported.
 */
export function detectInputFormat(
  filePath: string,
  kind: 'spec' | 'args',
): SorobanArgsInputFormat {
  const ext = path.extname(filePath).toLowerCase();
  const allowed = kind === 'spec' ? SPEC_EXTENSIONS : ARGS_EXTENSIONS;

  if (!allowed.includes(ext)) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.UNSUPPORTED_INPUT_FORMAT,
      `Unsupported ${kind === 'spec' ? 'contract specification' : 'arguments'} file format "${ext || '<none>'}" for "${filePath}". Supported formats: ${allowed.join(', ')}.`,
    );
  }

  if (ext === '.json') {
    return 'json';
  }
  if (ext === '.wasm') {
    return 'wasm';
  }
  return 'contractspec';
}

/**
 * Validate that an input file exists, is readable, and has a supported format
 * before attempting to parse it.
 *
 * @throws {SorobanArgsValidationError} when the file is missing, unreadable, or
 *   has an unsupported extension.
 */
export function validateInputFile(
  filePath: string,
  kind: 'spec' | 'args',
): SorobanArgsInputFormat {
  if (!filePath || typeof filePath !== 'string') {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.MISSING_INPUT,
      `No ${kind === 'spec' ? 'contract specification' : 'arguments'} file path was provided.`,
    );
  }

  const format = detectInputFormat(filePath, kind);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.INPUT_NOT_FOUND,
      `Unable to read ${kind === 'spec' ? 'contract specification' : 'arguments'} file "${filePath}": ${(err as Error).message}`,
    );
  }

  if (!stat.isFile()) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.INPUT_NOT_FOUND,
      `Expected "${filePath}" to be a regular file.`,
    );
  }

  return format;
}

/**
 * Parse raw textual content according to the detected input format.
 *
 * @throws {SorobanArgsValidationError} when the content is malformed.
 */
export function parseInputContent(
  raw: string,
  format: SorobanArgsInputFormat,
  source: string,
): unknown {
  if (format === 'json') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new SorobanArgsValidationError(
        SorobanArgsValidationErrorCode.MALFORMED_INPUT,
        `Malformed JSON in "${source}": ${(err as Error).message}`,
      );
    }
  }

  // Non-JSON artifacts (wasm / contract spec) are passed through as raw text
  // for the validator service to interpret.
  return raw;
}

/**
 * Read and parse a single input from a file path or stdin.
 */
export function readInput(
  filePath: string | undefined,
  kind: 'spec' | 'args',
  fromStdin: boolean,
  content?: string,
): SorobanArgsFileInput {
  if (typeof content === 'string') {
    const format: SorobanArgsInputFormat = kind === 'args' ? 'json' : 'json';
    return {
      source: '<inline>',
      raw: content,
      parsed: parseInputContent(content, format, '<inline>'),
      format,
    };
  }

  if (fromStdin || (!filePath && kind === 'args')) {
    const raw = readStdin();
    const format: SorobanArgsInputFormat = 'json';
    return {
      source: '<stdin>',
      raw,
      parsed: parseInputContent(raw, format, '<stdin>'),
      format,
    };
  }

  if (!filePath) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.MISSING_INPUT,
      `No ${kind === 'spec' ? 'contract specification' : 'arguments'} input was provided.`,
    );
  }

  const format = validateInputFile(filePath, kind);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.INPUT_NOT_FOUND,
      `Unable to read "${filePath}": ${(err as Error).message}`,
    );
  }

  return {
    source: filePath,
    raw,
    parsed: parseInputContent(raw, format, filePath),
    format,
  };
}

/**
 * Synchronously read all of stdin as UTF-8 text.
 */
function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    throw new SorobanArgsValidationError(
      SorobanArgsValidationErrorCode.MISSING_INPUT,
      `Unable to read from stdin: ${(err as Error).message}`,
    );
  }
}

/**
 * Build a normalized {@link SorobanArgsInput} from inspector options.
 */
export function buildValidatorInput(
  options: SorobanArgsInspectorOptions,
): SorobanArgsInput {
  const spec = readInput(
    options.specPath,
    'spec',
    Boolean(options.specFromStdin),
    options.specContent,
  );
  const args = readInput(
    options.argsPath,
    'args',
    Boolean(options.argsFromStdin),
    options.argsContent,
  );

  return {
    spec: spec.parsed,
    specFormat: spec.format,
    specSource: spec.source,
    args: args.parsed,
    argsSource: args.source,
    functionName: options.functionName,
  };
}

/**
 * Entry point: read the contract specification artifact and the proposed
 * arguments JSON from file paths (or stdin), parse them, and delegate to the
 * argument validator service.
 *
 * This never executes a contract, submits a transaction, or modifies network
 * state; it only reports argument compatibility and encoding results.
 */
export function validateSorobanArgs(
  options: SorobanArgsInspectorOptions,
): SorobanArgsValidationResult {
  const input = buildValidatorInput(options);
  const validator = new SorobanArgsValidator(options);
  return validator.validate(input);
}

export default validateSorobanArgs;