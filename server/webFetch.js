/**
 * ZAO Backend - Web Fetch route
 *
 * Claude Code's WebFetch equivalent: given a URL, actually retrieve that
 * page and hand back its readable text - not just a search snippet. This
 * is what closes the gap web_search leaves open: web_search (webSearch.js)
 * finds candidate pages, but its results are 1-2 line snippets from
 * DuckDuckGo's results page, not the page content itself. When the model
 * (or the person) already has a specific URL - from a web_search result,
 * pasted directly into chat, or a docs link it needs the actual content
 * of - this is the route that reads it.
 *
 * NO PAID API, same philosophy as webSearch.js/ocr.js: plain `fetch` +
 * regex-based HTML-to-text extraction, no headless browser and no
 * cheerio/DOM dependency for one extraction. This deliberately does NOT
 * reuse browserAgent.js's Playwright instance - that's for pages needing
 * real JS execution (browsing, clicking, forms); a one-shot "read this
 * URL" doesn't need a full browser render, and staying request/response
 * here means it can't get stuck waiting on a browser instance that's busy
 * driving the autonomous agent.
 *
 * WHY SERVER-SIDE: same reasoning as webSearch.js - one place that owns
 * outbound egress/rate limiting/timeouts, phone never ships its own
 * HTML-parsing code, and background sessions (backgroundSessions.js) can
 * call this route over loopback exactly the way the phone app does.
 */

const FETCH_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB cap - a fetched page's raw bytes, before extraction
const MAX_TEXT_CHARS = 15000; // cap on the extracted text handed back - plenty for a model to work with, not a full mirror of the page
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim() || null;
}

/**
 * Turns raw page HTML into plain, readable text - strips script/style/
 * nav/footer/svg blocks entirely (pure noise for a text model), then
 * every remaining tag, then collapses whitespace. Not a layout-preserving
 * conversion - just enough structure (line breaks between block-level
 * elements) that paragraphs and list items don't run together unreadably.
 */
function htmlToText(html) {
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Insert a newline wherever a block-level tag ends, so the flattened
  // text still reads as separate lines/paragraphs instead of one run-on
  // string.
  cleaned = cleaned.replace(/<\/(p|div|section|article|li|h[1-6]|br|tr|table|ul|ol)>/gi, '\n');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');

  const text = decodeEntities(cleaned.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  return text;
}

/**
 * Does the actual fetch + extraction. Shared by the HTTP route below and
 * by backgroundSessions.js, which calls this directly (same process)
 * rather than looping back through its own HTTP server.
 * @param {string} rawUrl
 * @returns {Promise<{url, finalUrl, title, text, truncated}>} throws on failure
 */
async function runFetch(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Missing "url" string.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs can be fetched.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl.href, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Fetch failed: server returned ${response.status} ${response.statusText}.`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isText = /text\/|application\/(xhtml|xml|json)/i.test(contentType) || contentType === '';

    if (!isText) {
      throw new Error(`Cannot extract readable text from content-type "${contentType}".`);
    }

    // Manually cap how much we read rather than trusting Content-Length
    // (some servers omit or lie about it) - abort once we've read enough
    // rather than buffering an arbitrarily large body.
    const reader = response.body?.getReader?.();
    let raw;
    if (reader) {
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
      raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    } else {
      raw = await response.text();
    }

    const isJson = /application\/json/i.test(contentType);
    let title = null;
    let text;

    if (isJson) {
      text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
    } else {
      title = extractTitle(raw);
      text = htmlToText(raw);
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS);

    return { url: parsedUrl.href, finalUrl: response.url || parsedUrl.href, title, text, truncated };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? 'Fetch timed out.' : (err.message || 'Fetch failed.'));
  }
}

/**
 * POST /web/fetch
 * body: { url: string }
 * -> { success: true, url, finalUrl, title, text, truncated }
 */
function registerWebFetchRoute(app, config, log) {
  app.post('/web/fetch', async (req, res) => {
    log(`Web fetch: ${req.body?.url}`);
    try {
      const result = await runFetch(req.body?.url);
      return res.json({ success: true, ...result });
    } catch (err) {
      log(`Web fetch error: ${err.message}`);
      const status = /not a valid URL|Missing|Only http/.test(err.message) ? 400 : 502;
      return res.status(status).json({ error: { message: err.message } });
    }
  });
}

module.exports = { registerWebFetchRoute, runFetch };
