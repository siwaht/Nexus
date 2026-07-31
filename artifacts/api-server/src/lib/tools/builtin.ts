import { db, filesTable } from '@workspace/db';
import { and, desc, eq } from 'drizzle-orm';

import {
  generateImage,
  logUsage,
  resolveModelForTask,
  speak,
  transcribe,
} from '../ai';
import {
  browserCapabilities,
  captureScreenshot,
  readPage,
  runBrowserAction,
  type BrowserAction,
} from '../browser';
import { searchWeb } from '../browser/search';
import {
  deleteFact,
  listFacts,
  recallRelated,
  upsertFact,
} from '../memory';
import { retrieve, toCitations } from '../rag';
import { storage } from '../storage';
import {
  errorResult,
  textResult,
  type Citation,
  type ToolDefinition,
  type ToolResult,
} from './types';

/**
 * The built-in tool catalogue.
 *
 * Every tool declares whether it's read-only, destructive, or a safe local
 * write, which is what the permission gate keys off. Tools that spend money
 * (image generation, speech, transcription) or reach outside the account
 * (browser control) always ask the first time.
 */

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function num(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

const webSearch: ToolDefinition = {
  key: 'builtin:web_search',
  name: 'web_search',
  title: 'Web search',
  description:
    'Search the web and get back titles, URLs and snippets. Use it to find current information or to locate pages worth reading in full. Follow up with read_web_page for the actual content.',
  group: 'web',
  readOnly: true,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      limit: {
        type: 'integer',
        description: 'How many results to return (1-20). Defaults to 8.',
      },
    },
    required: ['query'],
  },
  async execute(ctx, args) {
    const query = str(args, 'query');
    if (!query) return errorResult('web_search needs a query.');
    const outcome = await searchWeb(ctx.userId, query, num(args, 'limit', 8));
    if (outcome.hits.length === 0) {
      return errorResult(outcome.note ?? 'No results found.');
    }
    const lines = outcome.hits.map(
      (hit, index) =>
        `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`,
    );
    const citations: Citation[] = outcome.hits.map((hit) => ({
      sourceType: 'url',
      url: hit.url,
      title: hit.title,
      locator: null,
      snippet: hit.snippet,
      score: null,
    }));
    return textResult(
      [
        `Results from ${outcome.engine}:`,
        ...lines,
        outcome.note ? `\nNote: ${outcome.note}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      { data: { engine: outcome.engine, hits: outcome.hits }, citations },
    );
  },
};

const readWebPage: ToolDefinition = {
  key: 'builtin:read_web_page',
  name: 'read_web_page',
  title: 'Read a web page',
  description:
    'Fetch a URL and return its readable content as markdown. Use this whenever you need the actual text of a page rather than a snippet.',
  group: 'web',
  readOnly: true,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to read.' },
      refresh: {
        type: 'boolean',
        description: 'Bypass the 15-minute cache and refetch.',
      },
      max_characters: {
        type: 'integer',
        description: 'Truncate the returned content. Defaults to 15000.',
      },
    },
    required: ['url'],
  },
  async execute(ctx, args) {
    const url = str(args, 'url');
    if (!url) return errorResult('read_web_page needs a url.');
    try {
      const page = await readPage(ctx.userId, url, {
        refresh: bool(args, 'refresh'),
      });
      const limit = Math.min(num(args, 'max_characters', 15_000), 60_000);
      const body = page.markdown.slice(0, limit);
      const truncated = page.markdown.length > limit;
      return textResult(
        [
          `# ${page.title ?? url}`,
          `Source: ${page.finalUrl}${page.fromCache ? ' (cached)' : ''} · read via ${page.driver}`,
          '',
          body,
          truncated ? '\n[content truncated]' : '',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          data: {
            url: page.finalUrl,
            title: page.title,
            driver: page.driver,
            links: page.links.slice(0, 40),
          },
          citations: [
            {
              sourceType: 'url',
              url: page.finalUrl,
              title: page.title ?? page.finalUrl,
              locator: null,
              snippet: page.text.slice(0, 300),
              score: null,
            },
          ],
        },
      );
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : `Could not read ${url}.`,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Browser control
// ---------------------------------------------------------------------------

const browserControl: ToolDefinition = {
  key: 'builtin:browser_control',
  name: 'browser_control',
  title: 'Control the browser',
  description:
    'Drive a real browser: navigate, click, type, scroll or press a key, then get back the page text plus the selectors of interactive elements. Use it for pages that need login, JavaScript, or multi-step interaction. Call it with action="snapshot" first to see what is on the page.',
  group: 'browser',
  readOnly: false,
  destructive: false,
  requires: 'browser',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'type', 'scroll', 'press', 'snapshot'],
        description: 'What to do.',
      },
      url: { type: 'string', description: 'Required for action="navigate".' },
      selector: {
        type: 'string',
        description: 'CSS selector, required for click and type.',
      },
      text: { type: 'string', description: 'Text to type, for action="type".' },
      submit: {
        type: 'boolean',
        description: 'Press Enter after typing.',
      },
      delta_y: {
        type: 'integer',
        description: 'Pixels to scroll, for action="scroll".',
      },
      key: { type: 'string', description: 'Key name, for action="press".' },
      screenshot: {
        type: 'boolean',
        description: 'Capture a screenshot after the action.',
      },
    },
    required: ['action'],
  },
  async execute(ctx, args) {
    const kind = str(args, 'action') || 'snapshot';
    let action: BrowserAction;
    switch (kind) {
      case 'navigate': {
        const url = str(args, 'url');
        if (!url) return errorResult('action="navigate" needs a url.');
        action = { kind: 'navigate', url };
        break;
      }
      case 'click': {
        const selector = str(args, 'selector');
        if (!selector) return errorResult('action="click" needs a selector.');
        action = { kind: 'click', selector };
        break;
      }
      case 'type': {
        const selector = str(args, 'selector');
        if (!selector) return errorResult('action="type" needs a selector.');
        action = {
          kind: 'type',
          selector,
          text: str(args, 'text'),
          submit: bool(args, 'submit'),
        };
        break;
      }
      case 'scroll':
        action = { kind: 'scroll', deltaY: num(args, 'delta_y', 600) };
        break;
      case 'press':
        action = { kind: 'press', key: str(args, 'key') || 'Enter' };
        break;
      default:
        action = { kind: 'snapshot' };
    }

    try {
      const result = await runBrowserAction(ctx.userId, action, {
        screenshot: bool(args, 'screenshot'),
      });
      const elements = result.interactive
        .slice(0, 30)
        .map((el) => `  ${el.selector} — ${el.tag}${el.text ? `: ${el.text}` : ''}`)
        .join('\n');
      return textResult(
        [
          `Page: ${result.title || '(untitled)'}`,
          `URL: ${result.url}`,
          '',
          result.text.slice(0, 12_000),
          '',
          elements ? `Interactive elements:\n${elements}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          data: {
            url: result.url,
            title: result.title,
            interactive: result.interactive,
            screenshotKey: result.screenshotKey,
          },
          artifacts: result.screenshotKey
            ? [
                {
                  kind: 'image' as const,
                  title: `Screenshot — ${result.title || result.url}`,
                  mime: 'image/png',
                  storageKey: result.screenshotKey,
                },
              ]
            : undefined,
        },
      );
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'The browser action failed.',
      );
    }
  },
};

const browserScreenshot: ToolDefinition = {
  key: 'builtin:browser_screenshot',
  name: 'browser_screenshot',
  title: 'Screenshot the browser',
  description:
    'Capture a PNG of the current browser page. Useful for showing the user what a page looks like.',
  group: 'browser',
  readOnly: true,
  destructive: false,
  requires: 'browser',
  parameters: {
    type: 'object',
    properties: {
      full_page: {
        type: 'boolean',
        description: 'Capture the whole scrollable page rather than the viewport.',
      },
    },
  },
  async execute(ctx, args) {
    try {
      const key = await captureScreenshot(ctx.userId, {
        fullPage: bool(args, 'full_page'),
      });
      return textResult('Screenshot captured and attached.', {
        artifacts: [
          {
            kind: 'image',
            title: 'Browser screenshot',
            mime: 'image/png',
            storageKey: key,
          },
        ],
        data: { storageKey: key },
      });
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'Could not capture a screenshot.',
      );
    }
  },
};

const browserEvaluate: ToolDefinition = {
  key: 'builtin:browser_evaluate',
  name: 'browser_evaluate',
  title: 'Run JavaScript in the page',
  description:
    'Evaluate a JavaScript expression in the current browser page and return the result. Use it to extract structured data that selectors alone cannot reach.',
  group: 'browser',
  readOnly: false,
  // Arbitrary script execution in an authenticated page always asks.
  destructive: true,
  requires: 'browser',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'A JavaScript expression. It must return a JSON-serializable value.',
      },
    },
    required: ['expression'],
  },
  async execute(ctx, args) {
    const expression = str(args, 'expression');
    if (!expression) return errorResult('browser_evaluate needs an expression.');
    try {
      const result = await runBrowserAction(
        ctx.userId,
        { kind: 'evaluate', expression },
        {},
      );
      return textResult(
        `Result:\n${JSON.stringify(result.evaluated ?? null, null, 2).slice(0, 12_000)}`,
        { data: { evaluated: result.evaluated, url: result.url } },
      );
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'The expression failed.',
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Library / RAG
// ---------------------------------------------------------------------------

const searchLibrary: ToolDefinition = {
  key: 'builtin:search_library',
  name: 'search_library',
  title: 'Search the library',
  description:
    "Semantic search over the user's uploaded documents, transcripts and notes. Returns passages with the file name and page or timestamp so you can cite them.",
  group: 'library',
  readOnly: true,
  destructive: false,
  requires: 'library',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
      file_ids: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Restrict the search to specific library file ids.',
      },
      limit: {
        type: 'integer',
        description: 'How many passages to return (1-10). Defaults to 5.',
      },
    },
    required: ['query'],
  },
  async execute(ctx, args) {
    const query = str(args, 'query');
    if (!query) return errorResult('search_library needs a query.');
    const rawIds = Array.isArray(args.file_ids) ? args.file_ids : null;
    const fileIds = rawIds
      ? rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : null;

    try {
      const outcome = await retrieve(ctx.userId, query, {
        fileIds,
        final: Math.min(num(args, 'limit', 5), 10),
      });
      if (outcome.passages.length === 0) {
        return textResult(
          outcome.note ?? 'Nothing in the library matched that query.',
        );
      }
      const body = outcome.passages.map((passage, index) => {
        const anchor = passage.locator ? ` — ${passage.locator}` : '';
        return `[${index + 1}] ${passage.filename}${anchor}\n${passage.text}`;
      });
      return textResult(
        [
          `${outcome.passages.length} passages${outcome.reranked ? ' (reranked)' : ''}:`,
          '',
          ...body,
          outcome.note ? `\nNote: ${outcome.note}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          citations: toCitations(outcome.passages),
          data: { reranked: outcome.reranked },
        },
      );
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'The library search failed.',
      );
    }
  },
};

