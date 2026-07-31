/**
 * A minimal Chrome DevTools Protocol client.
 *
 * This is what makes real browser control possible — navigate, click, type,
 * evaluate, screenshot — without bundling a 400 MB Chromium into the API
 * image. Point `BROWSER_WS_ENDPOINT` at any CDP-speaking browser: a local
 * `chrome --remote-debugging-port`, a `browserless` container, or a hosted
 * session provider. Node's built-in WebSocket does the transport, so there's
 * no dependency to install.
 *
 * When no endpoint is configured the browser tools fall back to the
 * fetch driver, which can read pages but not interact with them.
 */

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
}

type WebSocketConstructor = new (url: string) => MinimalWebSocket;

function webSocketCtor(): WebSocketConstructor | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof ctor === 'function' ? (ctor as WebSocketConstructor) : null;
}

export interface CdpEndpointConfig {
  /** Direct browser-level WebSocket URL. */
  wsEndpoint?: string | null;
  /** HTTP base (e.g. http://127.0.0.1:9222) to discover the WS URL from. */
  httpEndpoint?: string | null;
}

export function cdpConfigFromEnv(): CdpEndpointConfig {
  return {
    wsEndpoint: process.env.BROWSER_WS_ENDPOINT ?? null,
    httpEndpoint: process.env.BROWSER_CDP_URL ?? null,
  };
}

export function cdpConfigured(config = cdpConfigFromEnv()): boolean {
  return Boolean(config.wsEndpoint || config.httpEndpoint);
}

