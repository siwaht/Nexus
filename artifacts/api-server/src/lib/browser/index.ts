import { db, webPagesTable } from '@workspace/db';
import { and, desc, eq } from 'drizzle-orm';

import { storage } from '../storage';
import { CdpConnection, CdpPage, cdpConfigured } from './cdp';
import { guardedFetch } from './guard';
import { extractFromHtml, type ExtractedPage } from './html';

/**
 * Web access and browser control behind one interface.
 *
 * Two drivers:
 *   fetch — always available. SSRF-guarded HTTP + readable extraction. Reads
 *           pages, can't interact with them or run JavaScript.
 *   cdp   — available when BROWSER_WS_ENDPOINT / BROWSER_CDP_URL points at a
 *           CDP-speaking browser. Full control: navigate, click, type,
 *           scroll, screenshot, evaluate, and JS-rendered content.
 *
 * Tools call these functions and report which driver served the request, so
 * an answer never silently claims it clicked something it only fetched.
 */

export type BrowserDriverName = 'fetch' | 'cdp';

export interface BrowserCapabilities {
  driver: BrowserDriverName;
  canControl: boolean;
  canRenderJavaScript: boolean;
  reason: string;
}

export function browserCapabilities(): BrowserCapabilities {
  if (cdpConfigured()) {
    return {
      driver: 'cdp',
      canControl: true,
      canRenderJavaScript: true,
      reason: 'Connected to a CDP browser endpoint.',
    };
  }
  return {
    driver: 'fetch',
    canControl: false,
    canRenderJavaScript: false,
    reason:
      'No browser endpoint configured — pages can be read but not interacted with. Set BROWSER_WS_ENDPOINT to enable control.',
  };
}

// ---------------------------------------------------------------------------
// Page reading (fetch driver, with cache)
// ---------------------------------------------------------------------------