const listLibraryFiles: ToolDefinition = {
  key: 'builtin:list_library_files',
  name: 'list_library_files',
  title: 'List library files',
  description:
    "List the user's uploaded files with their ids, types and processing status. Use the ids with search_library or read_library_file.",
  group: 'library',
  readOnly: true,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Defaults to 50.' },
    },
  },
  async execute(ctx, args) {
    const rows = await db
      .select({
        id: filesTable.id,
        filename: filesTable.filename,
        kind: filesTable.kind,
        status: filesTable.status,
        pageCount: filesTable.pageCount,
        durationS: filesTable.durationS,
        size: filesTable.size,
      })
      .from(filesTable)
      .where(eq(filesTable.userId, ctx.userId))
      .orderBy(desc(filesTable.createdAt))
      .limit(Math.min(num(args, 'limit', 50), 200));

    if (rows.length === 0) {
      return textResult('The library is empty — nothing has been uploaded yet.');
    }
    const lines = rows.map((row) => {
      const extent =
        row.pageCount !== null
          ? `${row.pageCount} pages`
          : row.durationS !== null
            ? `${Math.round(row.durationS)}s`
            : `${Math.round(row.size / 1024)} KB`;
      return `- id=${row.id} · ${row.filename} · ${row.kind} · ${extent} · ${row.status}`;
    });
    return textResult(`${rows.length} files:\n${lines.join('\n')}`, {
      data: { files: rows },
    });
  },
};

