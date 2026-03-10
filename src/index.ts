#!/usr/bin/env node
/* eslint-disable no-console */

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { Type, type Static } from '@sinclair/typebox';

type Config = {
  provider: string;
  model: string;
  apiKey: string;
  logRetentionLines: number;
};

type MemoryEntry = {
  name: string;
  description: string;
  command: string;
  savedAt: string;
};

type MessageLike = {
  role: string;
  content: unknown;
};

type TextPart = {
  type: 'text';
  text: string;
};

type ToolInvocationLog = {
  kind: 'toolCall' | 'toolResult';
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
  resultText?: string;
};

const CONFIG_DIR = join(homedir(), '.config', 'nlsh');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const MEMORY_FILE = join(CONFIG_DIR, 'memory.json');
const LLM_LOG_FILE = join(CONFIG_DIR, 'llm.log');
const LLM_LOG_ROTATED_FILE = join(CONFIG_DIR, 'llm.log.1');
const BASH_PROFILE_FILE = join(homedir(), '.bash_profile');

const DEFAULT_PROVIDER = 'google';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const DEFAULT_LOG_RETENTION_LINES = 10_000;
const TOOL_OUTPUT_MAX_BYTES = 48 * 1024;
const TOOL_RESULT_LOG_MAX_BYTES = 2 * 1024;
const READ_TOOL_DEFAULT_LIMIT = 300;
const SHELL_ONLY_PROMPT =
  'You are a shell command assistant. You may only use readonly tools. Return ONLY a single shell command. No explanation. No markdown.';

const BASH_SNIPPET_START = '# >>> nlsh >>>';
const BASH_SNIPPET_END = '# <<< nlsh <<<';

const BASH_SNIPPET = `${BASH_SNIPPET_START}
# Cleanup legacy DEBUG trap from older nlsh installs.
if [[ "$(trap -p DEBUG 2>/dev/null)" == *"_nlsh_debug_trap"* ]]; then
  trap - DEBUG
fi
unset -f _nlsh_debug_trap 2>/dev/null || true

//() {
  if [[ -n "${'$'}{NLSH_ACTIVE:-}" ]]; then
    return 0
  fi

  export NLSH_ACTIVE=1

  if [[ "${'$'}#" -eq 0 ]] || [[ "${'$'}1" == "save" ]]; then
    local last_cmd
    last_cmd=$(HISTTIMEFORMAT= history 2 | head -n 1 | sed 's/^ *[0-9][0-9]* *//')
    nlsh save "${'$'}last_cmd"
    local status=${'$'}?
    unset NLSH_ACTIVE
    return ${'$'}status
  fi

  nlsh ask "${'$'}*"
  local status=${'$'}?
  unset NLSH_ACTIVE
  return ${'$'}status
}

//save() {
  // save
}
${BASH_SNIPPET_END}`;

const readSchema = Type.Object({
  path: Type.String({
    description: 'Path to the file to read (relative or absolute)'
  }),
  offset: Type.Optional(
    Type.Number({
      description: 'Line number to start reading from (1-indexed)'
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of lines to read'
    })
  )
});

type ReadInput = Static<typeof readSchema>;

const bashSchema = Type.Object({
  command: Type.String({
    description: 'Readonly shell command to execute.'
  }),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 30,
      description: 'Optional timeout in seconds (default: 10)'
    })
  )
});

type BashInput = Static<typeof bashSchema>;

const BLOCKED_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'chmod',
  'chown',
  'touch',
  'mkdir',
  'rmdir',
  'ln',
  'truncate',
  'dd'
]);

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

function normalizeConfig(parsed: Partial<Config>): Config {
  if (!parsed.provider || !parsed.apiKey) {
    throw new Error('config.json is missing required fields');
  }

  const retention = Number(parsed.logRetentionLines);

  return {
    provider: parsed.provider,
    model: parsed.model || DEFAULT_MODEL,
    apiKey: parsed.apiKey,
    logRetentionLines:
      Number.isFinite(retention) && retention > 0
        ? Math.floor(retention)
        : DEFAULT_LOG_RETENTION_LINES
  };
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return normalizeConfig(parsed);
  } catch (error) {
    throw new Error('Not logged in. Run: nlsh login', {
      cause: error as Error
    });
  }
}

async function loadMemory(): Promise<MemoryEntry[]> {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveMemory(entries: MemoryEntry[]) {
  await ensureConfigDir();
  await writeFile(MEMORY_FILE, JSON.stringify(entries, null, 2));
}

function truncateToolOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return text;
  }
  return text.slice(0, maxBytes);
}

