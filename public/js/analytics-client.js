// 只记录已进入应用的前台活动；下载/预取/离线阅读不触发漫画埋点。
import { apiRequest } from './api.js';
let started = false;
let canTrack = () => false;
let pendingPage = false;
let lastActive = 0;
let timer = null;
const requests = new Set();
const foreground = () => started && canTrack() && document.visibilityState === 'visible' && navigator.onLine !== false;

function send(kind, proof, signal) {
  if (!foreground() || signal?.aborted) return;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 10000);
  requests.add(controller);
  // 尽力而为，不重放、不补传历史；错误不能打断主站业务。
  return apiRequest('/analytics/event', { method: 'POST', signal: controller.signal,
    body: JSON.stringify({ kind, ...(proof ? { proof } : {}) }),
  }).catch(() => {}).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    requests.delete(controller);
  });
}
function tick() {
  if (!foreground()) return;
  if (pendingPage) { pendingPage = false; lastActive = Date.now(); void send('page'); }
  else if (Date.now() - lastActive >= 60000) { lastActive = Date.now(); void send('active'); }
}
export function startAnalytics(options) {
  if (started) return;
  started = true;
  canTrack = options.canTrack;
  const resume = () => { if (!timer) timer = setInterval(tick, 60000); tick(); };
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
  window.addEventListener('jmw-local-unlocked', tick);
  window.addEventListener('jmw-auth-changed', () => { lastActive = 0; tick(); });
  window.addEventListener('pageshow', resume);
  window.addEventListener('pagehide', () => {
    clearInterval(timer); timer = null;
    for (const controller of requests) controller.abort();
  });
  resume();
}
export function trackPage() { pendingPage = true; tick(); }

export function trackComic(proof, signal) {
  if (!proof || signal?.aborted) return () => {};
  let done = false;
  const cleanup = () => {
    document.removeEventListener('visibilitychange', attempt);
    window.removeEventListener('jmw-local-unlocked', attempt);
    signal?.removeEventListener('abort', cleanup);
  };
  const attempt = () => {
    if (done || signal?.aborted || !foreground()) return;
    done = true;
    cleanup();
    void send('comic', proof, signal);
  };
  document.addEventListener('visibilitychange', attempt);
  window.addEventListener('jmw-local-unlocked', attempt);
  signal?.addEventListener('abort', cleanup, { once: true });
  attempt();
  return cleanup;
}