const readLibraryFile: ToolDefinition = {
  key: 'builtin:read_library_file',
  name: 'read_library_file',
  title: 'Read a library file',
  description:
    'Read the extracted text of one library file. Prefer search_library for large documents; use this when you need the whole thing.',
  group: 'library',
  readOnly: true,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'integer', description: 'The library file id.' },
      max_characters: {
        type: 'integer',
        description: 'Truncate the output. Defaults to 20000.',
      },
    },
    required: ['file_id'],
  },
  async execute(ctx, args) {
    const fileId = num(args, 'file_id', 0);
    if (!fileId) return errorResult('read_library_file needs a file_id.');
    const [row] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.userId, ctx.userId), eq(filesTable.id, fileId)));
    if (!row) return errorResult(`No library file with id ${fileId}.`);
    if (row.status !== 'ready') {
      return errorResult(
        `"${row.filename}" is still ${row.status}${row.error ? ` (${row.error})` : ''}. Try again once it's ready.`,
      );
    }
    const limit = Math.min(num(args, 'max_characters', 20_000), 120_000);
    const text = (row.extractedText ?? '').slice(0, limit);
    if (!text) return errorResult(`"${row.filename}" has no extracted text.`);
    return textResult(
      `# ${row.filename}\n\n${text}${(row.extractedText ?? '').length > limit ? '\n[truncated]' : ''}`,
      {
        citations: [
          {
            sourceType: 'file',
            fileId: row.id,
            title: row.filename,
            locator: null,
            snippet: text.slice(0, 300),
            score: null,
          },
        ],
      },
    );
  },
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const remember: ToolDefinition = {
  key: 'builtin:remember',
  name: 'remember',
  title: 'Save to long-term memory',
  description:
    'Save a durable fact about the user — a stable preference, an ongoing project, a person they work with, a recurring goal. Do not save transient task details.',
  group: 'memory',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'A short standalone third-person statement about the user.',
      },
      category: {
        type: 'string',
        enum: ['preference', 'project', 'person', 'goal', 'fact'],
      },
    },
    required: ['text'],
  },
  async execute(ctx, args) {
    const text = str(args, 'text').trim();
    if (text.length < 4) return errorResult('remember needs a fact to save.');
    const fact = await upsertFact(ctx.userId, {
      text,
      category: str(args, 'category') || 'fact',
      sourceMessageId: ctx.messageId ?? null,
    });
    return textResult(`Saved to memory: ${fact.text}`, {
      data: { fact },
    });
  },
};

