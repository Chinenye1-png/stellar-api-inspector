import { StrKey } from '@stellar/stellar-sdk';
import { existsSync, statSync } from 'fs';
import { validateHorizonUrl } from '../utils/urls';
import { validateSorobanUrl } from '../inspectors/soroban';

export function validateNonEmpty(value: string): true | string {
  return value.trim().length > 0 || 'Value is required';
}

export function validateUrl(value: string): true | string {
  const result = validateHorizonUrl(value);
  return result.valid || result.error || 'Invalid URL';
}

export function validateSorobanRpcUrl(value: string): true | string {
  const result = validateSorobanUrl(value);
  return result.valid || result.error || 'Invalid Soroban RPC URL';
}

export function validateAccountId(value: string): true | string {
  return StrKey.isValidEd25519PublicKey(value.trim()) || 'Invalid Stellar account ID';
}

export function validateContractIdPrompt(value: string): true | string {
  return StrKey.isValidContract(value.trim()) || 'Invalid Soroban contract ID';
}

export function validatePositiveInteger(value: string): true | string {
  const parsed = Number.parseInt(value, 10);
  return (Number.isInteger(parsed) && parsed > 0) || 'Enter a positive integer';
}

export function validateReadableFilePath(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'File path is required';
  }
  if (!existsSync(trimmed)) {
    return 'File does not exist';
  }
  try {
    if (!statSync(trimmed).isFile()) {
      return 'Path is not a file';
    }
  } catch {
    return 'Unable to read file';
  }
  return true;
}

export function validateJsonInput(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'JSON value is required';
  }
  try {
    JSON.parse(trimmed);
  } catch {
    return 'Invalid JSON';
  }
  return true;
}