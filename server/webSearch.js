/**
 * ZAO Backend - Web Search route
 *
 * This is what the phone app's "Web search" toggle (src/components/
 * AttachmentSheet.js) and the local coder model's web_search tool
 * (src/services/search/webSearchTool.js -> src/services/toolOrchestrator.js)
 * actually talk to - previously that toggle was UI-only with no backing
 * route, hence "Coming soon."
 *
 * NO PAID API, same philosophy as ocr.js (free/open-source only): this
 * hits DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/), which is
 * a plain server-rendered results page meant for non-JS clients/older
 * browsers - no API key, no account, no billing. Results are parsed out
 * with regex rather than pulling in a DOM/HTML-parsing dependency
 * (cheerio etc.) for one small extraction, matching how officeExtractors.js
 * /pdfExtractor.js already avoid extra parsing deps elsewhere in this repo.
 *
 * WHY SERVER-SIDE, NOT DIRECTLY FROM THE PHONE: keeps this consistent
 * with every other external call ZAO makes (terminal, OCR) - one place
 * that owns outbound network egress and rate limiting, and the phone
 * app never needs its own HTML-scraping code. It also means a future
 * swap to a paid search API (Brave/Bing/etc.) only touches this one
 * file, not the phone app.
 */

const SEARCH_TIMEOUT_MS = 15000;
const MAX_RESULTS_DEFAULT = 5;
const MAX_RESULTS_CAP = 10;

// DuckDuckGo's HTML results wrap each result in a <div class="result">
// block containing a result__a link (title + href) and a result__snippet
// (the descriptive text). This regex walks those blocks one at a time
// rather than trying to match the whole page in one pass, since result
// blocks can appear in varying order/spacing across DDG's markup
// revisions.
const RESULT_BLOCK_RE = /<div class="result results_links[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
const TITLE_LINK_RE = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo's HTML results wrap external URLs in a redirect
// (//duckduckgo.com/l/?uddg=<encoded-real-url>&...) rather than linking
// straight to them - unwrap that so the model/person get the real
// destination URL, not a DDG redirect link.
function unwrapDdgRedirect(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const real = url.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

function parseResults(html, maxResults) {
  const results = [];
  let match;
  RESULT_BLOCK_RE.lastIndex = 0;

  while ((match = RESULT_BLOCK_RE.exec(html)) && results.length < maxResults) {
    const block = match[1];
    const titleMatch = TITLE_LINK_RE.exec(block);
    if (!titleMatch) continue;

    const snippetMatch = SNIPPET_RE.exec(block);
    const title = stripTags(titleMatch[2]);
    const url = unwrapDdgRedirect(titleMatch[1]);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// lite.duckduckgo.com's markup is a plain <table> of results rather than
// html.duckduckgo.com's <div class="result">-based layout - a genuinely
// different parser, not the same regex reused. This is the FALLBACK path
// (see runSearch below): html.duckduckgo.com occasionally serves an
// interstitial/anomaly page instead of real results (rate-limiting,
// bot-detection) that RESULT_BLOCK_RE simply finds zero matches in -
// rather than surfacing that as "no results" to the model, retry once
// against lite's simpler markup before giving up.
const LITE_RESULT_LINK_RE = /<a[^>]*rel="nofollow"[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
const LITE_SNIPPET_RE = /<td class="result-snippet">([\s\S]*?)<\/td>/g;

function parseLiteResults(html, maxResults) {
  const links = [];
  let m;
  LITE_RESULT_LINK_RE.lastIndex = 0;
  while ((m = LITE_RESULT_LINK_RE.exec(html)) && links.length < maxResults) {
    const title = stripTags(m[2]);
    const url = unwrapDdgRedirect(m[1]);
    if (title && url) links.push({ title, url, snippet: '' });
  }

  const snippets = [];
  let s;
  LITE_SNIPPET_RE.lastIndex = 0;
  while ((s = LITE_SNIPPET_RE.exec(html))) snippets.push(stripTags(s[1]));

  return links.map((r, i) => ({ ...r, snippet: snippets[i] || '' }));
}

async function fetchText(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Runs the actual search, trying html.duckduckgo.com first and falling
 * back to lite.duckduckgo.com if the primary endpoint comes back with
 * zero parsed results (rather than surfacing a transient bot-detection
 * page as "there are no results for that"). Shared by the HTTP route
 * below and by backgroundSessions.js, which calls this directly rather
 * than looping back through its own HTTP server.
 * @returns {Promise<{results: Array<{title,url,snippet}>, provider: string}>}
 */
async function runSearch(query, maxResults) {
  const primary = await fetchText(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ q: query }).toString(),
    },
    SEARCH_TIMEOUT_MS
  );

  if (primary.ok) {
    const html = await primary.text();
    const results = parseResults(html, maxResults);
    if (results.length > 0) return { results, provider: 'duckduckgo-html' };
  }

  // Fallback: lite endpoint, simpler markup, less likely to trip
  // whatever the primary endpoint's anomaly detection is reacting to.
  const fallback = await fetchText(
    `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query }).toString()}`,
    { method: 'GET', headers: { 'User-Agent': UA } },
    SEARCH_TIMEOUT_MS
  );

  if (!fallback.ok) {
    throw new Error(`Search provider returned ${fallback.status}.`);
  }

  const html = await fallback.text();
  return { results: parseLiteResults(html, maxResults), provider: 'duckduckgo-lite' };
}

/**
 * POST /web/search
 * body: { query: string, maxResults?: number }
 * -> { success: true, query, results: [{ title, url, snippet }] }
 */
function registerWebSearchRoute(app, config, log) {
  app.post('/web/search', async (req, res) => {
    const query = req.body?.query;
    const maxResults = Math.min(Number(req.body?.maxResults) || MAX_RESULTS_DEFAULT, MAX_RESULTS_CAP);

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: { message: 'Missing "query" string in request body.' } });
    }

    log(`Web search: "${query}" (max ${maxResults})`);

    try {
      const { results, provider } = await runSearch(query.trim(), maxResults);
      if (provider === 'duckduckgo-lite') log(`Web search: primary endpoint returned nothing, used lite fallback for "${query}"`);
      return res.json({ success: true, query, results });
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Search timed out.' : (err.message || 'Search failed.');
      log(`Web search error: ${message}`);
      return res.status(502).json({ error: { message } });
    }
  });
}

module.exports = { registerWebSearchRoute, runSearch };