const searchMemory: ToolDefinition = {
  key: 'builtin:search_memory',
  name: 'search_memory',
  title: 'Search memory and past conversations',
  description:
    'Look through saved facts and earlier conversations for something the user told you before.',
  group: 'memory',
  readOnly: true,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
    },
    required: ['query'],
  },
  async execute(ctx, args) {
    const query = str(args, 'query');
    if (!query) return errorResult('search_memory needs a query.');
    const [facts, recalled] = await Promise.all([
      listFacts(ctx.userId),
      recallRelated(ctx.userId, query, {
        conversationId: ctx.conversationId ?? null,
        limit: 6,
      }),
    ]);

    const matchingFacts = facts.filter((fact) =>
      query
        .toLowerCase()
        .split(/\s+/)
        .some((token) => token.length > 3 && fact.text.toLowerCase().includes(token)),
    );

    const parts: string[] = [];
    if (matchingFacts.length > 0) {
      parts.push(
        `Saved facts:\n${matchingFacts.map((f) => `- [${f.category}] ${f.text}`).join('\n')}`,
      );
    }
    if (recalled.length > 0) {
      parts.push(
        `From past conversations:\n${recalled
          .map(
            (item) =>
              `- (${item.conversationTitle ?? 'untitled'}, ${item.role}) ${item.content.slice(0, 400)}`,
          )
          .join('\n')}`,
      );
    }
    if (parts.length === 0) {
      return textResult('Nothing in memory matched that.');
    }
    return textResult(parts.join('\n\n'), {
      data: { facts: matchingFacts, recalled },
    });
  },
};

