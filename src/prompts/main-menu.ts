import {
  validateAccountId,
  validateContractIdPrompt,
  validateNonEmpty,
  validatePositiveInteger,
  validateSorobanRpcUrl,
  validateUrl,
} from './validators';

export type InteractiveAction =
  | 'horizon'
  | 'soroban'
  | 'account'
  | 'health'
  | 'ledger'
  | 'asset'
  | 'fees'
  | 'decode'
  | 'operations'
  | 'contract'
  | 'soroban-tx'
  | 'trades'
  | 'balance-reconcile'
  | 'soroban-validate'
  | 'trustline-exposure'
  | 'federation-validate'
  | 'exit';

export interface InteractiveCommand {
  command: string;
  args: string[];
  summary: string;
}

interface PromptModule {
  prompt<T>(questions: unknown): Promise<T>;
}

export async function runInteractiveMode(
  argv: string[],
  execute: (argv: string[]) => Promise<void> | void,
): Promise<void> {
  const inquirer = await loadInquirer();
  const command = await collectInteractiveCommand(inquirer);

  if (!command) {
    process.stderr.write('Interactive mode cancelled.\n');
    return;
  }

  const confirmation = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Run: ${command.summary}?`,
      default: true,
    },
  ]);

  if (!confirmation.confirmed) {
    process.stderr.write('Command cancelled.\n');
    return;
  }

  await execute([...argv.slice(0, 2), command.command, ...command.args]);
}

export async function collectInteractiveCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand | null> {
  const menu = await inquirer.prompt<{ action: InteractiveAction }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an inspection',
      choices: [
        { name: 'Inspect Horizon Endpoint', value: 'horizon' },
        { name: 'Inspect Soroban Endpoint', value: 'soroban' },
        { name: 'Audit Account', value: 'account' },
        { name: 'Multi-Endpoint Health Dashboard', value: 'health' },
        { name: 'Inspect Ledger Header', value: 'ledger' },
        { name: 'Inspect Asset', value: 'asset' },
        { name: 'Network Fee Statistics', value: 'fees' },
        { name: 'Decode Transaction XDR', value: 'decode' },
        { name: 'Operations History', value: 'operations' },
        { name: 'Inspect Soroban Contract', value: 'contract' },
        { name: 'Inspect Soroban Transaction', value: 'soroban-tx' },
        { name: 'Market Trade History', value: 'trades' },
        { name: 'Reconcile Account Balance Changes', value: 'balance-reconcile' },
        { name: 'Validate Soroban Invocation Arguments', value: 'soroban-validate' },
        { name: 'Audit Trustline Exposure', value: 'trustline-exposure' },
        { name: 'Validate Federation Response', value: 'federation-validate' },
        { name: 'Exit', value: 'exit' },
      ],
    },
  ]);

  switch (menu.action) {
    case 'horizon':
      return collectHorizonCommand(inquirer);
    case 'soroban':
      return collectSorobanCommand(inquirer);
    case 'account':
      return collectAccountCommand(inquirer);
    case 'health':
      return collectHealthCommand(inquirer);
    case 'ledger':
      return collectLedgerCommand(inquirer);
    case 'asset':
      return collectAssetCommand(inquirer);
    case 'fees':
      return collectFeesCommand(inquirer);
    case 'decode':
      return collectDecodeCommand(inquirer);
    case 'operations':
      return collectOperationsCommand(inquirer);
    case 'contract':
      return collectContractCommand(inquirer);
    case 'soroban-tx':
      return collectSorobanTxCommand(inquirer);
    case 'trades':
      return collectTradesCommand(inquirer);
    case 'balance-reconcile':
      return collectBalanceReconcileCommand(inquirer);
    case 'soroban-validate':
      return collectSorobanValidateCommand(inquirer);
    case 'trustline-exposure':
      return collectTrustlineExposureCommand(inquirer);
    case 'federation-validate':
      return collectFederationValidateCommand(inquirer);
    case 'exit':
      return null;
  }
}

async function collectHorizonCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ url: string }>([
    {
      type: 'input',
      name: 'url',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'horizon',
    args: [answers.url],
    summary: `stellar-api-inspector horizon ${answers.url}`,
  };
}

async function collectSorobanCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ url: string }>([
    {
      type: 'input',
      name: 'url',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
  ]);

  return {
    command: 'soroban',
    args: [answers.url],
    summary: `stellar-api-inspector soroban ${answers.url}`,
  };
}

async function collectAccountCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ accountId: string; horizon: string }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'account',
    args: [answers.accountId, '--horizon', answers.horizon],
    summary: `stellar-api-inspector account ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectHealthCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ urls: string }>([
    {
      type: 'input',
      name: 'urls',
      message: 'Horizon endpoint URLs, comma-separated',
      validate: (value: string) => {
        const urls = splitCsv(value);
        if (urls.length === 0) return 'At least one URL is required';
        const invalid = urls.find((url) => validateUrl(url) !== true);
        return invalid ? `Invalid URL: ${invalid}` : true;
      },
    },
  ]);

  const urls = splitCsv(answers.urls);
  return {
    command: 'health',
    args: urls,
    summary: `stellar-api-inspector health ${urls.join(' ')}`,
  };
}

