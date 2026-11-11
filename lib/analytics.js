'use strict';
// 独立于 AI 的有界近期统计。仅存 HMAC 标识，公开接口只返回汇总。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DAY = 86400000;
const RETENTION_DAYS = 30;
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[au]:[A-Za-z0-9_-]{43}$/;
const AID = /^[1-9]\d{0,15}$/;
const dayKey = (now) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const text = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '';
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const safe = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

class Analytics {
  constructor({ dataDir, secret, now = Date.now, maxBytes = MAX_BYTES, warn = () => {} }) {
    this.file = path.join(dataDir, 'analytics', 'state.json');
    this.key = crypto.createHmac('sha256', secret).update('jmw-analytics-v1').digest();
    this.now = now;
    this.maxBytes = maxBytes;
    this.warn = warn;
    this.available = true;
    this.persistenceOk = true;
    this.timer = null;
    this.flight = null;
    this.closed = false;
    this.version = 0;
    this.savedVersion = 0;
    this.recent = new Map();
    this.cache = new Map();
    this.state = { version: 1, startedAt: this.now(), days: {} };
    try {
      const stat = fs.statSync(this.file);
      if (stat.size > maxBytes) throw new Error('analytics state exceeds limit');
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.validate(loaded);
      this.state = loaded;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.available = false;
        this.persistenceOk = false;
        warn('[analytics] 状态无效，已停止采集并保留原文件');
      }
    }
    this.prune();
    this.recount();
    if (this.budget > maxBytes) { this.available = false; warn('[analytics] 状态超过当前容量预算，停止采集并保留原文件'); }
    this.maintenance = setInterval(() => this.prune(), 3600000);
    this.maintenance.unref?.();
  }

  hash(domain, value) { return crypto.createHmac('sha256', this.key).update(`${domain}:${value}`).digest('base64url'); }
  visitor(cookie) {
    if (typeof cookie === 'string' && /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(cookie)) {
      const [id, mac] = cookie.split('.');
      if (safe(mac, this.hash('cookie', id))) return { id, cookie, fresh: false };
    }
    const id = crypto.randomBytes(24).toString('base64url');
    return { id, cookie: `${id}.${this.hash('cookie', id)}`, fresh: true };
  }
  actor(visitorId, uid) { return `${uid ? 'u' : 'a'}:${this.hash(uid ? 'account' : 'anonymous', uid || visitorId)}`; }

  proof(visitorId, aid, title = '') {
    aid = String(aid || '');
    if (!AID.test(aid)) return '';
    title = text(title);
    // 后台取元数据不计访问，但可补齐已存在榜单的标题。
    if (this.available && title) {
      let changed = false;
      for (const day of Object.values(this.state.days)) {
        if (day.comics[aid] && day.comics[aid].title !== title) { day.comics[aid].title = title; changed = true; }
      }
      if (changed) this.changed();
    }
    const body = Buffer.from(JSON.stringify({ aid, title, visitor: this.hash('proof-visitor', visitorId), expires: this.now() + 15 * 60000 })).toString('base64url');
    return `${body}.${this.hash('proof', body)}`;
  }
  verifyProof(proof, visitorId) {
    if (typeof proof !== 'string' || proof.length > 2500) return null;
    const [body, mac, extra] = proof.split('.');
    if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body || '') || !safe(mac, this.hash('proof', body))) return null;
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!AID.test(value.aid) || value.visitor !== this.hash('proof-visitor', visitorId)
          || !Number.isSafeInteger(value.expires) || value.expires <= this.now() || value.expires > this.now() + 15 * 60000) return null;
      return { aid: value.aid, title: text(value.title) };
    } catch (_) { return null; }
  }

  validate(state) {
    if (!plain(state) || state.version !== 1 || !Number.isSafeInteger(state.startedAt) || state.startedAt < 0
        || !plain(state.days) || Object.keys(state.days).length > RETENTION_DAYS) throw new Error('invalid state');
    const pair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isSafeInteger(n) && n >= 0);
    for (const [date, day] of Object.entries(state.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > dayKey(this.now()) || !plain(day)
          || !plain(day.users) || !plain(day.comics) || typeof day.limited !== 'boolean') throw new Error('invalid day');
      for (const [id, value] of Object.entries(day.users)) if (!ID.test(id) || !pair(value)) throw new Error('invalid user');
      for (const [aid, comic] of Object.entries(day.comics)) {
        if (!AID.test(aid) || !plain(comic) || typeof comic.title !== 'string' || comic.title !== text(comic.title) || !plain(comic.users)) throw new Error('invalid comic');
        for (const [id, value] of Object.entries(comic.users)) {
          if (!ID.test(id) || !pair(value) || !day.users[id]) throw new Error('invalid reader');
        }
      }
    }
    // 不接受未知字段；防止未验证的大块数据占用后续持久化预算。
    if (Object.keys(state).sort().join(',') !== 'days,startedAt,version') throw new Error('invalid fields');
    for (const day of Object.values(state.days)) {
      if (Object.keys(day).sort().join(',') !== 'comics,limited,users') throw new Error('invalid fields');
      for (const comic of Object.values(day.comics)) if (Object.keys(comic).sort().join(',') !== 'title,users') throw new Error('invalid fields');
    }
  }
  recount() {
    // 保守预留：每个标识/计数 128B、每部标题/容器 2048B；包括 JSON 转义和逗号。
    // 为全部 30 天的容器/告警预留固定空间，满容量后跨日仍可标记不完整。
    this.budget = 4096;
    for (const day of Object.values(this.state.days)) {
      this.budget += Object.keys(day.users).length * 128;
      for (const comic of Object.values(day.comics)) this.budget += 2048 + Object.keys(comic.users).length * 128;
    }
  }
  prune() {
    if (!this.available) return;
    const cutoff = dayKey(this.now() - (RETENTION_DAYS - 1) * DAY);
    let changed = false;
    for (const date of Object.keys(this.state.days)) if (date < cutoff) { delete this.state.days[date]; changed = true; }
    if (changed) { this.recount(); this.changed(); }
  }
  changed() {
    this.version++;
    this.cache.clear();
    if (!this.closed && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 10000);
      this.timer.unref?.();
    }
  }
  promote(anonymous, account) {
    let changed = false;
    const move = (users) => {
      const old = users[anonymous];
      if (!old) return;
      const current = users[account];
      users[account] = current ? [Math.max(old[0], current[0]), old[1] + current[1]] : old;
      delete users[anonymous];
      changed = true;
    };
    for (const day of Object.values(this.state.days)) {
      if (!day.users[anonymous]) continue;
      move(day.users);
      for (const comic of Object.values(day.comics)) move(comic.users);
    }
    if (changed) { this.recount(); this.changed(); }
  }
  record({ visitorId, uid = '', kind, comic = null }) {
    if (!this.available || this.closed || this.closing || !['active', 'page', 'comic'].includes(kind)) return false;
    this.prune();
    const now = this.now();
    const actor = this.actor(visitorId, uid);
    if (uid) this.promote(this.actor(visitorId), actor);
    const date = dayKey(now);
    let day = this.state.days[date];
    if (!day) { day = this.state.days[date] = { users: {}, comics: {}, limited: false }; }
    const aid = kind === 'comic' && comic && AID.test(comic.aid) ? comic.aid : '';
    const entry = aid ? day.comics[aid] : null;
    const needed = (!day.users[actor] ? 128 : 0) + (aid ? (!entry ? 2048 : 0) + (!entry?.users[actor] ? 128 : 0) : 0);
    if (this.budget + needed > this.maxBytes) {
      if (!day.limited) { day.limited = true; this.changed(); }
      return false; // 不静默淘汰已有 UV；明确显示统计不完整。
    }
    this.budget += needed;
    const user = day.users[actor] ||= [now, 0];
    user[0] = now;
    // 重复埋点抑制有界且不落盘；UV 始终由每日标识集合精确去重。
    const key = `${date}:${actor}:${aid || kind}`;
    const previous = this.recent.get(key);
    const count = previous === undefined || now - previous >= (aid ? 30000 : 3000);
    if (kind !== 'active' && count) {
      this.recent.delete(key);
      this.recent.set(key, now);
      while (this.recent.size > 10000) this.recent.delete(this.recent.keys().next().value);
    }
    if (kind === 'page' && count) user[1]++;
    if (aid) {
      const item = day.comics[aid] ||= { title: '', users: {} };
      if (comic.title) item.title = text(comic.title);
      const reader = item.users[actor] ||= [now, 0];
      reader[0] = now;
      if (count) reader[1]++;
    }
    this.changed();
    return true;
  }
  summary(days = 7) {
    this.prune();
    const now = this.now();
    const today = dayKey(now);
    const cached = this.cache.get(days);
    if (cached && cached.today === today && now - cached.at < 5000) return cached.data;
    const users = new Set(), readers = new Set(), comics = new Map(), trend = [];
    let pageViews = 0, comicViews = 0, limited = false;
    for (let i = days - 1; i >= 0; i--) {
      const date = dayKey(now - i * DAY);
      const day = this.available ? this.state.days[date] : null;
      const dailyUsers = Object.keys(day?.users || {});
      let pv = 0;
      for (const id of dailyUsers) { users.add(id); pv += day.users[id][1]; }
      pageViews += pv;
      limited ||= day?.limited === true;
      for (const [aid, item] of Object.entries(day?.comics || {})) {
        let total = comics.get(aid);
        if (!total) { total = { aid, title: '', users: new Set(), views: 0 }; comics.set(aid, total); }
        if (item.title) total.title = item.title;
        for (const [id, value] of Object.entries(item.users)) {
          total.users.add(id); readers.add(id); total.views += value[1]; comicViews += value[1];
        }
      }
      trend.push({ date, users: dailyUsers.length, accounts: dailyUsers.filter((id) => id.startsWith('u:')).length, pageViews: pv });
    }
    const accounts = [...users].filter((id) => id.startsWith('u:')).length;
    const ranking = [...comics.values()].map((v) => ({ aid: v.aid, title: v.title || `漫画 ${v.aid}`, users: v.users.size, views: v.views }))
      .sort((a, b) => b.users - a.users || b.views - a.views || a.aid.localeCompare(b.aid, 'en'));
    const data = { available: this.available, persistenceOk: this.persistenceOk, limited, startedAt: this.state.startedAt,
      generatedAt: now, timezone: 'Asia/Shanghai', days, from: trend[0].date, to: today,
      totals: { users: users.size, accounts, anonymous: users.size - accounts, pageViews, comicUsers: readers.size, comics: comics.size, comicViews }, trend, ranking };
    this.cache.set(days, { today, at: now, data });
    return data;
  }
  serialize() {
    const data = JSON.stringify(this.state);
    if (Buffer.byteLength(data) > this.maxBytes) throw new Error('analytics byte budget exceeded');
    return data;
  }
  async flush() {
    if (this.closed || !this.available || this.savedVersion === this.version) return;
    if (this.flight) return this.flight;
    const version = this.version;
    const tmp = `${this.file}.${process.pid}.${version}.tmp`;
    this.flight = (async () => {
      try {
        const data = this.serialize();
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(tmp, data, { mode: 0o600 });
        if (this.closed) return;
        await fs.promises.rename(tmp, this.file);
        this.savedVersion = version;
        this.persistenceOk = true;
      } catch (_) {
        this.persistenceOk = false;
        this.warn('[analytics] 保存失败，保留旧文件并稍后重试');
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
        this.flight = null;
        this.cache.clear();
        if (!this.closed && this.savedVersion !== this.version && !this.timer) {
          this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 10000);
          this.timer.unref?.();
        }
      }
    })();
    return this.flight;
  }
  async close() {
    this.closing = true;
    clearInterval(this.maintenance);
    clearTimeout(this.timer); this.timer = null;
    if (this.flight) await this.flight;
    await this.flush();
    this.closed = true;
    clearTimeout(this.timer); this.timer = null;
  }
}
module.exports = { Analytics, dayKey, MAX_BYTES, RETENTION_DAYS };
