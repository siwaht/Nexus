/**
 * HTML → readable text/markdown.
 *
 * Deliberately dependency-free: no jsdom, no headless browser needed just to
 * read an article. Strips scripts, styles, nav/aside/footer chrome, prefers a
 * `<main>`/`<article>` region when one exists, then converts the surviving
 * markup to markdown. Good enough for scraping and RAG ingestion; the CDP
 * driver handles anything that genuinely needs JavaScript.
 */

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '\u2019', lsquo: '\u2018',
    ldquo: '\u201c', rdquo: '\u201d', trade: '™', copy: '©', reg: '®',
    deg: '°', euro: '€', pound: '£', middot: '·', laquo: '«', raquo: '»',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => {
      return named[name.toLowerCase()] ?? match;
    });
}

function stripTag(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
  let out = html;
  let previous: string;
  // Nested occurrences need repeated passes.
  do {
    previous = out;
    out = out.replace(pattern, ' ');
  } while (out !== previous);
  return out;
}

export interface ExtractedPage {
  title: string | null;
  siteName: string | null;
  description: string | null;
  text: string;
  markdown: string;
  links: Array<{ href: string; text: string }>;
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || null;
  }
  return null;
}

/** Pick the densest plausible content region, mirroring Readability's intent. */
function mainRegion(html: string): string {
  const candidates: string[] = [];
  for (const tag of ['article', 'main']) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) candidates.push(match[1]);
  }
  const roleMain = /<div\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(
    html,
  );
  if (roleMain?.[1]) candidates.push(roleMain[1]);

  if (candidates.length === 0) return html;
  // Longest text payload wins — short <article> teasers on index pages lose.
  return candidates.reduce((best, current) =>
    current.replace(/<[^>]+>/g, '').length >
    best.replace(/<[^>]+>/g, '').length
      ? current
      : best,
  );
}

function tableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(
        decodeEntities(cellMatch[2].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim(),
      );
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) =>
    `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
  const [head, ...body] = rows;
  return [
    pad(head),
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map(pad),
  ].join('\n');
}

function toMarkdown(html: string, baseUrl: string | null): string {
  let out = html;

  // Tables first — converting them later would lose their structure.
  out = out.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table) => {
    const md = tableToMarkdown(table);
    return md ? `\n\n${md}\n\n` : '\n\n';
  });

  out = out.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi,
    (_, inner: string) =>
      `\n\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/g, ''))
        .replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`,
  );
  out = out.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi,
    (_, inner: string) => `\`${decodeEntities(inner.replace(/<[^>]+>/g, ''))}\``,
  );

  for (let level = 1; level <= 6; level += 1) {
    out = out.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}\\s*>`, 'gi'),
      (_, inner: string) =>
        `\n\n${'#'.repeat(level)} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`,
    );
  }

  out = out.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi,
    (_, inner: string) =>
      `\n\n> ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`,
  );
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? `\n- ${text}` : '';
  });

  out = out.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      let resolved = href;
      if (baseUrl) {
        try {
          resolved = new URL(href, baseUrl).toString();
        } catch {
          resolved = href;
        }
      }
      return /^(https?:|mailto:)/i.test(resolved)
        ? `[${text}](${resolved})`
        : text;
    },
  );

  out = out.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_, __, inner: string) =>
      `**${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}**`,
  );
  out = out.replace(
    /<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_, __, inner: string) =>
      `*${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}*`,
  );

  out = out.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  for (const tag of BLOCK_TAGS) {
    out = out.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), '\n\n');
  }
  out = out.replace(/<[^>]+>/g, ' ');

  return decodeEntities(out)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractFromHtml(
  html: string,
  baseUrl: string | null = null,
): ExtractedPage {
  const title =
    metaContent(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title[^>]*>([\s\S]*?)<\/title\s*>/i,
    ]) ?? null;
  const siteName = metaContent(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const description = metaContent(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ]);

  // Links come from the whole document — navigation is useful for crawling
  // even though it's excluded from the readable body.
  const links: Array<{ href: string; text: string }> = [];
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkPattern.exec(html)) !== null && links.length < 300) {
    const text = decodeEntities(linkMatch[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    let href = linkMatch[1];
    if (baseUrl) {
      try {
        href = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
    }
    if (!/^https?:/i.test(href)) continue;
    links.push({ href, text: text.slice(0, 200) });
  }

  let body = html;
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'iframe']) {
    body = stripTag(body, tag);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  const content = mainRegion(body);
  // Chrome removal happens after region selection so a page whose article is
  // inside <nav> isn't accidentally emptied.
  let cleaned = content;
  for (const tag of ['nav', 'aside', 'footer', 'header', 'form']) {
    const withoutTag = stripTag(cleaned, tag);
    if (withoutTag.replace(/<[^>]+>/g, '').trim().length > 200) {
      cleaned = withoutTag;
    }
  }

  const markdown = toMarkdown(cleaned, baseUrl);
  const text = markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`>]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, siteName, description, text, markdown, links };
}
