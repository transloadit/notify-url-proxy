#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { SevLogger } from '@transloadit/sev-logger'
import TransloaditNotifyUrlProxy, { type ProxySettings } from '../src/index.ts'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

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

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parsePositiveIntOption(
  name: string,
  value: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    fail(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function parsePositiveFloatOption(
  name: string,
  value: string,
  min = Number.MIN_VALUE,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    fail(`Invalid ${name}: ${value}`)
  }
  return parsed
}

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

  fail(
    `Invalid log level: ${value}. Use 0-8 or one of ${Object.keys(LOG_LEVEL_BY_NAME).join(', ')}.`,
  )
}

function parseHttpUrlOption(name: string, value: string): URL {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    fail(`Invalid ${name}: ${value}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail(`Invalid ${name} protocol: ${parsed.protocol}. Use http or https.`)
  }
  if (!parsed.hostname) {
    fail(`Invalid ${name}: missing hostname.`)
  }

  return parsed
}

function parseNotifyUrlOption(value: string): string {
  const parsed = parseHttpUrlOption('notifyUrl', value)
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    fail('Insecure notifyUrl over HTTP is only allowed for localhost/127.0.0.1/::1.')
  }

  return parsed.toString()
}

const { values } = parseArgs({
  options: {
    notifyUrl: { type: 'string' },
    target: { type: 'string' },
    port: { type: 'string' },
    pollIntervalMs: { type: 'string' },
    pollMaxIntervalMs: { type: 'string' },
    pollBackoffFactor: { type: 'string' },
    maxPollAttempts: { type: 'string' },
    maxInFlightPolls: { type: 'string' },
    notifyOnTerminalError: { type: 'boolean' },
    'notify-on-terminal-error': { type: 'boolean' },
    logLevel: { type: 'string', short: 'l' },
    'log-level': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: notify-url-proxy [options]

Options:
  --notifyUrl <url>             URL to send notifications to (http://localhost allowed, otherwise https)
  --target <url>                Transloadit endpoint base URL
  --port <number>               Local listen port
  --pollIntervalMs <number>     Base poll interval in milliseconds
  --pollMaxIntervalMs <number>  Max poll backoff interval in milliseconds
  --pollBackoffFactor <number>  Poll backoff factor (>= 1)
  --maxPollAttempts <number>    Max number of poll attempts
  --maxInFlightPolls <number>   Max number of active assembly pollers
  --notifyOnTerminalError       Send notify payload when terminal error is reached
  -l, --log-level <level>       Log level (0-8 or emerg/alert/crit/err/warn/notice/info/debug/trace)
  -h, --help                    Show this help

Environment fallback:
  TRANSLOADIT_SECRET, TRANSLOADIT_NOTIFY_URL, TRANSLOADIT_LOG_LEVEL
`)
  process.exit(0)
}

const secret = process.env.TRANSLOADIT_SECRET
if (!secret) {
  fail('Missing secret. Set TRANSLOADIT_SECRET.')
}

const settings: Partial<ProxySettings> = {}

if (values.target) {
  settings.target = parseHttpUrlOption('target', values.target).toString()
}
if (values.port) {
  settings.port = parsePositiveIntOption('port', values.port, 65_535)
}
if (values.pollIntervalMs) {
  settings.pollIntervalMs = parsePositiveIntOption('pollIntervalMs', values.pollIntervalMs)
}
if (values.pollMaxIntervalMs) {
  settings.pollMaxIntervalMs = parsePositiveIntOption('pollMaxIntervalMs', values.pollMaxIntervalMs)
}
if (values.pollBackoffFactor) {
  settings.pollBackoffFactor = parsePositiveFloatOption(
    'pollBackoffFactor',
    values.pollBackoffFactor,
    1,
  )
}
if (values.maxPollAttempts) {
  settings.maxPollAttempts = parsePositiveIntOption('maxPollAttempts', values.maxPollAttempts)
}
if (values.maxInFlightPolls) {
  settings.maxInFlightPolls = parsePositiveIntOption('maxInFlightPolls', values.maxInFlightPolls)
}

const notifyOnTerminalError =
  values.notifyOnTerminalError === true || values['notify-on-terminal-error'] === true
if (notifyOnTerminalError) {
  settings.notifyOnTerminalError = true
}

const rawLogLevel = values['log-level'] ?? values.logLevel ?? process.env.TRANSLOADIT_LOG_LEVEL
const logLevel = rawLogLevel ? parseLogLevelOption(rawLogLevel) : undefined
const loggerOptions = typeof logLevel === 'number' ? { logLevel } : {}

const notifyUrlRaw = values.notifyUrl ?? process.env.TRANSLOADIT_NOTIFY_URL
const notifyUrl = notifyUrlRaw ? parseNotifyUrlOption(notifyUrlRaw) : undefined

const proxy = new TransloaditNotifyUrlProxy(secret, notifyUrl, loggerOptions)
proxy.run(settings)

const close = () => {
  proxy.close()
  process.exit(0)
}

process.on('SIGINT', close)
process.on('SIGTERM', close)
