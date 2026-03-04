import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { SevLogger } from '@transloadit/sev-logger'
import { signParamsSync } from '@transloadit/utils/node'
import {
  type AssemblyStatus,
  type assemblyStatusOkCodeSchema,
  assemblyStatusSchema,
  getAssemblyStage,
  getError,
  getOk,
  isAssemblyBusy,
  isAssemblyOkStatus,
  isAssemblyTerminalError,
  isAssemblyTerminalOk,
  parseAssemblyUrls,
} from '@transloadit/zod/v4'
import pRetry, { AbortError, type RetryContext } from 'p-retry'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface ProxySettings {
  target: string
  port: number
  pollIntervalMs: number
  pollMaxIntervalMs: number
  pollBackoffFactor: number
  maxPollAttempts: number
  maxInFlightPolls: number
  notifyOnTerminalError: boolean
}

export interface ProxyLoggerOptions {
  logger?: SevLogger
  logLevel?: number
}

type KnownAssemblyState = (typeof assemblyStatusOkCodeSchema.options)[number]

export type AssemblyResponse = AssemblyStatus

const DEFAULT_SETTINGS: ProxySettings = {
  target: 'https://api2.transloadit.com',
  port: 8888,
  pollIntervalMs: 2_000,
  pollMaxIntervalMs: 30_000,
  pollBackoffFactor: 2,
  maxPollAttempts: 10,
  maxInFlightPolls: 4,
  notifyOnTerminalError: false,
}

const DEFAULT_LOG_LEVEL = SevLogger.LEVEL.INFO

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function supportsBody(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase()
  return normalized !== 'GET' && normalized !== 'HEAD'
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }

  return error instanceof Error && error.name === 'AbortError'
}

function getHeaderValues(name: string, headers: Headers): string[] {
  const normalized = name.toLowerCase()
  if (normalized !== 'set-cookie') {
    return []
  }

  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie()
  }

  const fallback = headers.get('set-cookie')
  return fallback ? [fallback] : []
}

export function extractAssemblyUrl(body: string): string | null {
  try {
    const payload = JSON.parse(body) as unknown
    return parseAssemblyUrls(payload).assemblyUrl
  } catch {
    return null
  }
}

export function getAssemblyState(payload: unknown): KnownAssemblyState {
  if (!isRecord(payload)) {
    throw new Error('No ok field found in Assembly response.')
  }

  const ok = typeof payload.ok === 'string' ? payload.ok : undefined
  if (!isAssemblyOkStatus(ok)) {
    throw new Error(`Unknown Assembly state found: ${String(payload.ok)}`)
  }

  return ok
}

export function getSignature(secret: string, toSign: string): string {
  return signParamsSync(toSign, secret, 'sha384')
}

export function parseAssemblyResponse(payload: unknown): AssemblyResponse {
  const parsed = assemblyStatusSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('Invalid assembly response payload.')
  }

  return parsed.data
}

export default class TransloaditNotifyUrlProxy {
  private server: Server | null = null
  private isClosing = false

  private readonly secret: string
  private readonly notifyUrl: string
  private readonly logger: SevLogger
  private readonly defaults: ProxySettings
  private settings: ProxySettings

  private readonly pendingAssemblyUrls = new Set<string>()
  private readonly activePolls = new Map<string, Promise<void>>()
  private readonly pollControllers = new Map<string, AbortController>()
  private activePollCount = 0

  constructor(
    secret: string,
    notifyUrl = 'http://127.0.0.1:3000/transloadit',
    loggerOptions: ProxyLoggerOptions = {},
  ) {
    this.secret = secret || ''
    this.notifyUrl = notifyUrl

    this.defaults = { ...DEFAULT_SETTINGS }
    this.settings = { ...DEFAULT_SETTINGS }
    this.logger =
      loggerOptions.logger ??
      new SevLogger({
        breadcrumbs: ['notify-url-proxy'],
        level: loggerOptions.logLevel ?? DEFAULT_LOG_LEVEL,
      })

    if (loggerOptions.logger && typeof loggerOptions.logLevel === 'number') {
      this.logger.update({ level: loggerOptions.logLevel })
    }
  }