async function collectDecodeCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ xdr: string; network: string }>([
    {
      type: 'input',
      name: 'xdr',
      message: 'Transaction envelope XDR',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
  ]);

  return {
    command: 'decode',
    args: [answers.xdr, '--network', answers.network],
    summary: 'stellar-api-inspector decode <xdr>',
  };
}

async function collectOperationsCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    horizon: string;
    account: string;
    type: string;
    limit: string;
  }>([
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'account',
      message: 'Optional account filter',
      validate: (value: string) => value.trim() === '' || validateAccountId(value),
    },
    {
      type: 'input',
      name: 'type',
      message: 'Optional operation type filter',
    },
    {
      type: 'input',
      name: 'limit',
      message: 'Result limit',
      default: '10',
      validate: validatePositiveInteger,
    },
  ]);

  const args = ['--horizon', answers.horizon, '--limit', answers.limit];
  if (answers.account.trim()) args.push('--account', answers.account.trim());
  if (answers.type.trim()) args.push('--type', answers.type.trim());

  return {
    command: 'operations',
    args,
    summary: `stellar-api-inspector operations ${args.join(' ')}`,
  };
}

async function collectContractCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    contractId: string;
    rpc: string;
    ttlWarning: string;
  }>([
    {
      type: 'input',
      name: 'contractId',
      message: 'Soroban contract ID',
      validate: validateContractIdPrompt,
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
    {
      type: 'input',
      name: 'ttlWarning',
      message: 'TTL warning threshold in ledgers',
      default: '17280',
      validate: validatePositiveInteger,
    },
  ]);

  return {
    command: 'contract',
    args: [answers.contractId, '--rpc', answers.rpc, '--ttl-warning-ledgers', answers.ttlWarning],
    summary: `stellar-api-inspector contract ${answers.contractId} --rpc ${answers.rpc}`,
  };
}

async function loadInquirer(): Promise<PromptModule> {
  const imported = (await import('inquirer')) as unknown as {
    default?: PromptModule;
  } & PromptModule;
  return imported.default ?? imported;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function collectLedgerCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ sequence: string; horizon: string }>([
    {
      type: 'input',
      name: 'sequence',
      message: 'Ledger sequence',
      validate: validatePositiveInteger,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'ledger',
    args: [answers.sequence, '--horizon', answers.horizon],
    summary: `stellar-api-inspector ledger ${answers.sequence} --horizon ${answers.horizon}`,
  };
}

async function collectAssetCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ asset: string; horizon: string }>([
    {
      type: 'input',
      name: 'asset',
      message: 'Asset CODE:ISSUER',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'asset',
    args: [answers.asset, '--horizon', answers.horizon],
    summary: `stellar-api-inspector asset ${answers.asset} --horizon ${answers.horizon}`,
  };
}

async function collectFeesCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ horizon: string }>([
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'fees',
    args: ['--horizon', answers.horizon],
    summary: `stellar-api-inspector fees --horizon ${answers.horizon}`,
  };
}

async function collectSorobanTxCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ hash: string; rpc: string }>([
    {
      type: 'input',
      name: 'hash',
      message: 'Transaction hash (64 hex characters)',
      validate: (value: string) =>
        /^[0-9a-fA-F]{64}$/.test(value.trim()) || 'Enter a valid 64-character hex transaction hash',
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
  ]);

  return {
    command: 'soroban-tx',
    args: [answers.hash.trim(), '--rpc', answers.rpc],
    summary: `stellar-api-inspector soroban-tx ${answers.hash.trim()} --rpc ${answers.rpc}`,
  };
}

