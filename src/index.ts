import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
import httpProxy from 'http-proxy'
import pRetry, { AbortError, type RetryContext } from 'p-retry'

export interface ProxySettings {
  target: string
  port: number
  pollIntervalMs: number
  maxPollAttempts: number
}

export interface ProxyLoggerOptions {
  logger?: SevLogger
  logLevel?: number
}

type KnownAssemblyState = (typeof assemblyStatusOkCodeSchema.options)[number]

export type AssemblyResponse = AssemblyStatus

const DEFAULT_SETTINGS: ProxySettings = {
  target: 'https://api2.transloadit.com/assemblies/',
  port: 8888,
  pollIntervalMs: 2_000,
  maxPollAttempts: 10,
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
  private proxy: httpProxy<IncomingMessage, ServerResponse> | null = null

  private readonly secret: string
  private readonly notifyUrl: string
  private readonly logger: SevLogger
  private readonly defaults: ProxySettings
  private settings: ProxySettings

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
    if (this.server !== null || this.proxy !== null) {
      this.close()
    }

    this.settings = { ...this.defaults, ...opts }

    this.createProxy()
    this.createServer()
  }

  close(): void {
    this.server?.close()
    this.server = null

    this.proxy?.close()
    this.proxy = null
  }

  private createProxy(): void {
    this.proxy = httpProxy.createProxyServer<IncomingMessage, ServerResponse>({
      target: this.settings.target,
      changeOrigin: true,
    })

    this.proxy.on('error', (error, _req, res) => {
      if ('writeHead' in res) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        }
        res.end('Proxy error')
      } else {
        res.end()
      }
      this.logger.err(`Proxy error: ${toErrorMessage(error)}`)
    })

    this.proxy.on('proxyRes', (proxyRes) => {
      void this.handleProxyResponse(proxyRes)
    })
  }

  private createServer(): void {
    if (this.proxy === null) {
      throw new Error('Proxy is not initialized.')
    }

    this.server = createServer((req, res) => {
      this.proxy?.web(req, res)
    })

    this.server.listen(this.settings.port)

    this.logger.notice(
      `Listening on http://localhost:${this.settings.port}, forwarding to ${this.settings.target}, notifying ${this.notifyUrl}`,
    )
  }

  private async handleProxyResponse(proxyRes: IncomingMessage): Promise<void> {
    const body = await this.readResponseBody(proxyRes)
    const assemblyUrl = extractAssemblyUrl(body)

    if (assemblyUrl === null) {
      return
    }

    this.logger.info(`Received proxy response, polling assemblyUrl: ${assemblyUrl}`)
    await this.pollAssembly(assemblyUrl)
  }

  private async readResponseBody(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []

    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    return Buffer.concat(chunks).toString('utf-8')
  }

  private async pollAssembly(assemblyUrl: string): Promise<void> {
    const retries = Math.max(this.settings.maxPollAttempts - 1, 0)

    try {
      const response = await pRetry(() => this.checkAssembly(assemblyUrl), {
        retries,
        minTimeout: this.settings.pollIntervalMs,
        maxTimeout: this.settings.pollIntervalMs,
        factor: 1,
        randomize: false,
        onFailedAttempt: (retryContext: RetryContext) => {
          if (retryContext.retriesLeft <= 0) {
            return
          }

          this.logger.warn(
            `Attempt ${retryContext.attemptNumber}/${this.settings.maxPollAttempts} failed for ${assemblyUrl}: ${retryContext.error.message}`,
          )
        },
      })

      await this.notify(response)
    } catch (error) {
      if (error instanceof AbortError) {
        this.logger.notice(error.message)
        return
      }

      this.logger.err(
        `No attempts left, giving up on checking assemblyUrl: ${assemblyUrl} (${toErrorMessage(error)})`,
      )
    }
  }

  private async checkAssembly(assemblyUrl: string): Promise<AssemblyResponse> {
    const response = await fetch(assemblyUrl)
    if (!response.ok) {
      throw new Error(`Assembly poll returned HTTP ${response.status}`)
    }

    const assembly = parseAssemblyResponse((await response.json()) as unknown)

    if (isAssemblyTerminalError(assembly)) {
      const errorCode = getError(assembly) ?? 'UNKNOWN_ERROR'
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

  private async notify(response: AssemblyResponse): Promise<void> {
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
    })

    if (!notifyResponse.ok) {
      throw new Error(`Notify URL returned HTTP ${notifyResponse.status}`)
    }

    this.logger.notice(`Notify payload sent to ${this.notifyUrl}`)
  }
}
