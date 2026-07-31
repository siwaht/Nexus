import { resolveSecret } from '../secrets';
import { guardedFetch } from './guard';
import { extractFromHtml } from './html';

/**
 * Web search with graceful degradation.
 *
 * If the user has stored a search API key in the vault (Brave, Tavily or
 * Serper), that provider is used — better results, stable contract. With no
 * key configured it falls back to scraping DuckDuckGo's HTML endpoint, which
 * needs no credentials but is thinner and can rate-limit. The result always
 * reports which engine answered so the model can caveat accordingly.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutcome {
  engine: 'brave' | 'tavily' | 'serper' | 'duckduckgo';
  hits: SearchHit[];
  note: string | null;
}

const SECRET_NAMES = {
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
  serper: 'SERPER_API_KEY',
} as const;

async function braveSearch(key: string, query: string, limit: number) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}.`);
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (json.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: (r.description ?? '').replace(/<[^>]+>/g, ''),
    }));
}

async function tavilySearch(key: string, query: string, limit: number) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, max_results: limit }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}.`);
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: r.content ?? '',
    }));
}

async function serperSearch(key: string, query: string, limit: number) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: limit }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}.`);
  const json = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (json.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: r.title ?? r.link!,
      url: r.link!,
      snippet: r.snippet ?? '',
    }));
}

/** Keyless fallback: parse DuckDuckGo's no-JS HTML results page. */
async function duckDuckGoSearch(
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const { response } = await guardedFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { method: 'GET' },
    25_000,
  );
  if (!response.ok) {
    throw new Error(
      `DuckDuckGo returned HTTP ${response.status}. Add a search API key in Settings → API Keys for reliable results.`,
    );
  }
  const html = await response.text();
  const hits: SearchHit[] = [];
  const resultPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html)) !== null && hits.length < limit) {
    let href = match[1];
    // DuckDuckGo wraps outbound links in a redirector.
    const wrapped = /[?&]uddg=([^&]+)/.exec(href);
    if (wrapped) href = decodeURIComponent(wrapped[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:/i.test(href)) continue;
    const title = extractFromHtml(match[2]).text.replace(/\s+/g, ' ').trim();
    hits.push({ title: title || href, url: href, snippet: '' });
  }

  // Snippets live in sibling nodes; pair them up positionally.
  const snippetPattern =
    /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  let snippetMatch: RegExpExecArray | null;
  while (
    (snippetMatch = snippetPattern.exec(html)) !== null &&
    index < hits.length
  ) {
    hits[index].snippet = extractFromHtml(snippetMatch[1])
      .text.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    index += 1;
  }
  return hits;
}

export async function searchWeb(
  userId: string,
  query: string,
  limit = 8,
): Promise<SearchOutcome> {
  const trimmed = query.trim();
  if (!trimmed) return { engine: 'duckduckgo', hits: [], note: 'Empty query.' };
  const capped = Math.min(Math.max(limit, 1), 20);

  const [brave, tavily, serper] = await Promise.all([
    resolveSecret(userId, SECRET_NAMES.brave),
    resolveSecret(userId, SECRET_NAMES.tavily),
    resolveSecret(userId, SECRET_NAMES.serper),
  ]);

  const attempts: Array<{
    engine: SearchOutcome['engine'];
    run: () => Promise<SearchHit[]>;
  }> = [];
  if (brave) attempts.push({ engine: 'brave', run: () => braveSearch(brave, trimmed, capped) });
  if (tavily) attempts.push({ engine: 'tavily', run: () => tavilySearch(tavily, trimmed, capped) });
  if (serper) attempts.push({ engine: 'serper', run: () => serperSearch(serper, trimmed, capped) });
  attempts.push({ engine: 'duckduckgo', run: () => duckDuckGoSearch(trimmed, capped) });

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const hits = await attempt.run();
      if (hits.length > 0) {
        return {
          engine: attempt.engine,
          hits,
          note:
            attempt.engine === 'duckduckgo' && attempts.length === 1
              ? 'Using the keyless DuckDuckGo fallback. Store BRAVE_API_KEY, TAVILY_API_KEY or SERPER_API_KEY in Settings → API Keys for better results.'
              : null,
        };
      }
      errors.push(`${attempt.engine} returned no results`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `${attempt.engine} failed`);
    }
  }

  return {
    engine: 'duckduckgo',
    hits: [],
    note: `No results. ${errors.join('; ')}`,
  };
}
