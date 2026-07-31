import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { assertPublicWebUrl } from '../browser/guard';

/**
 * A Model Context Protocol client.
 *
 * Three transports:
 *   http  — Streamable HTTP (spec 2025-03-26+). The portable default: works on
 *           serverless and autoscale hosts because it's just request/response.
 *   sse   — the legacy HTTP+SSE transport, for servers that haven't migrated.
 *   stdio — spawns a local process. Only offered when the API runs on a
 *           long-lived host and MCP_ALLOW_STDIO is set, because spawning
 *           arbitrary commands is a serious capability and it can't work on a
 *           request-scoped runtime anyway.
 *
 * Remote URLs go through the same SSRF guard the web tools use — an MCP server
 * URL is user input and must not be able to reach internal addresses.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'nexus', version: '1.0.0' };

export type McpTransportKind = 'http' | 'sse' | 'stdio';

export interface McpConnectionConfig {
  transport: McpTransportKind;
  url?: string | null;
  command?: string | null;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  instructions: string | null;
}

export interface McpCallResult {
  text: string;
  /** Non-text content blocks (images, resources) passed through for the UI. */
  blocks: Array<Record<string, unknown>>;
  isError: boolean;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** stdio requires a persistent process, which request-scoped hosts don't have. */
export function stdioAvailable(): boolean {
  return process.env.MCP_ALLOW_STDIO === '1';
}

export function stdioUnavailableReason(): string {
  return 'stdio MCP servers are disabled. They spawn local processes, which only works when Nexus runs on a long-lived host — set MCP_ALLOW_STDIO=1 there to enable them. Remote servers (http/sse) work everywhere.';
}

abstract class Transport {
  abstract request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  abstract notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void>;
  abstract close(): void;
}

// ---------------------------------------------------------------------------
// Streamable HTTP + legacy SSE
// ---------------------------------------------------------------------------