  run(opts: Partial<ProxySettings> = {}): void {
    if (this.server !== null) {
      this.close()
    }

    this.isClosing = false
    this.settings = { ...this.defaults, ...opts }
    this.createServer()
  }

  close(): void {
    this.isClosing = true

    this.server?.close()
    this.server = null

    for (const [assemblyUrl, controller] of this.pollControllers) {
      controller.abort(new Error(`Proxy closed while polling ${assemblyUrl}`))
    }

    this.pollControllers.clear()
    this.pendingAssemblyUrls.clear()
    this.activePolls.clear()
    this.activePollCount = 0
  }

  private createServer(): void {
    this.server = createServer((request, response) => {
      void this.handleForward(request, response)
    })

    this.server.listen(this.settings.port)

    this.logger.notice(
      `Listening on http://localhost:${this.settings.port}, forwarding to ${this.settings.target}, notifying ${this.notifyUrl}`,
    )
  }

  private async handleForward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const proxyController = new AbortController()
    request.on('aborted', () => {
      proxyController.abort(new Error('Client aborted request'))
    })

    try {
      const targetUrl = this.resolveTargetUrl(request.url)
      const requestBody = supportsBody(request.method)
        ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
        : undefined
      const fetchInit: RequestInit = {
        method: request.method ?? 'GET',
        headers: this.createForwardHeaders(request),
        redirect: 'manual',
        signal: proxyController.signal,
      }
      if (requestBody) {
        fetchInit.body = requestBody
        ;(fetchInit as RequestInit & { duplex: 'half' }).duplex = 'half'
      }

      const upstreamResponse = await fetch(targetUrl, fetchInit)

      const body = Buffer.from(await upstreamResponse.arrayBuffer())
      this.writeForwardedResponse(response, upstreamResponse, body)
      this.maybePollAssemblyFromBody(body)
    } catch (error) {
      if (isAbortLikeError(error)) {
        return
      }

      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      if (!response.writableEnded) {
        response.end('Proxy error')
      }

      this.logger.err(`Proxy error: ${toErrorMessage(error)}`)
    }
  }

  private resolveTargetUrl(requestUrl: string | undefined): string {
    const path = requestUrl ?? '/'
    if (/^https?:\/\//i.test(path)) {
      throw new Error(`Absolute request URL is not supported: ${path}`)
    }

    return new URL(path, this.settings.target).toString()
  }

  private createForwardHeaders(request: IncomingMessage): Headers {
    const headers = new Headers()

    for (const [name, value] of Object.entries(request.headers)) {
      const headerName = name.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(headerName) || headerName === 'host') {
        continue
      }
      if (value === undefined) {
        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item)
        }
      } else {
        headers.set(name, value)
      }
    }

    if (request.socket.remoteAddress) {
      headers.set('x-forwarded-for', request.socket.remoteAddress)
    }
    if (typeof request.headers.host === 'string') {
      headers.set('x-forwarded-host', request.headers.host)
    }

    return headers
  }

  private writeForwardedResponse(
    response: ServerResponse,
    upstreamResponse: Response,
    body: Buffer,
  ): void {
    response.statusCode = upstreamResponse.status
    response.statusMessage = upstreamResponse.statusText

    for (const [name, value] of upstreamResponse.headers) {
      const headerName = name.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(headerName) || headerName === 'set-cookie') {
        continue
      }
      response.setHeader(name, value)
    }

    const setCookies = getHeaderValues('set-cookie', upstreamResponse.headers)
    if (setCookies.length > 0) {
      response.setHeader('set-cookie', setCookies)
    }

    response.end(body)
  }

  private maybePollAssemblyFromBody(body: Buffer): void {
    const assemblyUrl = extractAssemblyUrl(body.toString('utf-8'))
    if (!assemblyUrl) {
      return
    }

    this.enqueueAssemblyPoll(assemblyUrl)
  }

  private enqueueAssemblyPoll(assemblyUrl: string): void {
    if (this.isClosing) {
      return
    }

    if (this.pendingAssemblyUrls.has(assemblyUrl) || this.activePolls.has(assemblyUrl)) {
      this.logger.debug(`Skipping duplicate poll registration for ${assemblyUrl}`)
      return
    }

    this.pendingAssemblyUrls.add(assemblyUrl)
    this.logger.info(`Queued poll for ${assemblyUrl}`)
    this.drainPollQueue()
  }

  private drainPollQueue(): void {
    if (this.isClosing) {
      return
    }

    while (this.activePollCount < this.settings.maxInFlightPolls) {
      const next = this.pendingAssemblyUrls.values().next().value as string | undefined
      if (!next) {
        break
      }

      this.pendingAssemblyUrls.delete(next)

      const controller = new AbortController()
      this.pollControllers.set(next, controller)
      this.activePollCount += 1

      const pollPromise = this.pollAssembly(next, controller.signal).finally(() => {
        if (this.activePolls.get(next) !== pollPromise) {
          return
        }

        this.activePolls.delete(next)
        this.pollControllers.delete(next)
        this.activePollCount = Math.max(0, this.activePollCount - 1)

        if (!this.isClosing) {
          this.drainPollQueue()
        }
      })

      this.activePolls.set(next, pollPromise)
    }
  }

  private async pollAssembly(assemblyUrl: string, signal: AbortSignal): Promise<void> {
    const retries = Math.max(this.settings.maxPollAttempts - 1, 0)

    try {
      const response = await pRetry(() => this.checkAssembly(assemblyUrl, signal), {
        retries,
        minTimeout: this.settings.pollIntervalMs,
        maxTimeout: this.settings.pollMaxIntervalMs,
        factor: this.settings.pollBackoffFactor,
        randomize: true,
        signal,
        onFailedAttempt: (retryContext: RetryContext) => {
          if (retryContext.retriesLeft <= 0) {
            return
          }

          this.logger.warn(
            `Attempt ${retryContext.attemptNumber}/${this.settings.maxPollAttempts} failed for ${assemblyUrl}: ${retryContext.error.message}`,
          )
        },
      })

      await this.notify(response, signal)
    } catch (error) {
      if (error instanceof AbortError) {
        this.logger.notice(error.message)
        return
      }

      if (signal.aborted || this.isClosing || isAbortLikeError(error)) {
        this.logger.debug(`Polling cancelled for ${assemblyUrl}`)
        return
      }

      this.logger.err(
        `No attempts left, giving up on checking assemblyUrl: ${assemblyUrl} (${toErrorMessage(error)})`,
      )
    }
  }

  private async checkAssembly(assemblyUrl: string, signal: AbortSignal): Promise<AssemblyResponse> {
    const response = await fetch(assemblyUrl, { signal })
    if (!response.ok) {
      throw new Error(`Assembly poll returned HTTP ${response.status}`)
    }

    const assembly = parseAssemblyResponse((await response.json()) as unknown)

    if (isAssemblyTerminalError(assembly)) {
      const errorCode = getError(assembly) ?? 'UNKNOWN_ERROR'
      if (this.settings.notifyOnTerminalError) {
        this.logger.notice(
          `${assemblyUrl} reached terminal error state ${errorCode}; notifying because notifyOnTerminalError=true.`,
        )
        return assembly
      }

      throw new AbortError(`${assemblyUrl} reached terminal error state ${errorCode}.`)
    }

    if (isAssemblyTerminalOk(assembly)) {
      this.logger.info(`${assemblyUrl} reached terminal state ${getOk(assembly)}.`)
      return assembly
    }

    if (isAssemblyBusy(assembly)) {
      const stage = getAssemblyStage(assembly)
      if (stage === 'uploading') {
        throw new Error(`${assemblyUrl} is still uploading.`)
      }
      if (stage === 'processing') {
        throw new Error(`${assemblyUrl} is still executing.`)
      }
      throw new Error(`${assemblyUrl} is still replaying.`)
    }

    throw new Error(`${assemblyUrl} returned a non-terminal assembly state.`)
  }

  private async notify(response: AssemblyResponse, signal: AbortSignal): Promise<void> {
    const transloadit = JSON.stringify(response)
    const signature = getSignature(this.secret, transloadit)

    const notifyResponse = await fetch(this.notifyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams({
        transloadit,
        signature,
      }),
      signal,
    })

    if (!notifyResponse.ok) {
      throw new Error(`Notify URL returned HTTP ${notifyResponse.status}`)
    }

    this.logger.notice(`Notify payload sent to ${this.notifyUrl}`)
  }
}
