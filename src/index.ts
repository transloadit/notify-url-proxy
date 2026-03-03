import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import httpProxy from 'http-proxy';

export interface ProxySettings {
  target: string;
  port: number;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

export interface AssemblyResponse {
  ok: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: ProxySettings = {
  target: 'https://api2.transloadit.com/assemblies/',
  port: 8888,
  pollIntervalMs: 2_000,
  maxPollAttempts: 10,
};

const KNOWN_STATES = new Set(['ASSEMBLY_COMPLETED', 'ASSEMBLY_UPLOADING', 'ASSEMBLY_EXECUTING']);

type KnownAssemblyState = 'ASSEMBLY_COMPLETED' | 'ASSEMBLY_UPLOADING' | 'ASSEMBLY_EXECUTING';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function extractAssemblyUrl(body: string): string | null {
  try {
    const payload = JSON.parse(body) as unknown;
    if (!isRecord(payload)) {
      return null;
    }

    const assemblyUrl = payload.assembly_url;
    return typeof assemblyUrl === 'string' && assemblyUrl.length > 0 ? assemblyUrl : null;
  } catch {
    return null;
  }
}

export function getAssemblyState(payload: unknown): KnownAssemblyState {
  if (!isRecord(payload) || typeof payload.ok !== 'string') {
    throw new Error('No ok field found in Assembly response.');
  }

  if (!KNOWN_STATES.has(payload.ok)) {
    throw new Error(`Unknown Assembly state found: ${payload.ok}`);
  }

  return payload.ok as KnownAssemblyState;
}

export function getSignature(secret: string, toSign: string): string {
  return createHmac('sha1', secret).update(Buffer.from(toSign, 'utf-8')).digest('hex');
}

export default class TransloaditNotifyUrlProxy {
  private server: Server | null = null;
  private proxy: httpProxy<IncomingMessage, ServerResponse> | null = null;

  private readonly secret: string;
  private readonly notifyUrl: string;
  private readonly defaults: ProxySettings;
  private settings: ProxySettings;

  constructor(secret: string, notifyUrl = 'http://127.0.0.1:3000/transloadit') {
    this.secret = secret || '';
    this.notifyUrl = notifyUrl;

    this.defaults = { ...DEFAULT_SETTINGS };
    this.settings = { ...DEFAULT_SETTINGS };
  }

  run(opts: Partial<ProxySettings> = {}): void {
    if (this.server !== null || this.proxy !== null) {
      this.close();
    }

    this.settings = { ...this.defaults, ...opts };

    this.createProxy();
    this.createServer();
  }

  close(): void {
    this.server?.close();
    this.server = null;

    this.proxy?.close();
    this.proxy = null;
  }

  private createProxy(): void {
    this.proxy = httpProxy.createProxyServer<IncomingMessage, ServerResponse>({
      target: this.settings.target,
      changeOrigin: true,
    });

    this.proxy.on('error', (error, _req, res) => {
      if ('writeHead' in res) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('Proxy error');
      } else {
        res.end();
      }
      this.out('Proxy error: %s', toErrorMessage(error));
    });

    this.proxy.on('proxyRes', (proxyRes) => {
      void this.handleProxyResponse(proxyRes);
    });
  }

  private createServer(): void {
    if (this.proxy === null) {
      throw new Error('Proxy is not initialized.');
    }

    this.server = createServer((req, res) => {
      this.proxy?.web(req, res);
    });

    this.server.listen(this.settings.port);

    this.out(
      'Listening on http://localhost:%d, forwarding to %s, notifying %s',
      this.settings.port,
      this.settings.target,
      this.notifyUrl,
    );
  }

  private async handleProxyResponse(proxyRes: IncomingMessage): Promise<void> {
    const body = await this.readResponseBody(proxyRes);
    const assemblyUrl = extractAssemblyUrl(body);

    if (assemblyUrl === null) {
      return;
    }

    this.out('Received proxy response, polling assemblyUrl: %s', assemblyUrl);
    await this.pollAssembly(assemblyUrl);
  }

  private async readResponseBody(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf-8');
  }

  private async pollAssembly(assemblyUrl: string): Promise<void> {
    for (let attempt = 1; attempt <= this.settings.maxPollAttempts; attempt += 1) {
      try {
        const response = await this.checkAssembly(assemblyUrl);
        await this.notify(response);
        return;
      } catch (error) {
        if (attempt === this.settings.maxPollAttempts) {
          this.out('No attempts left, giving up on checking assemblyUrl: %s', assemblyUrl);
          return;
        }

        this.out(
          'Attempt %d/%d failed for %s: %s',
          attempt,
          this.settings.maxPollAttempts,
          assemblyUrl,
          toErrorMessage(error),
        );

        await delay(this.settings.pollIntervalMs);
      }
    }
  }

  private async checkAssembly(assemblyUrl: string): Promise<AssemblyResponse> {
    const response = await fetch(assemblyUrl);
    if (!response.ok) {
      throw new Error(`Assembly poll returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const state = getAssemblyState(payload);

    if (state === 'ASSEMBLY_COMPLETED') {
      this.out('%s completed.', assemblyUrl);
      return payload as AssemblyResponse;
    }

    if (state === 'ASSEMBLY_UPLOADING') {
      throw new Error(`${assemblyUrl} is still uploading.`);
    }

    throw new Error(`${assemblyUrl} is still executing.`);
  }

  private async notify(response: AssemblyResponse): Promise<void> {
    const transloadit = JSON.stringify(response);
    const signature = getSignature(this.secret, transloadit);

    const notifyResponse = await fetch(this.notifyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams({
        transloadit,
        signature,
      }),
    });

    if (!notifyResponse.ok) {
      throw new Error(`Notify URL returned HTTP ${notifyResponse.status}`);
    }

    this.out('Notify payload sent to %s', this.notifyUrl);
  }

  private out(message: string, ...args: unknown[]): void {
    console.log(message, ...args);
  }
}
