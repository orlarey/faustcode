// ws-client.js — WebSocket client to faustcode-mcp.
//
// Responsibilities:
//   - dial the WS URL ;
//   - read the hello frame from faustcode-mcp (NW-1) and reply with
//     ready (NW-2) ;
//   - dispatch every incoming `req` to a caller-supplied handler and
//     reply with the synchronous `resp` it returns ;
//   - answer `ping` with `pong` ;
//   - implement WA-RC-1..3 : on an involuntary close (e.g. the
//     faustcode-mcp process exits), retry with exponential backoff
//     starting at 250 ms and capped at 30 s. A successful handshake
//     resets the backoff counter.
//   - expose explicit connect / disconnect ; disconnect() halts the
//     retry loop so an intentional close stays closed.

let activeConn = null;
let intentionalDisconnect = false;
let reconnectTimer = null;
let currentOpts = null;
let attemptIndex = 0;          // ramped up on each consecutive failure
const BACKOFF_STEPS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000];

/**
 * connectMcp opens (or replaces) the WebSocket connection.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.webappVersion
 * @param {string} opts.contractVersion
 * @param {(state: 'open'|'ready'|'close'|'error', detail?: any) => void} opts.onStateChange
 * @param {(req: { id: string, op: string, args: any }) => ({ ok: true, result?: any } | { ok: false, error: { code: string, message: string } }) | Promise<...>} opts.onReq
 */
export function connectMcp(opts) {
  // Replace any pre-existing connection.
  if (activeConn) {
    try { activeConn.close(); } catch {}
    activeConn = null;
  }
  // Cancel any pending reconnect from a previous session.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  intentionalDisconnect = false;
  currentOpts = opts;
  attemptIndex = 0;
  attemptConnect();
}

function attemptConnect() {
  if (!currentOpts) return;
  if (intentionalDisconnect) return;

  const opts = currentOpts;
  const ws = new WebSocket(opts.url);
  activeConn = ws;

  ws.addEventListener('open', () => opts.onStateChange('open'));
  ws.addEventListener('error', (ev) => opts.onStateChange('error', ev.message || 'WebSocket error'));
  ws.addEventListener('close', (ev) => {
    opts.onStateChange('close', ev.code !== 1000 ? `code=${ev.code} reason=${ev.reason || '(none)'}` : '');
    activeConn = null;
    // Schedule a reconnect unless the close was explicitly requested.
    if (!intentionalDisconnect && currentOpts) {
      const delay = BACKOFF_STEPS_MS[Math.min(attemptIndex, BACKOFF_STEPS_MS.length - 1)];
      attemptIndex++;
      opts.onStateChange('reconnecting', { delay, attempt: attemptIndex });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attemptConnect();
      }, delay);
    }
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (err) {
      opts.onStateChange('error', `bad JSON frame : ${err}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.kind) {
      case 'hello': {
        // NW-1 -> NW-2.
        const ready = {
          kind: 'ready',
          webappVersion: opts.webappVersion,
          contractVersion: opts.contractVersion,
        };
        // SC-4 : forward the shared token if the caller passed one.
        if (opts.token) ready.token = opts.token;
        ws.send(JSON.stringify(ready));
        // A successful handshake means the next disconnect should retry
        // from the bottom of the backoff curve (250 ms), not wherever we
        // left off from earlier failures.
        attemptIndex = 0;
        opts.onStateChange('ready', {
          mcpVersion: msg.mcpVersion,
          contractVersion: msg.contractVersion,
        });
        break;
      }
      case 'ping': {
        ws.send(JSON.stringify({ kind: 'pong', at: msg.at }));
        break;
      }
      case 'req': {
        // Hand the request to the caller, await the result (sync OR async),
        // then ship a single response. Any thrown error becomes an
        // `op_unknown`-style error payload so faustcode-mcp does not hang.
        let outcome;
        try {
          outcome = await opts.onReq(msg);
        } catch (err) {
          outcome = {
            ok: false,
            error: { code: 'op_unknown', message: String(err) },
          };
        }
        const resp = {
          kind: 'resp',
          id: msg.id,
          ok: !!outcome.ok,
          result: outcome.ok ? (outcome.result ?? null) : undefined,
          error: outcome.ok ? undefined : outcome.error,
        };
        ws.send(JSON.stringify(resp));
        break;
      }
      default:
        // Unknown kinds are silently ignored ; faustcode-mcp would normally
        // only ever send hello / ping / req.
        break;
    }
  });
}

export function disconnect() {
  intentionalDisconnect = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeConn) {
    try { activeConn.close(1000, 'client requested disconnect'); } catch {}
    activeConn = null;
  }
  currentOpts = null;
  attemptIndex = 0;
}