const forget: ToolDefinition = {
  key: 'builtin:forget',
  name: 'forget',
  title: 'Delete a memory',
  description:
    'Delete a saved fact by its id. Use search_memory first to find the id.',
  group: 'memory',
  readOnly: false,
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      fact_id: { type: 'integer', description: 'The id of the fact to delete.' },
    },
    required: ['fact_id'],
  },
  async execute(ctx, args) {
    const id = num(args, 'fact_id', 0);
    if (!id) return errorResult('forget needs a fact_id.');
    const deleted = await deleteFact(ctx.userId, id);
    return deleted
      ? textResult(`Deleted memory ${id}.`)
      : errorResult(`No memory with id ${id}.`);
  },
};

// ---------------------------------------------------------------------------
// Rich output
// ---------------------------------------------------------------------------

const createChart: ToolDefinition = {
  key: 'builtin:create_chart',
  name: 'create_chart',
  title: 'Create a chart',
  description:
    'Render data as a chart in the answer. Use it whenever the user asks for a chart, graph or visual comparison, or when numbers are easier to read visually.',
  group: 'output',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      chart_type: {
        type: 'string',
        enum: ['line', 'bar', 'area', 'pie', 'scatter'],
      },
      x_key: {
        type: 'string',
        description: 'The property in each data row used for the x axis or slice label.',
      },
      series: {
        type: 'array',
        description: 'One entry per plotted value.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['key'],
        },
      },
      data: {
        type: 'array',
        description: 'Rows of data. Each row is an object of key → number or label.',
        items: { type: 'object' },
      },
      y_label: { type: 'string' },
    },
    required: ['chart_type', 'x_key', 'series', 'data'],
  },
  async execute(_ctx, args) {
    const data = Array.isArray(args.data) ? args.data : [];
    const series = Array.isArray(args.series) ? args.series : [];
    if (data.length === 0 || series.length === 0) {
      return errorResult('create_chart needs both data rows and at least one series.');
    }
    const spec = {
      type: str(args, 'chart_type') || 'bar',
      title: str(args, 'title') || 'Chart',
      xKey: str(args, 'x_key'),
      yLabel: str(args, 'y_label') || null,
      series,
      data,
    };
    return textResult(
      `Chart "${spec.title}" rendered with ${data.length} rows and ${series.length} series.`,
      {
        artifacts: [
          {
            kind: 'chart',
            title: spec.title,
            content: JSON.stringify(spec),
            mime: 'application/json',
            metadata: { chartType: spec.type },
          },
        ],
        data: spec,
      },
    );
  },
};