async function collectTradesCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    baseAsset: string;
    counterAsset: string;
    horizon: string;
    limit: string;
  }>([
    {
      type: 'input',
      name: 'baseAsset',
      message: 'Base asset (e.g. XLM or CODE:ISSUER)',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'counterAsset',
      message: 'Counter asset (e.g. USDC:ISSUER)',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'limit',
      message: 'Number of trades to fetch',
      default: '20',
      validate: validatePositiveInteger,
    },
  ]);

  const args = [
    answers.baseAsset,
    answers.counterAsset,
    '--horizon',
    answers.horizon,
    '--limit',
    answers.limit,
  ];

  return {
    command: 'trades',
    args,
    summary: `stellar-api-inspector trades ${answers.baseAsset} ${answers.counterAsset} --horizon ${answers.horizon} --limit ${answers.limit}`,
  };
}

async function collectBalanceReconcileCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    before: string;
    after: string;
    activity: string;
    network: string;
  }>([
    {
      type: 'input',
      name: 'before',
      message: 'Path to the earlier account snapshot JSON',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'after',
      message: 'Path to the later account snapshot JSON',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'activity',
      message: 'Optional path to transaction/operation records for the interval',
      validate: (value: string) => value.trim() === '' || validateNonEmpty(value),
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
  ]);

  const args = [answers.before, answers.after, '--network', answers.network];
  if (answers.activity.trim()) args.push('--activity', answers.activity.trim());

  return {
    command: 'balance-reconcile',
    args,
    summary: `stellar-api-inspector balance-reconcile ${answers.before} ${answers.after} --network ${answers.network}`,
  };
}

async function collectSorobanValidateCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    spec: string;
    function: string;
    args: string;
  }>([
    {
      type: 'input',
      name: 'spec',
      message: 'Path to the contract specification artifact',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'function',
      message: 'Target function name',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'args',
      message: 'Path to proposed arguments JSON (optional)',
      validate: (value: string) => value.trim() === '' || validateNonEmpty(value),
    },
  ]);

  const args = [answers.spec, '--function', answers.function];
  if (answers.args.trim()) args.push('--args', answers.args.trim());

  return {
    command: 'soroban-validate',
    args,
    summary: `stellar-api-inspector soroban-validate ${answers.spec} --function ${answers.function}`,
  };
}

async function collectTrustlineExposureCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    accountId: string;
    horizon: string;
    valuations: string;
    valuationCurrency: string;
  }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'valuations',
      message: 'Optional path to a valuation dataset JSON',
      validate: (value: string) => value.trim() === '' || validateNonEmpty(value),
    },
    {
      type: 'input',
      name: 'valuationCurrency',
      message: 'Optional valuation currency (required with a valuation dataset)',
      validate: (value: string) => value.trim() === '' || validateNonEmpty(value),
    },
  ]);

  const args = [answers.accountId, '--horizon', answers.horizon];
  if (answers.valuations.trim()) args.push('--valuations', answers.valuations.trim());
  if (answers.valuationCurrency.trim()) {
    args.push('--valuation-currency', answers.valuationCurrency.trim());
  }

  return {
    command: 'trustline-exposure',
    args,
    summary: `stellar-api-inspector trustline-exposure ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectFederationValidateCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    response: string;
    query: string;
    federation: string;
  }>([
    {
      type: 'input',
      name: 'response',
      message: 'Path to a saved federation response JSON',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'query',
      message: 'Optional federation lookup query (e.g. user*example.com)',
      validate: (value: string) => value.trim() === '' || validateNonEmpty(value),
    },
    {
      type: 'input',
      name: 'federation',
      message: 'Optional federation endpoint URL for a live lookup',
      validate: (value: string) => value.trim() === '' || validateUrl(value),
    },
  ]);

  const args = [answers.response];
  if (answers.query.trim()) args.push('--query', answers.query.trim());
  if (answers.federation.trim()) args.push('--federation', answers.federation.trim());

  return {
    command: 'federation-validate',
    args,
    summary: `stellar-api-inspector federation-validate ${answers.response}`,
  };
}
