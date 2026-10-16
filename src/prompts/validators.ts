import { StrKey } from '@stellar/stellar-sdk';
import { validateHorizonUrl } from '../utils/urls';
import { validateSorobanUrl } from '../inspectors/soroban';
import { existsSync, statSync } from 'fs';

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

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateTransactionEnvelopeXdr(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Transaction envelope XDR is required';
  }
  if (trimmed.length % 4 !== 0) {
    return 'Invalid base64: length must be a multiple of 4';
  }
  if (!BASE64_PATTERN.test(trimmed)) {
    return 'Invalid base64 transaction envelope XDR';
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 0) {
      return 'Transaction envelope XDR decodes to empty data';
    }
  } catch {
    return 'Invalid base64 transaction envelope XDR';
  }
  return true;
}

const KNOWN_NETWORK_ALIASES = new Set([
  'public',
  'mainnet',
  'pubnet',
  'testnet',
  'test',
  'futurenet',
  'standalone',
  'local',
]);

export function validateNetworkPassphrase(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Network passphrase or alias is required';
  }
  if (KNOWN_NETWORK_ALIASES.has(trimmed.toLowerCase())) {
    return true;
  }
  if (trimmed.length < 4) {
    return 'Network passphrase is too short';
  }
  return true;
}

export function validateBoundedRange(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Range is required';
  }
  const parts = trimmed.split(/[.:\-–]/).map((p) => p.trim());
  if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
    return 'Range must be in the form <start>..<end>';
  }
  const [startRaw, endRaw] = parts;
  const start = Number.parseInt(startRaw, 10);
  const end = Number.parseInt(endRaw, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return 'Range bounds must be integers';
  }
  if (start < 0 || end < 0) {
    return 'Range bounds must not be negative';
  }
  if (start > end) {
    return 'Range start must not exceed range end';
  }
  return true;
}

export function validateJsonFilePath(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'File path is required';
  }
  if (!existsSync(trimmed)) {
    return `File not found: ${trimmed}`;
  }
  try {
    const stats = statSync(trimmed);
    if (!stats.isFile()) {
      return 'Path does not point to a readable file';
    }
  } catch {
    return 'Path is not readable';
  }
  return true;
}