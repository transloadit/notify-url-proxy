#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { SevLogger } from '@transloadit/sev-logger'
import TransloaditNotifyUrlProxy, { type ProxySettings } from '../src/index.ts'

function parsePositiveIntOption(
  name: string,
  value: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    console.error(`Invalid ${name}: ${value}`)
    process.exit(1)
  }
  return parsed
}

const LOG_LEVEL_BY_NAME = {
  emerg: SevLogger.LEVEL.EMERG,
  alert: SevLogger.LEVEL.ALERT,
  crit: SevLogger.LEVEL.CRIT,
  err: SevLogger.LEVEL.ERR,
  error: SevLogger.LEVEL.ERR,
  warn: SevLogger.LEVEL.WARN,
  warning: SevLogger.LEVEL.WARN,
  notice: SevLogger.LEVEL.NOTICE,
  info: SevLogger.LEVEL.INFO,
  debug: SevLogger.LEVEL.DEBUG,
  trace: SevLogger.LEVEL.TRACE,
} as const

function parseLogLevelOption(value: string): number {
  const normalized = value.trim().toLowerCase()
  const parsedNumeric = Number.parseInt(normalized, 10)

  if (
    Number.isInteger(parsedNumeric) &&
    parsedNumeric >= SevLogger.LEVEL.EMERG &&
    parsedNumeric <= SevLogger.LEVEL.TRACE
  ) {
    return parsedNumeric
  }

  const parsedNamed = LOG_LEVEL_BY_NAME[normalized as keyof typeof LOG_LEVEL_BY_NAME]
  if (typeof parsedNamed === 'number') {
    return parsedNamed
  }

  console.error(
    `Invalid log level: ${value}. Use 0-8 or one of ${Object.keys(LOG_LEVEL_BY_NAME).join(', ')}.`,
  )
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    notifyUrl: { type: 'string' },
    target: { type: 'string' },
    port: { type: 'string' },
    pollIntervalMs: { type: 'string' },
    maxPollAttempts: { type: 'string' },
    logLevel: { type: 'string', short: 'l' },
    'log-level': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: notify-url-proxy [options]

Options:
  --notifyUrl <url>          URL to send notifications to
  --target <url>             Transloadit assemblies endpoint to proxy to
  --port <number>            Local listen port
  --pollIntervalMs <number>  Poll interval in milliseconds
  --maxPollAttempts <number> Max number of poll attempts
  -l, --log-level <level>    Log level (0-8 or emerg/alert/crit/err/warn/notice/info/debug/trace)
  -h, --help                 Show this help

Environment fallback:
  TRANSLOADIT_SECRET, TRANSLOADIT_NOTIFY_URL, TRANSLOADIT_LOG_LEVEL
`)
  process.exit(0)
}

const secret = process.env.TRANSLOADIT_SECRET
if (!secret) {
  console.error('Missing secret. Set TRANSLOADIT_SECRET.')
  process.exit(1)
}

const settings: Partial<ProxySettings> = {}

if (values.target) {
  settings.target = values.target
}
if (values.port) {
  settings.port = parsePositiveIntOption('port', values.port, 65_535)
}
if (values.pollIntervalMs) {
  settings.pollIntervalMs = parsePositiveIntOption('pollIntervalMs', values.pollIntervalMs)
}
if (values.maxPollAttempts) {
  settings.maxPollAttempts = parsePositiveIntOption('maxPollAttempts', values.maxPollAttempts)
}

const rawLogLevel = values['log-level'] ?? values.logLevel ?? process.env.TRANSLOADIT_LOG_LEVEL
const logLevel = rawLogLevel ? parseLogLevelOption(rawLogLevel) : undefined
const loggerOptions = typeof logLevel === 'number' ? { logLevel } : {}

const proxy = new TransloaditNotifyUrlProxy(
  secret,
  values.notifyUrl ?? process.env.TRANSLOADIT_NOTIFY_URL,
  loggerOptions,
)
proxy.run(settings)

const close = () => {
  proxy.close()
  process.exit(0)
}

process.on('SIGINT', close)
process.on('SIGTERM', close)
