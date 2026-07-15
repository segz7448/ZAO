/**
 * ZAO - Minimal SSE client for React Native
 *
 * React Native's fetch (Hermes) does NOT support reading response.body as
 * a streaming ReadableStream the way browser fetch does - this is a real
 * platform limitation, not an oversight. The reliable, widely-used
 * workaround is XMLHttpRequest with onprogress: RN's XHR implementation
 * does expose responseText incrementally as bytes arrive, even though
 * fetch doesn't. This file wraps that pattern once, generically, so any
 * future SSE endpoint in the app can reuse it without re-solving this.
 *
 * Not a full SSE spec implementation (no retry/id/event-name support) -
 * just what's needed for this backend's simple `data: {...}\n\n` format.
 */

/**
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.method - 'GET' | 'POST'
 * @param {object} [params.headers]
 * @param {string} [params.body] - already-serialized request body (e.g. JSON.stringify(...))
 * @param {(data: any) => void} params.onEvent - called once per parsed JSON event
 * @param {(error: Error) => void} params.onError
 * @param {() => void} [params.onComplete] - called when the connection closes normally
 * @param {number} [params.timeoutMs] - hard ceiling for the whole request
 *
 * @returns {{ abort: () => void }} - call abort() to cancel an in-flight stream
 */
export function streamSSE({ url, method = 'POST', headers = {}, body, onEvent, onError, onComplete, timeoutMs = 200_000 }) {
  const xhr = new XMLHttpRequest();
  let processedLength = 0;
  let settled = false;
  let timeoutHandle;

  const cleanup = () => {
    clearTimeout(timeoutHandle);
  };

  const safeError = (err) => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      xhr.abort();
    } catch (_) {
      // already aborted/closed, ignore
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  };

  timeoutHandle = setTimeout(() => {
    safeError(new Error('TIMEOUT'));
  }, timeoutMs);

  xhr.onprogress = () => {
    if (settled) return;
    // responseText grows as bytes arrive. We only advance processedLength
    // past COMPLETE frames (ending in "\n\n") - any trailing partial frame
    // stays unconsumed in responseText so the next onprogress call sees it
    // whole. This matters because RN's XHR can deliver a single SSE frame
    // split across two progress events on slower/chunked connections;
    // naively consuming everything seen so far would silently drop or
    // corrupt that frame instead of completing it next time.
    const unprocessed = xhr.responseText.slice(processedLength);
    const lastBoundary = unprocessed.lastIndexOf('\n\n');
    if (lastBoundary === -1) {
      return; // no complete frame yet - wait for more data
    }

    const completeText = unprocessed.slice(0, lastBoundary);
    processedLength += lastBoundary + 2; // +2 to also consume the "\n\n" itself

    const frames = completeText.split('\n\n').filter(Boolean);
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice('data:'.length).trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr);
        onEvent(parsed);
      } catch (parseErr) {
        // A frame that's between two "\n\n" boundaries but still isn't
        // valid JSON is a genuine malformed frame (not a split - splits
        // are already handled by the boundary check above) - skip it
        // rather than crashing the whole stream over one bad event.
      }
    }
  };

  xhr.onload = () => {
    if (settled) return;
    settled = true;
    cleanup();
    if (xhr.status < 200 || xhr.status >= 300) {
      onError(new Error(`HTTP ${xhr.status}`));
      return;
    }
    onComplete?.();
  };

  xhr.onerror = () => safeError(new Error('Network request failed'));
  xhr.ontimeout = () => safeError(new Error('TIMEOUT'));

  xhr.open(method, url, true);
  for (const [key, value] of Object.entries(headers)) {
    xhr.setRequestHeader(key, value);
  }
  xhr.send(body);

  return {
    abort: () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        xhr.abort();
      } catch (_) {
        // already aborted/closed, ignore
      }
    },
  };
}