function createReadTool(cwd: string) {
  return {
    name: 'read',
    label: 'read',
    description:
      'Read the contents of a text file. Output is truncated to 300 lines or 48KB. Use offset/limit for large files.',
    parameters: readSchema,
    execute: async (
      _toolCallId: string,
      { path, offset, limit }: ReadInput
    ) => {
      const fullPath = path.startsWith('/') ? path : join(cwd, path);
      const raw = await readFile(fullPath, 'utf-8');
      const lines = raw.split('\n');
      const startLine = Math.max(0, (offset ?? 1) - 1);

      if (startLine >= lines.length) {
        throw new Error(
          `Offset ${offset} is beyond EOF (${lines.length} lines).`
        );
      }

      const maxLines = limit ?? READ_TOOL_DEFAULT_LIMIT;
      const selected = lines.slice(startLine, startLine + maxLines).join('\n');
      const text = truncateToolOutput(selected, TOOL_OUTPUT_MAX_BYTES);

      const hasMore = startLine + maxLines < lines.length;
      const nextLine = startLine + maxLines + 1;
      const suffix = hasMore
        ? `\n\n[More available. Use offset=${nextLine}]`
        : '';

      const content: TextPart[] = [{ type: 'text', text: `${text}${suffix}` }];
      return { content, details: undefined };
    }
  };
}

function isReadonlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (
    /[>]/.test(trimmed) ||
    /;|&&|\|\||`|\n/.test(trimmed) ||
    /\|\s*tee\b/.test(trimmed) ||
    /\bsed\s+-i\b/.test(trimmed)
  ) {
    return false;
  }

  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase();
  return !BLOCKED_COMMANDS.has(firstToken);
}

function createBashTool(cwd: string) {
  return {
    name: 'bash',
    label: 'bash',
    description:
      'Run a readonly shell command. Returns stdout/stderr and exit code. No file-modifying commands.',
    parameters: bashSchema,
    execute: async (
      _toolCallId: string,
      { command, timeoutSeconds }: BashInput
    ) => {
      if (!isReadonlyCommand(command)) {
        throw new Error(
          'Command rejected: only readonly commands are allowed.'
        );
      }

      const { spawn } = await import('node:child_process');
      const timeoutMs = (timeoutSeconds ?? 10) * 1000;

      const output = await new Promise<{
        stdoutText: string;
        stderrText: string;
        exitCode: number;
        timedOut: boolean;
      }>((resolve) => {
        const child = spawn('bash', ['-lc', command], { cwd });
        let stdoutText = '';
        let stderrText = '';
        let timedOut = false;

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutText += chunk.toString('utf-8');
        });

        child.stderr.on('data', (chunk: Buffer) => {
          stderrText += chunk.toString('utf-8');
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs);

        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({
            stdoutText,
            stderrText,
            exitCode: code ?? 1,
            timedOut
          });
        });
      });

      const text = truncateToolOutput(
        [
          `exitCode: ${output.exitCode}`,
          output.timedOut ? 'timedOut: true' : 'timedOut: false',
          output.stdoutText
            ? `stdout:\n${output.stdoutText}`
            : 'stdout: (empty)',
          output.stderrText
            ? `stderr:\n${output.stderrText}`
            : 'stderr: (empty)'
        ].join('\n\n'),
        TOOL_OUTPUT_MAX_BYTES
      );

      const content: TextPart[] = [{ type: 'text', text }];
      return { content, details: undefined };
    }
  };
}

async function rotateLlmLogIfNeeded(retentionLines: number) {
  const existing = await readFileIfExists(LLM_LOG_FILE);
  if (existing === null) {
    return;
  }

  const lineCount = existing
    .split('\n')
    .filter((line) => line.trim().length > 0).length;

  if (lineCount < retentionLines) {
    return;
  }

  await rm(LLM_LOG_ROTATED_FILE, { force: true });
  await rename(LLM_LOG_FILE, LLM_LOG_ROTATED_FILE);
}

async function logLlmInteraction(
  entry: Record<string, unknown>,
  config: Config
) {
  await ensureConfigDir();
  await rotateLlmLogIfNeeded(config.logRetentionLines);
  await appendFile(LLM_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function isTextPart(value: unknown): value is TextPart {
  const maybePart = value as Record<string, unknown> | null;
  return (
    !!maybePart &&
    maybePart.type === 'text' &&
    typeof maybePart.text === 'string'
  );
}

function joinTextParts(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function extractToolInvocations(agent: Agent): ToolInvocationLog[] {
  const messages = agent.state.messages as unknown[];
  const invocations: ToolInvocationLog[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const msg = message as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';

    if (role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }

        const toolCall = part as Record<string, unknown>;
        if (toolCall.type !== 'toolCall') {
          continue;
        }

        invocations.push({
          kind: 'toolCall',
          toolCallId: typeof toolCall.id === 'string' ? toolCall.id : undefined,
          name: typeof toolCall.name === 'string' ? toolCall.name : undefined,
          arguments: toolCall.arguments
        });
      }
      continue;
    }

    if (role === 'toolResult') {
      const resultText = joinTextParts(msg.content);

      invocations.push({
        kind: 'toolResult',
        toolCallId:
          typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
        resultText: resultText
          ? truncateToolOutput(resultText, TOOL_RESULT_LOG_MAX_BYTES)
          : undefined
      });
    }
  }

  return invocations;
}

function extractAssistantText(agent: Agent): string {
  const messages = agent.state.messages as unknown[];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    if (message.role !== 'assistant') {
      continue;
    }

    if (typeof message.content === 'string') {
      return message.content.trim();
    }

    const text = joinTextParts(message.content);

    if (text) {
      return text;
    }
  }

  throw new Error('No assistant response available.');
}

function cleanCommand(raw: string): string {
  const text = raw
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/, '')
    .trim();

  return (
    text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() || ''
  );
}

function buildAskPrompt(userIntent: string, memory: MemoryEntry[]): string {
  return [
    'Tooling policy: only readonly tools may be used.',
    `User intent: ${userIntent.trim()}`,
    `cwd: ${process.cwd()}`,
    `os: ${process.platform}`,
    `memory: ${JSON.stringify(memory)}`
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildLlmLogEntry(
  config: Config,
  prompt: string,
  toolInvocations: ToolInvocationLog[],
  responseOrError: { response?: string; error?: string }
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    provider: config.provider,
    model: config.model,
    prompt,
    ...responseOrError,
    toolInvocations
  };
}

async function askLlm(userIntent: string): Promise<string> {
  const config = await loadConfig();
  const memory = await loadMemory();
  const cwd = process.cwd();
  const prompt = buildAskPrompt(userIntent, memory);

  const agent = new Agent({
    initialState: {
      model: getModel(config.provider as never, config.model),
      thinkingLevel: 'off',
      tools: [createReadTool(cwd), createBashTool(cwd)],
      systemPrompt: SHELL_ONLY_PROMPT
    },
    getApiKey: async (provider: string) => {
      if (provider !== config.provider) {
        throw new Error(`Missing API key for provider: ${provider}`);
      }
      return config.apiKey;
    }
  });

  try {
    await agent.prompt(prompt);
    const response = cleanCommand(extractAssistantText(agent));
    const toolInvocations = extractToolInvocations(agent);

    await logLlmInteraction(
      buildLlmLogEntry(config, prompt, toolInvocations, { response }),
      config
    );

    return response;
  } catch (error) {
    const toolInvocations = extractToolInvocations(agent);

    await logLlmInteraction(
      buildLlmLogEntry(config, prompt, toolInvocations, {
        error: errorMessage(error)
      }),
      config
    );
    throw error;
  }
}

async function confirmAndRun(command: string): Promise<number> {
  console.log(command);

  let shouldRun = false;

  if (stdin.isTTY && stdout.isTTY) {
    stdout.write('Press Enter to run, any other key to discard: ');
    emitKeypressEvents(stdin);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    try {
      shouldRun = await new Promise<boolean>((resolve) => {
        const onKeypress = (_str: string, key: { name?: string }) => {
          stdin.off('keypress', onKeypress);
          stdout.write('\n');
          resolve(key.name === 'return' || key.name === 'enter');
        };

        stdin.on('keypress', onKeypress);
      });
    } finally {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    }
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      'Press Enter to run, any other input to discard: '
    );
    rl.close();
    shouldRun = answer.length === 0;
  }

  if (!shouldRun) {
    return 0;
  }

  const { spawn } = await import('node:child_process');
  const child = spawn('bash', ['-lc', command], { stdio: 'inherit' });

  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function findSnippetBounds(text: string): { start: number; end: number } {
  return {
    start: text.indexOf(BASH_SNIPPET_START),
    end: text.indexOf(BASH_SNIPPET_END)
  };
}

function normalizeProfileContent(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function install() {
  const existing = (await readFileIfExists(BASH_PROFILE_FILE)) ?? '';
  const { start, end } = findSnippetBounds(existing);

  if (start !== -1 && end !== -1) {
    const updated = `${existing.slice(0, start)}${BASH_SNIPPET}\n${existing.slice(
      end + BASH_SNIPPET_END.length
    )}`;

    await writeFile(BASH_PROFILE_FILE, normalizeProfileContent(updated));
    console.log('Updated nlsh in ~/.bash_profile');
    console.log('Run: source ~/.bash_profile');
    return;
  }

  await writeFile(
    BASH_PROFILE_FILE,
    `${existing.trimEnd()}\n\n${BASH_SNIPPET}\n`
  );
  console.log('Installed nlsh into ~/.bash_profile');
  console.log('Run: source ~/.bash_profile');
}

async function uninstall() {
  const existing = await readFileIfExists(BASH_PROFILE_FILE);
  if (existing === null) {
    console.log('No ~/.bash_profile found. Nothing to uninstall.');
    return;
  }

  const { start, end } = findSnippetBounds(existing);
  if (start === -1 || end === -1) {
    console.log('nlsh is not installed in ~/.bash_profile');
    return;
  }

  const updated = `${existing.slice(0, start)}${existing.slice(
    end + BASH_SNIPPET_END.length
  )}`;

  await writeFile(BASH_PROFILE_FILE, normalizeProfileContent(updated));
  console.log('Removed nlsh from ~/.bash_profile');
}

async function promptValue(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const value = (await rl.question(prompt)).trim();
  rl.close();
  return value;
}

async function login() {
  const providerInput = await promptValue('Provider [google]: ');
  const modelInput = await promptValue(
    'Model [gemini-3.1-flash-lite-preview]: '
  );
  const retentionInput = await promptValue('Log retention lines [10000]: ');
  const apiKey = await promptValue('API key: ');

  if (!apiKey) {
    throw new Error('API key is required.');
  }

  const retention = retentionInput
    ? Number.parseInt(retentionInput, 10)
    : DEFAULT_LOG_RETENTION_LINES;

  if (!Number.isFinite(retention) || retention <= 0) {
    throw new Error('Log retention lines must be a positive integer.');
  }

  const config: Config = {
    provider: providerInput || DEFAULT_PROVIDER,
    model: modelInput || DEFAULT_MODEL,
    apiKey,
    logRetentionLines: retention
  };

  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600
  });
  console.log(`Logged in (${config.provider}/${config.model})`);
}

async function logout() {
  try {
    await rm(CONFIG_FILE);
    console.log('Logged out');
  } catch {
    console.log('Not logged in');
  }
}

async function saveLastCommand(lastCommand: string) {
  if (!lastCommand.trim()) {
    throw new Error('No last command was provided to save.');
  }

  const result = await askLlm(
    [
      'Explain concisely what this shell command does, give it a short name, return JSON {name, description, command}.',
      `shell command: ${lastCommand}`
    ].join('\n')
  );

  let parsed: { name: string; description: string; command: string };
  try {
    parsed = JSON.parse(result);
  } catch (error) {
    throw new Error(`Model did not return valid JSON: ${result}`, {
      cause: error as Error
    });
  }

  const memory = await loadMemory();
  memory.push({
    name: parsed.name,
    description: parsed.description,
    command: parsed.command,
    savedAt: new Date().toISOString()
  });

  await saveMemory(memory);
  console.log(`Saved: ${parsed.name}`);
}

async function ask(input: string) {
  const command = await askLlm(input);
  process.exitCode = await confirmAndRun(command);
}

async function runCommand(command: string, args: string[]) {
  const joinedArgs = args.join(' ').trim();

  const handlers: Record<string, () => Promise<void>> = {
    install,
    uninstall,
    login,
    logout,
    ask: () => ask(joinedArgs),
    save: () => saveLastCommand(joinedArgs)
  };

  const handler = handlers[command];
  if (!handler) {
    console.log(`Unknown command: ${command}`);
    process.exitCode = 1;
    return;
  }

  await handler();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.log('Usage: nlsh <install|uninstall|login|logout|ask|save>');
    process.exitCode = 1;
    return;
  }

  await runCommand(command, args);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