const createDiagram: ToolDefinition = {
  key: 'builtin:create_diagram',
  name: 'create_diagram',
  title: 'Create a diagram',
  description:
    'Render a Mermaid diagram — flowchart, sequence, ER, state, gantt, class. Use it for architecture, process flows and relationships.',
  group: 'output',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      mermaid: {
        type: 'string',
        description: 'Valid Mermaid source, e.g. "flowchart TD\\n A-->B".',
      },
    },
    required: ['mermaid'],
  },
  async execute(_ctx, args) {
    const source = str(args, 'mermaid').trim();
    if (!source) return errorResult('create_diagram needs mermaid source.');
    const title = str(args, 'title') || 'Diagram';
    return textResult(`Diagram "${title}" rendered.`, {
      artifacts: [
        {
          kind: 'mermaid',
          title,
          content: source,
          mime: 'text/vnd.mermaid',
        },
      ],
      data: { title, mermaid: source },
    });
  },
};

const createDocument: ToolDefinition = {
  key: 'builtin:create_document',
  name: 'create_document',
  title: 'Create a document',
  description:
    'Put a long piece of writing — a summary, outline, draft, report or spec — into a side panel the user can read and download, instead of burying it in the chat scroll.',
  group: 'output',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      markdown: { type: 'string', description: 'The document body in markdown.' },
    },
    required: ['title', 'markdown'],
  },
  async execute(_ctx, args) {
    const markdown = str(args, 'markdown');
    if (markdown.trim().length < 20) {
      return errorResult('create_document needs a body worth panelling.');
    }
    const title = str(args, 'title') || 'Document';
    return textResult(
      `Document "${title}" is open in the side panel (${markdown.length} characters).`,
      {
        artifacts: [
          { kind: 'markdown', title, content: markdown, mime: 'text/markdown' },
        ],
      },
    );
  },
};

const generateImageTool: ToolDefinition = {
  key: 'builtin:generate_image',
  name: 'generate_image',
  title: 'Generate an image',
  description:
    'Create an image from a text description using the configured image model. Use it when the user asks for a picture, illustration, diagram mockup or logo.',
  group: 'media',
  readOnly: false,
  // Spends provider credit, so it asks the first time.
  destructive: false,
  requires: 'image-model',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw. Be specific.' },
      negative_prompt: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    required: ['prompt'],
  },
  async execute(ctx, args) {
    const prompt = str(args, 'prompt');
    if (!prompt) return errorResult('generate_image needs a prompt.');
    try {
      const modelRef = await resolveModelForTask(ctx.userId, 'image');
      const started = Date.now();
      const result = await generateImage(ctx.userId, {
        modelRef,
        prompt,
        negativePrompt: str(args, 'negative_prompt') || undefined,
        width: num(args, 'width', 0) || undefined,
        height: num(args, 'height', 0) || undefined,
      });
      const key = await storage.put(result.data, {
        extension: result.mime.includes('jpeg') ? '.jpg' : '.png',
        prefix: 'generated',
      });
      await logUsage({
        userId: ctx.userId,
        modelRef,
        operation: 'image',
        units: 1,
        latencyMs: Date.now() - started,
        conversationId: ctx.conversationId ?? null,
        agentRunId: ctx.agentRunId ?? null,
      });
      return textResult(`Image generated with ${modelRef}.`, {
        artifacts: [
          {
            kind: 'image',
            title: prompt.slice(0, 80),
            mime: result.mime,
            storageKey: key,
            metadata: { prompt, modelRef },
          },
        ],
        data: { storageKey: key, modelRef },
      });
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'Image generation failed.',
      );
    }
  },
};