async function discoverWsEndpoint(config: CdpEndpointConfig): Promise<string> {
  if (config.wsEndpoint) return config.wsEndpoint;
  if (!config.httpEndpoint) {
    throw new Error(
      'No browser endpoint configured. Set BROWSER_WS_ENDPOINT or BROWSER_CDP_URL to enable browser control.',
    );
  }
  const base = config.httpEndpoint.replace(/\/+$/, '');
  const res = await fetch(`${base}/json/version`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Browser endpoint returned HTTP ${res.status}.`);
  }
  const json = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!json.webSocketDebuggerUrl) {
    throw new Error('Browser endpoint did not advertise a DevTools WebSocket.');
  }
  return json.webSocketDebuggerUrl;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One multiplexed CDP connection; page sessions ride on top of it. */
export class CdpConnection {
  private readonly socket: MinimalWebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  private closed = false;

  private constructor(socket: MinimalWebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      this.onMessage(String(event.data ?? ''));
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('The browser connection closed.'));
      }
      this.pending.clear();
    });
  }

  static async open(config = cdpConfigFromEnv()): Promise<CdpConnection> {
    const Ctor = webSocketCtor();
    if (!Ctor) {
      throw new Error(
        'This Node runtime has no WebSocket support, so browser control is unavailable.',
      );
    }
    const url = await discoverWsEndpoint(config);
    const socket = new Ctor(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out connecting to the browser.')),
        20_000,
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to the browser endpoint.'));
      });
    });
    return new CdpConnection(socket);
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        call.reject(new Error(message.error.message ?? 'CDP command failed.'));
      } else {
        call.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 45_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('The browser connection is closed.'));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command "${method}" timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
      });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not send the browser command.'));
      }
    });
  }

  on(
    method: string,
    handler: (params: Record<string, unknown>) => void,
  ): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(handler);
    this.handlers.set(method, set);
    return () => set.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface CdpPageInfo {
  targetId: string;
  sessionId: string;
}

/** A single attached page (tab) with the operations the tools expose. */
export class CdpPage {
  constructor(
    private readonly connection: CdpConnection,
    private readonly info: CdpPageInfo,
  ) {}

  static async create(
    connection: CdpConnection,
    url = 'about:blank',
  ): Promise<CdpPage> {
    const created = await connection.send<{ targetId: string }>(
      'Target.createTarget',
      { url },
    );
    const attached = await connection.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: created.targetId, flatten: true },
    );
    const page = new CdpPage(connection, {
      targetId: created.targetId,
      sessionId: attached.sessionId,
    });
    await page.enableDomains();
    return page;
  }

  get targetId(): string {
    return this.info.targetId;
  }

  private async enableDomains(): Promise<void> {
    await this.connection.send('Page.enable', {}, this.info.sessionId);
    await this.connection.send('Runtime.enable', {}, this.info.sessionId);
    await this.connection.send('DOM.enable', {}, this.info.sessionId);
  }

  /** Navigate and wait for the load event (or the timeout, whichever first). */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.connection.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
    await this.connection.send('Page.navigate', { url }, this.info.sessionId);
    await loaded;
    // Let client-side rendering settle before anything reads the DOM.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.connection.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      this.info.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ?? 'The page script threw an error.',
      );
    }
    return result.result?.value as T;
  }

  async content(): Promise<string> {
    return this.evaluate<string>('document.documentElement.outerHTML');
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  /**
   * Click the first element matching a CSS selector. Uses a real mouse event
   * at the element's centre so handlers that require trusted events fire.
   */
  async click(selector: string): Promise<void> {
    const box = await this.evaluate<{
      x: number;
      y: number;
    } | null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
    if (!box) {
      throw new Error(`No visible element matched "${selector}".`);
    }
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.connection.send(
        'Input.dispatchMouseEvent',
        {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1,
        },
        this.info.sessionId,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  /** Focus an input and type text, firing input/change events. */
  async type(selector: string, text: string, submit = false): Promise<void> {
    const focused = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        if ('value' in el) el.value = '';
        return true;
      })()`,
    );
    if (!focused) {
      throw new Error(`No element matched "${selector}".`);
    }
    await this.connection.send(
      'Input.insertText',
      { text },
      this.info.sessionId,
    );
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    if (submit) {
      for (const type of ['keyDown', 'keyUp'] as const) {
        await this.connection.send(
          'Input.dispatchKeyEvent',
          {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            text: type === 'keyDown' ? '\r' : undefined,
          },
          this.info.sessionId,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  async scroll(deltaY: number): Promise<void> {
    await this.evaluate(`window.scrollBy(0, ${Number(deltaY) || 0})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async pressKey(key: string): Promise<void> {
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.connection.send(
        'Input.dispatchKeyEvent',
        { type, key, code: key },
        this.info.sessionId,
      );
    }
  }

  async screenshot(fullPage = false): Promise<Buffer> {
    const params: Record<string, unknown> = {
      format: 'png',
      captureBeyondViewport: fullPage,
    };
    const result = await this.connection.send<{ data?: string }>(
      'Page.captureScreenshot',
      params,
      this.info.sessionId,
    );
    if (!result.data) throw new Error('The browser returned no screenshot.');
    return Buffer.from(result.data, 'base64');
  }

  /** Interactive elements, so a model can decide what to click next. */
  async interactiveElements(limit = 60): Promise<
    Array<{ selector: string; tag: string; text: string; role: string | null }>
  > {
    return this.evaluate(
      `(() => {
        const nodes = Array.from(document.querySelectorAll(
          'a[href], button, input, select, textarea, [role=button], [role=link], [onclick]'
        ));
        const out = [];
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          let selector = el.tagName.toLowerCase();
          if (el.id) selector += '#' + CSS.escape(el.id);
          else if (el.name) selector += '[name="' + el.name + '"]';
          else if (el.getAttribute('aria-label'))
            selector += '[aria-label="' + el.getAttribute('aria-label') + '"]';
          else if (el.className && typeof el.className === 'string') {
            const first = el.className.trim().split(/\\s+/)[0];
            if (first) selector += '.' + CSS.escape(first);
          }
          out.push({
            selector,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 120),
            role: el.getAttribute('role'),
          });
          if (out.length >= ${Number(limit) || 60}) break;
        }
        return out;
      })()`,
    );
  }

  async close(): Promise<void> {
    await this.connection
      .send('Target.closeTarget', { targetId: this.info.targetId })
      .catch(() => undefined);
  }
}
