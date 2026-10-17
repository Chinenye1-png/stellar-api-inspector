import chalk from 'chalk';
import { formatTable } from './table.js';

/**
 * Result of validating a single invocation argument against its declared
 * parameter type. Mirrors the shape produced by the Soroban argument
 * validator (ISSUE-092).
 */
export interface SorobanArgumentFinding {
  /** Zero-based position of the argument in the invocation. */
  index: number;
  /** Declared parameter name, when known from the contract specification. */
  name?: string;
  /** Declared parameter type as written in the contract specification. */
  expectedType?: string;
  /** The supplied argument value, already rendered for display. */
  suppliedValue?: string;
  /** Whether the argument validated and encoded successfully. */
  valid: boolean;
  /** Human-readable description of the finding (error or success detail). */
  message?: string;
  /** Encoded ScVal representation, when encoding succeeded. */
  encoded?: string;
}

/**
 * Overall result of a Soroban contract invocation argument validation run.
 */
export interface SorobanArgsValidationResult {
  /** Target contract identifier, when available. */
  contractId?: string;
  /** Target function name that was validated. */
  functionName: string;
  /** Whether every argument validated and encoded successfully. */
  valid: boolean;
  /** Per-parameter findings, in argument order. */
  parameters: SorobanArgumentFinding[];
  /** Encoded ScVal representations for successfully validated arguments. */
  encoded?: string[];
  /** Top-level errors (unknown function, wrong argument count, etc.). */
  errors?: string[];
  /** Non-fatal warnings (unsupported types, missing definitions, etc.). */
  warnings?: string[];
}

const NOTE =
  'Successful validation means argument compatibility and encoding success only. ' +
  'It is not proof that the contract invocation will succeed, that authorization ' +
  'will be granted, or that the transaction will be accepted by the network.';

function statusLabel(valid: boolean): string {
  return valid ? chalk.green('valid') : chalk.red('invalid');
}

function findingLabel(valid: boolean): string {
  return valid ? chalk.green('ok') : chalk.red('error');
}

function renderValue(value: string | undefined): string {
  if (value === undefined || value === null || value === '') {
    return chalk.dim('(none)');
  }
  return value;
}

function renderOptional(value: string | undefined): string {
  if (value === undefined || value === null || value === '') {
    return chalk.dim('(unknown)');
  }
  return value;
}

/**
 * Format a Soroban contract invocation argument validation result for the
 * terminal. Pure function: performs no I/O and has no side effects.
 */
export function formatSorobanArgsReport(result: SorobanArgsValidationResult): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Soroban Contract Invocation Argument Validation'));
  lines.push('');

  if (result.contractId) {
    lines.push(`${chalk.bold('Contract:')} ${result.contractId}`);
  }
  lines.push(`${chalk.bold('Function:')} ${result.functionName}`);
  lines.push(`${chalk.bold('Status:')} ${statusLabel(result.valid)}`);
  lines.push('');

  if (result.errors && result.errors.length > 0) {
    lines.push(chalk.bold.red('Errors'));
    for (const error of result.errors) {
      lines.push(`  ${chalk.red('✖')} ${error}`);
    }
    lines.push('');
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push(chalk.bold.yellow('Warnings'));
    for (const warning of result.warnings) {
      lines.push(`  ${chalk.yellow('!')} ${warning}`);
    }
    lines.push('');
  }

  lines.push(chalk.bold('Parameters'));
  if (result.parameters.length === 0) {
    lines.push(`  ${chalk.dim('(no arguments)')}`);
  } else {
    const rows = result.parameters.map((param) => [
      String(param.index),
      renderOptional(param.name),
      renderOptional(param.expectedType),
      renderValue(param.suppliedValue),
      findingLabel(param.valid),
      param.message ?? '',
    ]);

    lines.push(
      formatTable(
        ['#', 'Parameter', 'Expected Type', 'Supplied Value', 'Result', 'Finding'],
        rows,
      ),
    );
  }
  lines.push('');

  lines.push(chalk.bold('Encoded ScVal Representations'));
  const encoded = result.encoded ?? [];
  if (encoded.length === 0) {
    lines.push(`  ${chalk.dim('(none)')}`);
  } else {
    encoded.forEach((value, i) => {
      lines.push(`  ${chalk.dim(`[${i}]`)} ${value}`);
    });
  }
  lines.push('');

  lines.push(chalk.dim(NOTE));

  return lines.join('\n');
}

export default formatSorobanArgsReport;