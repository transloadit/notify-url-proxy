#!/usr/bin/env node

import { parseArgs } from 'node:util';

import TransloaditNotifyUrlProxy, { type ProxySettings } from '../src/index.ts';

function parsePositiveIntOption(
  name: string,
  value: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    console.error(`Invalid ${name}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

const { values } = parseArgs({
  options: {
    notifyUrl: { type: 'string' },
    target: { type: 'string' },
    port: { type: 'string' },
    pollIntervalMs: { type: 'string' },
    maxPollAttempts: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage: notify-url-proxy [options]

Options:
  --notifyUrl <url>          URL to send notifications to
  --target <url>             Transloadit assemblies endpoint to proxy to
  --port <number>            Local listen port
  --pollIntervalMs <number>  Poll interval in milliseconds
  --maxPollAttempts <number> Max number of poll attempts
  -h, --help                 Show this help

Environment fallback:
  TRANSLOADIT_SECRET, TRANSLOADIT_NOTIFY_URL
`);
  process.exit(0);
}

const secret = process.env.TRANSLOADIT_SECRET;
if (!secret) {
  console.error('Missing secret. Set TRANSLOADIT_SECRET.');
  process.exit(1);
}

const settings: Partial<ProxySettings> = {};

if (values.target) {
  settings.target = values.target;
}
if (values.port) {
  settings.port = parsePositiveIntOption('port', values.port, 65_535);
}
if (values.pollIntervalMs) {
  settings.pollIntervalMs = parsePositiveIntOption('pollIntervalMs', values.pollIntervalMs);
}
if (values.maxPollAttempts) {
  settings.maxPollAttempts = parsePositiveIntOption('maxPollAttempts', values.maxPollAttempts);
}

const proxy = new TransloaditNotifyUrlProxy(
  secret,
  values.notifyUrl ?? process.env.TRANSLOADIT_NOTIFY_URL,
);
proxy.run(settings);

const close = () => {
  proxy.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);
