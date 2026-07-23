/**
 * ZAO Backend - Browser Agent WebSocket Stream
 *
 * One WebSocket endpoint (/browser-agent/stream) carrying everything the
 * phone's live browser-agent view needs, in both directions:
 *
 *   PC -> phone:
 *     { type: 'frame', data: '<base64 jpeg>' }              - live screenshot, ~2fps while a task/manual session is active
 *     { type: 'status', running, awaitingHuman, reason, tabs }  - agent state changes; tabs is [{tabId, url, title, active}] for the address-bar/tab-strip UI
 *     { type: 'step', step, action }                         - one action the model just took, for the live action-log
 *     { type: 'taskResult', success, answer, error, needsHuman, reason }  - task finished/paused
 *
 *   phone -> PC:
 *     { type: 'runTask', task: '...' }                       - start a new task on this session
 *     { type: 'resumeAfterHuman' }                            - hand control back to the model after manual intervention
 *     { type: 'cancel' }                                      - stop the current task
 *     { type: 'manualClick', x, y }                           - tap-to-click on the live view (coordinates relative to the 412x915 streamed viewport)
 *     { type: 'manualType', text }                            - type into whatever's focused
 *     { type: 'manualKey', key }                              - press a single key (Enter, Tab, Backspace, etc.)
 *     { type: 'navigateTo', url }                              - address-bar navigation on the active tab
 *     { type: 'switchTab', tabId }                             - tap a tab in the strip
 *     { type: 'newTab', url }                                  - "+" button in the tab strip
 *     { type: 'closeTab', tabId }                              - "x" on a tab in the strip
 *
 * Auth: the same Bearer token as every other route, but WebSocket can't
 * carry custom headers from React Native's WebSocket implementation
 * reliably, so the token is passed as a query param instead
 * (?token=...) and validated on connection - see server/index.js for how
 * this endpoint is registered before the regular auth middleware (which
 * only applies to HTTP routes).
 *
 * SESSION LIFETIME: one AgentSession per WebSocket connection, created on
 * connect and destroyed on disconnect. This matches the phone's own
 * lifecycle (opens the browser agent screen -> connects; closes it ->
 * disconnects) rather than trying to persist a session across app
 * restarts, which would leave orphaned Chromium contexts running
 * indefinitely if a phone connection just vanishes without a clean close.
 */

const { WebSocketServer } = require('ws');
const { AgentSession } = require('./browserAgent');

function registerBrowserAgentStream(httpServer, config, log, sendToModel) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/browser-agent/stream') return; // let other upgrade handlers (if any) deal with it

    const token = url.searchParams.get('token');
    if (!token || token !== config.AUTH_TOKEN) {
      log('Browser agent stream: rejected connection with invalid/missing token');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    log('Browser agent stream: phone connected');
    const session = new AgentSession((frameBuffer) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'frame', data: frameBuffer.toString('base64') }));
      }
    });

    const sendStatus = async () => {
      if (ws.readyState !== ws.OPEN) return;
      const tabs = await session.getTabsInfo().catch(() => []);
      ws.send(JSON.stringify({
        type: 'status',
        running: session.isRunning,
        awaitingHuman: session.awaitingHuman,
        reason: session.humanReason,
        tabs,
      }));
    };

    const onStep = ({ step, action }) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'step', step, action }));
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      try {
        switch (msg.type) {
          case 'runTask': {
            await sendStatus();
            const result = await session.runTask(msg.task, sendToModel, onStep);
            await sendStatus();
            ws.send(JSON.stringify({ type: 'taskResult', ...result }));
            break;
          }
          case 'resumeAfterHuman': {
            await sendStatus();
            const result = await session.resumeAfterHuman(sendToModel, onStep);
            await sendStatus();
            ws.send(JSON.stringify({ type: 'taskResult', ...result }));
            break;
          }
          case 'cancel':
            session.cancel();
            await sendStatus();
            break;
          case 'manualClick':
            await session.manualClick(msg.x, msg.y);
            break;
          case 'manualType':
            await session.manualType(msg.text || '');
            break;
          case 'manualKey':
            await session.manualKey(msg.key);
            break;
          case 'navigateTo':
            await session.navigateActiveTab(msg.url || '');
            await sendStatus();
            break;
          case 'switchTab':
            await session.switchToTab(msg.tabId);
            await sendStatus();
            break;
          case 'newTab':
            await session.openNewTab(msg.url);
            await sendStatus();
            break;
          case 'closeTab':
            await session.closeTabById(msg.tabId);
            await sendStatus();
            break;
          default:
            log(`Browser agent stream: unknown message type "${msg.type}"`);
        }
      } catch (err) {
        log('Browser agent stream: error handling message:', err.message);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      }
    });

    ws.on('close', async () => {
      log('Browser agent stream: phone disconnected, tearing down session');
      await session.destroy();
    });

    ws.on('error', (err) => {
      log('Browser agent stream: socket error:', err.message);
    });

    sendStatus();
  });

  return wss;
}

module.exports = { registerBrowserAgentStream };
