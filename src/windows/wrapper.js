#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } = require('fs');
const { join, basename } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const clawgodDir = join(homedir(), '.clawgod');

// Note: drift detection removed — see install.sh wrapper for full notes.
// `versions/` either doesn't exist (Windows) or doesn't grow on healthy
// clawgod installs (we patch out `claude update`), so the check could only
// retract a fresh install.ps1 / install.sh upgrade. `claude update` →
// install.sh redirect is the single source of truth for version upgrades.

// One-time migration: earlier wrapper versions set CLAUDE_CONFIG_DIR=~/.clawgod,
// which made Claude Code read/write ~/.clawgod/.claude.json instead of the
// native ~/.claude.json (the file holding MCP config, project history, session
// index). Move it back transparently on first run after upgrade.
const nativeClaudeJson = join(homedir(), '.claude.json');
const strayClaudeJson = join(clawgodDir, '.claude.json');
if (existsSync(strayClaudeJson) && !existsSync(nativeClaudeJson)) {
  try { renameSync(strayClaudeJson, nativeClaudeJson); } catch {}
}

const providerDir = clawgodDir;
const configFile = join(providerDir, 'provider.json');

const defaultConfig = {
  apiKey: '',
  baseURL: 'https://api.anthropic.com',
  model: '',
  smallModel: '',
  timeoutMs: 3000000,
};

let config = { ...defaultConfig };
if (existsSync(configFile)) {
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    config = { ...defaultConfig, ...raw };
  } catch {}
} else {
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2) + '\n');
}

const hasProviderApiKey = !!config.apiKey;

if (hasProviderApiKey) {
  process.env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.baseURL) process.env.ANTHROPIC_BASE_URL = config.baseURL;
  if (config.model) process.env.ANTHROPIC_MODEL = config.model;
  if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
  if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
    process.env.ANTHROPIC_AUTH_TOKEN ??= config.apiKey;
  }
} else if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
  process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
}

// Third-party Anthropic-compatible proxies (DeepSeek / OneAPI / Bedrock /
// vLLM / etc.) don't share Anthropic's server-side handling of
// x-anthropic-billing-header. That header carries a per-request `cch` field
// which Anthropic's own server excludes from prompt-cache key calculation
// (via cacheScope:null), but third-party proxies fold into the prefix hash —
// so the cached prefix changes every request and cache hit rate drops to
// zero. Auto-disable the header whenever baseURL points away from Anthropic.
// Users can force re-enable with CLAUDE_CODE_ATTRIBUTION_HEADER=1 if needed.
if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER ??= '0';
}

if (config.timeoutMs) {
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
}
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
process.env.USE_BUILTIN_RIPGREP ??= '1';

const featuresFile = join(providerDir, 'features.json');
if (!process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

// Monkey-patch process.execPath: Anthropic's CLI uses process.execPath to
// locate the native binary for shell wrappers (find→bfs, grep→ugrep, rg) and
// subprocess spawning. Under Bun, process.execPath returns the Bun runtime
// path, not the Claude native binary. The launcher script sets
// CLAUDE_CODE_EXECPATH to claude.orig (the real binary) before exec'ing
// Bun, so we use that as the source of truth.  See issue #100.
const _realExecPath = process.env.CLAUDE_CODE_EXECPATH || process.execPath;
if (_realExecPath !== process.execPath) {
  Object.defineProperty(process, 'execPath', {
    value: _realExecPath,
    configurable: true,
  });
}

require('./cli.original.cjs');