const speakTool: ToolDefinition = {
  key: 'builtin:speak_text',
  name: 'speak_text',
  title: 'Read text aloud',
  description:
    'Turn text into speech with the configured text-to-speech model and attach an audio player.',
  group: 'media',
  readOnly: false,
  destructive: false,
  requires: 'tts-model',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to speak.' },
      voice: { type: 'string' },
    },
    required: ['text'],
  },
  async execute(ctx, args) {
    const text = str(args, 'text');
    if (!text) return errorResult('speak_text needs text.');
    try {
      const modelRef = await resolveModelForTask(ctx.userId, 'tts');
      const started = Date.now();
      const result = await speak(ctx.userId, {
        modelRef,
        text: text.slice(0, 5000),
        voice: str(args, 'voice') || undefined,
      });
      const key = await storage.put(result.data, {
        extension: result.mime.includes('wav') ? '.wav' : '.mp3',
        prefix: 'speech',
      });
      await logUsage({
        userId: ctx.userId,
        modelRef,
        operation: 'tts',
        units: text.length,
        latencyMs: Date.now() - started,
        conversationId: ctx.conversationId ?? null,
      });
      return textResult('Audio generated and attached.', {
        artifacts: [
          {
            kind: 'audio',
            title: 'Read aloud',
            mime: result.mime,
            storageKey: key,
            metadata: { modelRef },
          },
        ],
        data: { storageKey: key, modelRef },
      });
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'Speech synthesis failed.',
      );
    }
  },
};

const transcribeFile: ToolDefinition = {
  key: 'builtin:transcribe_file',
  name: 'transcribe_file',
  title: 'Transcribe audio or video',
  description:
    'Transcribe a library audio or video file with the configured speech model. Most uploads are transcribed automatically — use this to retry or to force a re-run.',
  group: 'media',
  readOnly: false,
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'integer' },
      language: { type: 'string', description: 'ISO code hint, e.g. "en".' },
    },
    required: ['file_id'],
  },
  async execute(ctx, args) {
    const fileId = num(args, 'file_id', 0);
    if (!fileId) return errorResult('transcribe_file needs a file_id.');
    const [row] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.userId, ctx.userId), eq(filesTable.id, fileId)));
    if (!row) return errorResult(`No library file with id ${fileId}.`);
    if (row.kind !== 'audio' && row.kind !== 'video') {
      return errorResult(`"${row.filename}" is not audio or video.`);
    }
    try {
      const modelRef = await resolveModelForTask(ctx.userId, 'transcription');
      const audio = await storage.get(row.storageKey);
      const started = Date.now();
      const result = await transcribe(ctx.userId, {
        modelRef,
        audio,
        mime: row.mime,
        filename: row.filename,
        language: str(args, 'language') || undefined,
      });
      await logUsage({
        userId: ctx.userId,
        modelRef,
        operation: 'transcribe',
        units: result.durationS ?? null,
        latencyMs: Date.now() - started,
      });
      return textResult(
        `Transcript of ${row.filename} (${result.segments.length} segments):\n\n${result.text.slice(0, 20_000)}`,
        { data: { segments: result.segments, durationS: result.durationS } },
      );
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'Transcription failed.',
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Agent coordination
// ---------------------------------------------------------------------------

const manageTodos: ToolDefinition = {
  key: 'builtin:manage_todos',
  name: 'manage_todos',
  title: 'Manage the task list',
  description:
    'Read or update the shared to-do list for the current run. Use action="list" to see the plan, "add" to append tasks, "complete" to tick one off, "fail" to mark one blocked, or "skip" to drop one.',
  group: 'agents',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'complete', 'fail', 'skip'],
      },
      tasks: {
        type: 'array',
        description: 'For action="add": the tasks to append.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['title'],
        },
      },
      task_id: { type: 'integer' },
      result: { type: 'string', description: 'Outcome text for complete/fail.' },
    },
    required: ['action'],
  },
  async execute(ctx, args) {
    if (!ctx.agentRunId) {
      return errorResult(
        'manage_todos only works inside an agent run. Start one with delegate_task or from the Agents panel.',
      );
    }
    // Imported lazily: the orchestrator imports the registry, which imports
    // this module.
    const orchestrator = await import('../agents');
    const action = str(args, 'action') || 'list';

    switch (action) {
      case 'add': {
        const raw = Array.isArray(args.tasks) ? args.tasks : [];
        const tasks = raw
          .map((entry) => {
            const record = entry as Record<string, unknown>;
            return {
              title: typeof record.title === 'string' ? record.title : '',
              description:
                typeof record.description === 'string' ? record.description : null,
            };
          })
          .filter((task) => task.title.length > 0);
        if (tasks.length === 0) return errorResult('No valid tasks to add.');
        const added = await orchestrator.addTasks(ctx.userId, ctx.agentRunId, tasks);
        return textResult(
          `Added ${added.length} tasks:\n${added.map((t) => `- #${t.id} ${t.title}`).join('\n')}`,
          { data: { tasks: added } },
        );
      }
      case 'complete':
      case 'fail':
      case 'skip': {
        const taskId = num(args, 'task_id', 0);
        if (!taskId) return errorResult(`action="${action}" needs a task_id.`);
        const status =
          action === 'complete' ? 'done' : action === 'fail' ? 'failed' : 'skipped';
        const updated = await orchestrator.setTaskStatus(
          ctx.userId,
          taskId,
          status,
          str(args, 'result') || null,
        );
        if (!updated) return errorResult(`No task with id ${taskId}.`);
        return textResult(`Task #${taskId} marked ${status}.`, {
          data: { task: updated },
        });
      }
      default: {
        const tasks = await orchestrator.listTasks(ctx.userId, ctx.agentRunId);
        if (tasks.length === 0) return textResult('The task list is empty.');
        return textResult(
          tasks
            .map(
              (task) =>
                `- #${task.id} [${task.status}] ${task.title}${task.description ? ` — ${task.description}` : ''}`,
            )
            .join('\n'),
          { data: { tasks } },
        );
      }
    }
  },
};