export interface PageSnapshot extends ExtractedPage {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  driver: BrowserDriverName;
  fromCache: boolean;
  screenshotKey?: string | null;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

async function cachedPage(
  userId: string,
  url: string,
): Promise<PageSnapshot | null> {
  const [row] = await db
    .select()
    .from(webPagesTable)
    .where(and(eq(webPagesTable.userId, userId), eq(webPagesTable.url, url)))
    .orderBy(desc(webPagesTable.fetchedAt))
    .limit(1);
  if (!row) return null;
  if (Date.now() - row.fetchedAt.getTime() > CACHE_TTL_MS) return null;
  return {
    url: row.url,
    finalUrl: row.finalUrl ?? row.url,
    statusCode: row.statusCode,
    title: row.title,
    siteName: row.siteName,
    description: null,
    text: row.contentText ?? '',
    markdown: row.contentMarkdown ?? '',
    links: [],
    driver: 'fetch',
    fromCache: true,
    screenshotKey: row.screenshotKey,
  };
}

async function cachePage(
  userId: string,
  snapshot: PageSnapshot,
): Promise<void> {
  await db
    .insert(webPagesTable)
    .values({
      userId,
      url: snapshot.url,
      finalUrl: snapshot.finalUrl,
      title: snapshot.title,
      siteName: snapshot.siteName,
      contentText: snapshot.text.slice(0, 400_000),
      contentMarkdown: snapshot.markdown.slice(0, 400_000),
      screenshotKey: snapshot.screenshotKey ?? null,
      statusCode: snapshot.statusCode,
      fetchedAt: new Date(),
    })
    .catch(() => undefined);
}

/**
 * Read a page. Uses the CDP driver when available (so client-rendered pages
 * work), otherwise a guarded fetch.
 */
export async function readPage(
  userId: string,
  url: string,
  options: { refresh?: boolean; render?: boolean } = {},
): Promise<PageSnapshot> {
  if (!options.refresh) {
    const cached = await cachedPage(userId, url);
    if (cached) return cached;
  }

  const wantsRender = options.render !== false;
  if (wantsRender && cdpConfigured()) {
    try {
      const snapshot = await readPageWithBrowser(userId, url);
      await cachePage(userId, snapshot);
      return snapshot;
    } catch {
      // A browser failure shouldn't block a plain read — fall through.
    }
  }

  const { response, finalUrl } = await guardedFetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const statusCode = response.status;

  if (!response.ok) {
    throw new Error(
      `${url} returned HTTP ${statusCode}${response.statusText ? ` (${response.statusText})` : ''}.`,
    );
  }

  if (
    !/text\/html|application\/xhtml|text\/plain|application\/json|text\/markdown|application\/xml|text\/xml/.test(
      contentType,
    )
  ) {
    throw new Error(
      `${url} is ${contentType || 'an unsupported type'} — only text and HTML pages can be read. Upload binary files to the Library instead.`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const body = buffer.subarray(0, MAX_HTML_BYTES).toString('utf8');
  const extracted = /html|xml/.test(contentType)
    ? extractFromHtml(body, finalUrl)
    : {
        title: null,
        siteName: null,
        description: null,
        text: body,
        markdown: body,
        links: [],
      };

  const snapshot: PageSnapshot = {
    ...extracted,
    url,
    finalUrl,
    statusCode,
    driver: 'fetch',
    fromCache: false,
  };
  await cachePage(userId, snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Browser sessions (CDP driver)
// ---------------------------------------------------------------------------

interface Session {
  connection: CdpConnection;
  page: CdpPage;
  userId: string;
  lastUsedAt: number;
  currentUrl: string;
}

const SESSION_IDLE_MS = 10 * 60 * 1000;
const sessions = new Map<string, Session>();

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastUsedAt < cutoff) {
      void session.page.close();
      session.connection.close();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

export async function ensureSession(
  userId: string,
  sessionId = 'default',
): Promise<Session> {
  const key = sessionKey(userId, sessionId);
  const existing = sessions.get(key);
  if (existing && !existing.connection.isClosed) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) sessions.delete(key);

  const connection = await CdpConnection.open();
  const page = await CdpPage.create(connection);
  const session: Session = {
    connection,
    page,
    userId,
    lastUsedAt: Date.now(),
    currentUrl: 'about:blank',
  };
  sessions.set(key, session);
  return session;
}

export async function closeSession(
  userId: string,
  sessionId = 'default',
): Promise<void> {
  const key = sessionKey(userId, sessionId);
  const session = sessions.get(key);
  if (!session) return;
  await session.page.close();
  session.connection.close();
  sessions.delete(key);
}

export function listSessions(
  userId: string,
): Array<{ sessionId: string; url: string; lastUsedAt: number }> {
  const out: Array<{ sessionId: string; url: string; lastUsedAt: number }> = [];
  for (const [key, session] of sessions) {
    if (session.userId !== userId) continue;
    out.push({
      sessionId: key.slice(userId.length + 1),
      url: session.currentUrl,
      lastUsedAt: session.lastUsedAt,
    });
  }
  return out;
}

async function readPageWithBrowser(
  userId: string,
  url: string,
): Promise<PageSnapshot> {
  // Validate before handing the URL to a browser that follows redirects itself.
  const session = await ensureSession(userId, 'read');
  await session.page.navigate(url);
  session.currentUrl = await session.page.currentUrl();
  const html = await session.page.content();
  const extracted = extractFromHtml(html, session.currentUrl);
  return {
    ...extracted,
    url,
    finalUrl: session.currentUrl,
    statusCode: 200,
    driver: 'cdp',
    fromCache: false,
  };
}

export interface BrowserActionResult {
  url: string;
  title: string;
  /** Readable text of the page after the action. */
  text: string;
  interactive: Array<{
    selector: string;
    tag: string;
    text: string;
    role: string | null;
  }>;
  screenshotKey: string | null;
}

async function snapshotAfterAction(
  session: Session,
  captureScreenshot: boolean,
): Promise<BrowserActionResult> {
  session.currentUrl = await session.page.currentUrl();
  const html = await session.page.content();
  const extracted = extractFromHtml(html, session.currentUrl);
  const interactive = await session.page.interactiveElements().catch(() => []);
  let screenshotKey: string | null = null;
  if (captureScreenshot) {
    try {
      const png = await session.page.screenshot();
      screenshotKey = await storage.put(png, {
        extension: '.png',
        prefix: 'screenshots',
      });
    } catch {
      screenshotKey = null;
    }
  }
  return {
    url: session.currentUrl,
    title: extracted.title ?? '',
    text: extracted.text.slice(0, 20_000),
    interactive,
    screenshotKey,
  };
}

export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string; submit?: boolean }
  | { kind: 'scroll'; deltaY: number }
  | { kind: 'press'; key: string }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'snapshot' };

export async function runBrowserAction(
  userId: string,
  action: BrowserAction,
  options: { sessionId?: string; screenshot?: boolean } = {},
): Promise<BrowserActionResult & { evaluated?: unknown }> {
  if (!cdpConfigured()) {
    throw new Error(
      'Browser control is not available: no CDP endpoint is configured. Set BROWSER_WS_ENDPOINT (or BROWSER_CDP_URL) to a running browser, or use the page-reading tools instead.',
    );
  }
  const session = await ensureSession(userId, options.sessionId ?? 'default');

  let evaluated: unknown;
  switch (action.kind) {
    case 'navigate': {
      // Re-run the SSRF check: the browser would happily hit an internal host.
      const { assertPublicWebUrl } = await import('./guard');
      const { url } = await assertPublicWebUrl(action.url);
      await session.page.navigate(url.toString());
      break;
    }
    case 'click':
      await session.page.click(action.selector);
      break;
    case 'type':
      await session.page.type(action.selector, action.text, action.submit);
      break;
    case 'scroll':
      await session.page.scroll(action.deltaY);
      break;
    case 'press':
      await session.page.pressKey(action.key);
      break;
    case 'evaluate':
      evaluated = await session.page.evaluate(action.expression);
      break;
    case 'snapshot':
      break;
  }

  const result = await snapshotAfterAction(session, options.screenshot ?? false);
  return evaluated === undefined ? result : { ...result, evaluated };
}

export async function captureScreenshot(
  userId: string,
  options: { sessionId?: string; fullPage?: boolean } = {},
): Promise<string> {
  if (!cdpConfigured()) {
    throw new Error(
      'Screenshots need a browser endpoint. Set BROWSER_WS_ENDPOINT to enable them.',
    );
  }
  const session = await ensureSession(userId, options.sessionId ?? 'default');
  const png = await session.page.screenshot(options.fullPage ?? false);
  return storage.put(png, { extension: '.png', prefix: 'screenshots' });
}

export { assertPublicWebUrl, guardedFetch } from './guard';
export { extractFromHtml } from './html';
export type { ExtractedPage } from './html';
