// 仅供同标签页返回导航使用的有界内存缓存；不持久化业务数据或凭据。
export function navigationAbortError() {
  const error = new Error('Navigation cache request cancelled');
  error.name = 'AbortError';
  return error;
}

export function createNavigationCache({ now = Date.now, maxEntries = 48, maxBytes = 8 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const flights = new Map();
  const listeners = new Set();
  let epoch = 0;
  let revision = 0;
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  }

  function get(key, maxAge = Infinity) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.timestamp >= maxAge) { remove(key); return null; }
    entries.delete(key);
    entries.set(key, entry);
    return { value: JSON.parse(entry.json), timestamp: entry.timestamp, revision: entry.revision };
  }

  function put(key, value, { token = epoch, timestamp = now(), expectedRevision } = {}) {
    if (token !== epoch) return null;
    if (expectedRevision !== undefined && entries.get(key)?.revision !== expectedRevision) return null;
    const json = JSON.stringify(value);
    if (!json) return null;
    const size = json.length * 2;
    if (size > maxBytes / 2) { remove(key); return null; }
    remove(key);
    const entry = { json, bytes: size, timestamp, revision: ++revision };
    entries.set(key, entry);
    bytes += size;
    while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    return entry.revision;
  }

  function invalidate(matches = () => true, reason = 'mutation', { abortFlights = true } = {}) {
    epoch++;
    for (const key of entries.keys()) if (matches(key)) remove(key);
    // 旧请求即使无视 abort，也不能在新的认证/变更世代里回填。
    if (abortFlights) for (const flight of flights.values()) flight.controller.abort();
    flights.clear();
    for (const listener of [...listeners]) {
      try { listener(reason); } catch (_) { /* 不让一个视图影响其它缓存订阅者 */ }
    }
  }

  function load(key, loader, signal) {
    if (signal?.aborted) return Promise.reject(navigationAbortError());
    let flight = flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const token = epoch;
      flight = { controller, consumers: new Set(), promise: null };
      const ownFlight = flight;
      flight.promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw navigationAbortError();
        return loader(controller.signal);
      }).then((value) => {
        if (token !== epoch || controller.signal.aborted) throw navigationAbortError();
        return value;
      }).finally(() => {
        if (flights.get(key) === ownFlight) flights.delete(key);
      });
      flights.set(key, flight);
    }
    const ownFlight = flight;
    return new Promise((resolve, reject) => {
      const consumer = {};
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        ownFlight.controller.signal.removeEventListener('abort', cancel);
        ownFlight.consumers.delete(consumer);
        if (!ownFlight.consumers.size) ownFlight.controller.abort();
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(navigationAbortError());
      ownFlight.consumers.add(consumer);
      signal?.addEventListener('abort', cancel, { once: true });
      ownFlight.controller.signal.addEventListener('abort', cancel, { once: true });
      ownFlight.promise.then((value) => finish(null, value), (error) => finish(error));
    });
  }

  async function read(key, loader, {
    signal, freshMs = 60_000, maxAgeMs = 600_000, force = false,
    onUpdate, onError, validate = () => true,
  } = {}) {
    if (signal?.aborted) throw navigationAbortError();
    const hit = force ? null : get(key, maxAgeMs);
    const token = epoch;
    const refresh = async () => {
      const value = await load(key, loader, signal);
      if (!validate(value)) throw new Error('接口返回的数据格式异常');
      if (token !== epoch || signal?.aborted) throw navigationAbortError();
      put(key, value, { token });
      // 返回独立对象；详情视图会修改 is_favorite/liked，不可污染原始缓存。
      return JSON.parse(JSON.stringify(value));
    };
    if (!hit) return refresh();
    if (now() - hit.timestamp >= freshMs) {
      refresh().then((value) => {
        if (!signal?.aborted && token === epoch && JSON.stringify(value) !== JSON.stringify(hit.value)) onUpdate?.(value);
      }).catch((error) => {
        if (!signal?.aborted && error.name !== 'AbortError') onError?.(error);
      });
    }
    return hit.value;
  }

  return {
    get, put, load, read, invalidate,
    token: () => epoch,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
