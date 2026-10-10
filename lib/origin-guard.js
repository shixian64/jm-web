'use strict';

// 集中同源校验（CSRF）与可信代理解析。
//
// checkSameOrigin：浏览器可达的非幂等 /api/* 路由共用。证据优先级为
// Sec-Fetch-Site > Origin > Referer；三者都缺失时按“无源头”兼容策略放行
// （curl/脚本/老浏览器，认证要求不变；SameSite=Lax Cookie 仍是主防线，
// 见 AGENT.md 第 5 节）。same-site 但不同 origin、Origin: null、
// Sec-Fetch-Site: cross-site/same-site 一律拒绝。
//
// createProxyTrust：JMW_TRUST_PROXY 的精确 IP/CIDR 信任模型。只有对端是
// 环回或显式配置的代理时才解析 X-Forwarded-For / X-Forwarded-Proto；
// 不可信对端自带的转发头不改变 clientIp 与 secure 判定。绝不默认信任
// 整个私网段（那样会让任何能接入网桥的容器伪造来源）。

const net = require('net');

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  // Node 在双栈 socket 上常以 ::ffff:192.0.2.1 表示 IPv4。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && net.isIP(mapped[1]) === 4) ip = mapped[1];
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

function isLoopbackIp(ip) {
  if (net.isIP(ip) === 4) return ip.split('.')[0] === '127';
  return ip === '::1';
}

function createProxyTrust({ trustProxy = '', onInvalidRule } = {}) {
  const trustedProxyBlockList = new net.BlockList();

  function addTrustedProxyRule(rule) {
    const slash = rule.lastIndexOf('/');
    const rawIp = slash === -1 ? rule : rule.slice(0, slash);
    const ip = normalizeIp(rawIp);
    if (!ip) return false;
    const family = net.isIP(ip);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    try {
      if (slash === -1) {
        trustedProxyBlockList.addAddress(ip, type);
        return true;
      }
      const prefixText = rule.slice(slash + 1);
      if (!/^\d+$/.test(prefixText)) return false;
      const prefix = Number(prefixText);
      if (prefix < 0 || prefix > (family === 6 ? 128 : 32)) return false;
      trustedProxyBlockList.addSubnet(ip, prefix, type);
      return true;
    } catch (_) {
      return false;
    }
  }

  for (const rawRule of String(trustProxy).split(',')) {
    const rule = rawRule.trim();
    if (rule && !addTrustedProxyRule(rule) && typeof onInvalidRule === 'function') {
      onInvalidRule(rule);
    }
  }

  function isTrustedProxyIp(ip) {
    const family = net.isIP(ip);
    if (!family) return false;
    return isLoopbackIp(ip) || trustedProxyBlockList.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  }

  function clientIp(req) {
    let current = normalizeIp(req.socket.remoteAddress) || 'unknown';
    if (!isTrustedProxyIp(current)) return current;

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !forwarded.trim()) return current;
    const parts = forwarded.split(',');
    // 限制链长，且任一 token 不是纯 IP 时整个头都不采信。
    if (parts.length > 32) return current;
    const chain = parts.map(normalizeIp);
    if (chain.some((ip) => !ip)) return current;

    // 从最靠近应用的一跳开始剥离可信代理，第一个非可信 IP 即客户。
    for (let i = chain.length - 1; i >= 0 && isTrustedProxyIp(current); i--) {
      current = chain[i];
    }
    return current;
  }

  function requestIsSecure(req) {
    if (req.socket && req.socket.encrypted) return true;
    const peer = normalizeIp(req.socket && req.socket.remoteAddress);
    if (!peer || !isTrustedProxyIp(peer)) return false;
    const forwarded = req.headers && req.headers['x-forwarded-proto'];
    if (typeof forwarded !== 'string') return false;
    // 反代必须覆盖而不是追加该头；拒绝含逗号的歧义链，避免客户端伪造首项。
    return forwarded.trim().toLowerCase() === 'https';
  }

  return { isTrustedProxyIp, clientIp, requestIsSecure };
}

// 解析来源头为 origin 字符串；'null'（沙箱/重定向跨源）与非法值单独标记。
function parseOriginValue(value) {
  if (typeof value !== 'string' || !value.trim()) return 'absent';
  if (value.trim().toLowerCase() === 'null') return 'null';
  try {
    return new URL(value.trim()).origin;
  } catch (_) {
    return 'invalid';
  }
}

function expectedOrigin(scheme, host) {
  if (typeof host !== 'string' || !host.trim() || host.includes(',')) return '';
  try {
    return new URL(`${scheme === 'https' ? 'https' : 'http'}://${host.trim()}`).origin;
  } catch (_) {
    return '';
  }
}

/**
 * 同源判定。入参：请求头、期望 scheme（由可信代理解析得到的 http/https）、
 * 请求 Host 头。返回 { ok, reason }；reason 供诊断日志（不回显给浏览器）。
 */
function checkSameOrigin({ headers = {}, scheme = 'http', host = '' }) {
  const expected = expectedOrigin(scheme, host);

  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    const site = String(fetchSite).trim().toLowerCase();
    if (site === 'cross-site') return { ok: false, reason: 'sec_fetch_cross_site' };
    if (site === 'same-site') return { ok: false, reason: 'sec_fetch_same_site_other_origin' };
    // same-origin / none 交给来源头继续核对（双证据一致才放行）。
  }

  const origin = parseOriginValue(headers.origin);
  if (origin !== 'absent') {
    if (origin === 'null') return { ok: false, reason: 'origin_null' };
    if (origin === 'invalid') return { ok: false, reason: 'origin_invalid' };
    if (!expected) return { ok: false, reason: 'host_invalid' };
    if (origin !== expected) return { ok: false, reason: 'origin_mismatch' };
    // Origin 与 Referer 同时存在时必须同源：矛盾元数据说明请求并非来自
    // 正常浏览器上下文，不能因为 Origin 单独匹配就放行。
    const referer = parseOriginValue(headers.referer);
    if (referer !== 'absent' && referer !== origin) {
      return { ok: false, reason: 'origin_referer_conflict' };
    }
    return { ok: true, reason: 'origin' };
  }

  const referer = parseOriginValue(headers.referer);
  if (referer !== 'absent') {
    if (referer === 'null' || referer === 'invalid') return { ok: false, reason: 'referer_invalid' };
    if (!expected) return { ok: false, reason: 'host_invalid' };
    if (referer !== expected) return { ok: false, reason: 'referer_mismatch' };
    return { ok: true, reason: 'referer' };
  }

  // 无任何来源证据（curl/脚本/极老浏览器）：兼容放行，认证要求不变。
  return { ok: true, reason: 'no_source_evidence' };
}

module.exports = {
  createProxyTrust,
  checkSameOrigin,
  normalizeIp,
  isLoopbackIp,
};