/** Pull the first JSON-RPC response for `id` out of an SSE body. */
async function firstResponseFromSse(
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
        const payload = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (payload) {
          try {
            const parsed = JSON.parse(payload) as JsonRpcResponse;
            if (parsed.id === id) return parsed;
          } catch {
            // Ignore non-JSON keepalives.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new McpError('The MCP server closed the stream without responding.');
}

class HttpTransport extends Transport {
  private sessionId: string | null = null;
  private nextId = 1;
  /** Legacy SSE servers advertise a separate POST endpoint. */
  private postUrl: string;
  private sseAbort: AbortController | null = null;

  private constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string>,
    postUrl?: string,
  ) {
    super();
    this.postUrl = postUrl ?? endpoint;
  }

  static async create(
    config: McpConnectionConfig,
  ): Promise<HttpTransport> {
    if (!config.url) {
      throw new McpError('This MCP server has no URL configured.');
    }
    const { url } = await assertPublicWebUrl(config.url);
    const headers = { ...(config.headers ?? {}) };

    if (config.transport === 'http') {
      return new HttpTransport(url.toString(), headers);
    }

    // Legacy SSE: open the stream, wait for the `endpoint` event that names
    // where messages should be POSTed.
    const controller = new AbortController();
    const res = await fetch(url, {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      controller.abort();
      throw new McpError(
        `The MCP server returned HTTP ${res.status} when opening the event stream.`,
      );
    }

    const postUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new McpError('The MCP server never advertised a message endpoint.')),
        20_000,
      );
      void (async () => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const match = /event:\s*endpoint[\s\S]*?data:\s*(\S+)/.exec(buffer);
            if (match) {
              clearTimeout(timer);
              resolve(new URL(match[1], url).toString());
              return;
            }
          }
          clearTimeout(timer);
          reject(new McpError('The MCP event stream ended during handshake.'));
        } catch {
          clearTimeout(timer);
          reject(new McpError('The MCP event stream failed during handshake.'));
        }
      })();
    }).catch((err) => {
      controller.abort();
      throw err;
    });

    const transport = new HttpTransport(url.toString(), headers, postUrl);
    transport.sseAbort = controller;
    return transport;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      throw new McpError('Could not reach the MCP server.');
    });

    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new McpError(
        `The MCP server returned HTTP ${res.status}.`,
        body.slice(0, 500) || null,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    const response = contentType.includes('text/event-stream')
      ? await firstResponseFromSse(res.body!, id)
      : ((await res.json()) as JsonRpcResponse);

    if (response.error) {
      throw new McpError(
        response.error.message ?? 'The MCP server reported an error.',
      );
    }
    return response.result ?? {};
  }

  async notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await fetch(this.postUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }

  close(): void {
    this.sseAbort?.abort();
    if (this.sessionId) {
      void fetch(this.postUrl, {
        method: 'DELETE',
        headers: this.buildHeaders(),
      }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

class StdioTransport extends Transport {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.on('exit', () => {
      for (const call of this.pending.values()) {
        call.reject(new McpError('The MCP server process exited.'));
      }
      this.pending.clear();
    });
  }

  static create(config: McpConnectionConfig): StdioTransport {
    if (!stdioAvailable()) {
      throw new McpError(stdioUnavailableReason());
    }
    if (!config.command) {
      throw new McpError('This MCP server has no command configured.');
    }
    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.env ?? {}) },
    }) as ChildProcessWithoutNullStreams;
    // Drain stderr so a chatty server can't fill its pipe and stall.
    child.stderr.resume();
    return new StdioTransport(child);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (typeof message.id === 'number') {
            const call = this.pending.get(message.id);
            if (call) {
              this.pending.delete(message.id);
              if (message.error) {
                call.reject(
                  new McpError(
                    message.error.message ?? 'The MCP server reported an error.',
                  ),
                );
              } else {
                call.resolve(message.result ?? {});
              }
            }
          }
        } catch {
          // Not JSON-RPC — ignore.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`The MCP server did not answer "${method}" in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  }

  async notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.child.kill();
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class McpClient {
  private constructor(
    private readonly transport: Transport,
    private readonly timeoutMs: number,
    readonly serverInfo: McpServerInfo,
  ) {}

  static async connect(config: McpConnectionConfig): Promise<McpClient> {
    const timeoutMs = config.timeoutMs ?? 45_000;
    const transport =
      config.transport === 'stdio'
        ? StdioTransport.create(config)
        : await HttpTransport.create(config);

    try {
      const result = await transport.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, roots: { listChanged: false } },
          clientInfo: CLIENT_INFO,
        },
        timeoutMs,
      );
      await transport.notify('notifications/initialized', {});

      const info = (result.serverInfo ?? {}) as {
        name?: string;
        version?: string;
      };
      return new McpClient(transport, timeoutMs, {
        name: info.name ?? 'unknown',
        version: info.version ?? '0.0.0',
        protocolVersion:
          (result.protocolVersion as string | undefined) ?? PROTOCOL_VERSION,
        capabilities: (result.capabilities as Record<string, unknown>) ?? {},
        instructions: (result.instructions as string | undefined) ?? null,
      });
    } catch (err) {
      transport.close();
      throw err;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const result = await this.transport.request(
        'tools/list',
        cursor ? { cursor } : {},
        this.timeoutMs,
      );
      const batch = (result.tools ?? []) as Array<{
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
      }>;
      for (const tool of batch) {
        if (!tool.name) continue;
        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema:
            tool.inputSchema ?? { type: 'object', properties: {} },
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          // Absent hint means "assume it can change things".
          destructiveHint: tool.annotations?.destructiveHint !== false,
        });
      }
      cursor = result.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = await this.transport.request(
      'tools/call',
      { name, arguments: args },
      this.timeoutMs,
    );
    const content = (result.content ?? []) as Array<Record<string, unknown>>;
    const textParts: string[] = [];
    const blocks: Array<Record<string, unknown>> = [];

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else {
        blocks.push(block);
      }
    }

    // Some servers answer with structuredContent instead of text blocks.
    if (textParts.length === 0 && result.structuredContent) {
      textParts.push(JSON.stringify(result.structuredContent));
    }

    return {
      text: textParts.join('\n').trim(),
      blocks,
      isError: result.isError === true,
    };
  }

  close(): void {
    this.transport.close();
  }
}