const delegateTask: ToolDefinition = {
  key: 'builtin:delegate_task',
  name: 'delegate_task',
  title: 'Delegate to another agent',
  description:
    'Hand a self-contained piece of work to a fresh agent with its own context, and get its result back. Use it for big tasks that split into independent parts, or when a subtask needs a lot of exploration you do not want in this context.',
  group: 'agents',
  readOnly: false,
  destructive: false,
  autoApprove: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short label for the subtask.' },
      instructions: {
        type: 'string',
        description:
          'Everything the agent needs: the goal, relevant context, and what to return.',
      },
      role: {
        type: 'string',
        enum: ['researcher', 'writer', 'analyst', 'reviewer', 'worker'],
      },
    },
    required: ['title', 'instructions'],
  },
  async execute(ctx, args) {
    const title = str(args, 'title');
    const instructions = str(args, 'instructions');
    if (!title || !instructions) {
      return errorResult('delegate_task needs a title and instructions.');
    }
    const orchestrator = await import('../agents');
    try {
      const outcome = await orchestrator.runDelegatedTask(ctx, {
        title,
        instructions,
        role: str(args, 'role') || 'worker',
      });
      return textResult(outcome.result, {
        data: { taskId: outcome.taskId, steps: outcome.steps },
        artifacts: outcome.artifacts,
        citations: outcome.citations,
      });
    } catch (err) {
      return errorResult(
        err instanceof Error ? err.message : 'The delegated task failed.',
      );
    }
  },
};

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  webSearch,
  readWebPage,
  browserControl,
  browserScreenshot,
  browserEvaluate,
  searchLibrary,
  listLibraryFiles,
  readLibraryFile,
  remember,
  searchMemory,
  forget,
  createChart,
  createDiagram,
  createDocument,
  generateImageTool,
  speakTool,
  transcribeFile,
  manageTodos,
  delegateTask,
];

/** Tools that only make sense once a prerequisite is actually configured. */
export function isToolAvailable(
  tool: ToolDefinition,
  context: { hasLibraryFiles: boolean; browserControl: boolean },
): boolean {
  switch (tool.requires) {
    case 'library':
      return context.hasLibraryFiles;
    case 'browser':
      return context.browserControl;
    default:
      return true;
  }
}

export function browserControlAvailable(): boolean {
  return browserCapabilities().canControl;
}

export type { ToolResult };
