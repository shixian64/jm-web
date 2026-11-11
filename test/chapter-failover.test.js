'use strict';
const assert = require('node:assert/strict');
process.env.JM_TIMEOUT = '120';
process.env.JM_TOTAL_TIMEOUT = '240';
const { upstreamRequest, MAX_API_RESPONSE_BYTES } = require('../lib/jm-api');
const { parsePhotoHtml, MAX_CHAPTER_IMAGES } = require('../lib/photo');
const PRIMARY = 'https://primary.example';
const BACKUP = 'https://backup.example';
const valid = "const result = { images: ['00001.webp'] }; const config = { jmid: '1', imghost: 'https://images.example', cache: '' }; var aid = 1;";
const invalid = '<html><title>Temporarily unavailable</title></html>';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

(async () => {
  for (const firstBody of [valid, invalid, valid.replace("['00001.webp']", JSON.stringify(Array(MAX_CHAPTER_IMAGES + 1).fill('a.webp')))]) {
    const calls = [], accepted = [], cookies = [];
    const trace = {};
    const jar = { cookiesByOrigin: { [PRIMARY]: { AVS: 'primary-fixture' }, [BACKUP]: { AVS: 'backup-fixture' } } };
    const html = await upstreamRequest({
      path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [PRIMARY, BACKUP], jar, trace,
      dnsLookup: publicDns,
      fetchImpl: async (url, opts) => {
        const origin = new URL(url).origin;
        calls.push(origin); cookies.push(opts.headers.Cookie);
        return new Response(origin === PRIMARY ? firstBody : valid);
      },
      onSuccess: meta => { accepted.push(meta.origin); },
    });
    assert.equal(parsePhotoHtml(html).images.length, 1);
    const fallback = firstBody !== valid;
    assert.deepEqual(calls, fallback ? [PRIMARY, BACKUP] : [PRIMARY]);
    assert.deepEqual(accepted, [fallback ? BACKUP : PRIMARY], 'invalid HTML must never mark a host successful');
    assert.deepEqual(cookies, fallback ? ['AVS=primary-fixture', 'AVS=backup-fixture'] : ['AVS=primary-fixture']);
    assert.equal(trace.error_type, '');
    assert.equal(trace.retry_count, fallback ? 1 : 0);
  }

  for (const method of ['GET', 'POST']) {
    let calls = 0, successes = 0;
    const trace = {};
    await assert.rejects(upstreamRequest({
      method, path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [], trace,
      dnsLookup: publicDns, fetchImpl: async () => { calls++; return new Response(invalid); },
      onSuccess: () => { successes++; },
    }), error => error.code === 502);
    assert.equal(calls, method === 'GET' ? 2 : 1);
    assert.equal(successes, 0);
    assert.equal(trace.error_type, 'response');
  }

  // Real resource 404/401 remains terminal, not a line failure.
  for (const status of [401, 404]) {
    let calls = 0;
    await assert.rejects(upstreamRequest({
      path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
      fetchImpl: async () => { calls++; return new Response('missing', { status }); },
    }), error => error.code === status);
    assert.equal(calls, 1);
  }

  // Client cancellation must stop before another host or success callback.
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(upstreamRequest({
    path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
    signal: controller.signal,
    fetchImpl: async () => { calls++; controller.abort(); return new Response(invalid); },
    onSuccess: () => assert.fail('cancelled request accepted'),
  }), error => error.name === 'AbortError');
  assert.equal(calls, 1);

  // Body and time limits still apply before parsing; a good backup may recover.
  calls = 0;
  const recovered = await upstreamRequest({
    path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
    fetchImpl: async () => { calls++; return new Response(calls === 1 ? 'x'.repeat(MAX_API_RESPONSE_BYTES + 1) : valid); },
  });
  assert.equal(recovered, valid);
  assert.equal(calls, 2);
  calls = 0;
  const afterTimeout = await upstreamRequest({
    path: '/chapter_view_template', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
    fetchImpl: async (_url, opts) => {
      calls++;
      if (calls > 1) return new Response(valid);
      return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    },
  });
  assert.equal(afterTimeout, valid);
  assert.equal(calls, 2);

  // A non-JSON comment vote must not be silently replayed across hosts.
  calls = 0;
  await assert.rejects(upstreamRequest({
    method: 'POST', path: '/comment_vote', formEncoding: 'urlencoded', form: [{ name: 'comment_id', value: '1' }],
    hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
    fetchImpl: async () => { calls++; return new Response(invalid); },
  }), error => error.code === 502);
  assert.equal(calls, 1);
  console.log('chapter content failover / cookie isolation / cancellation / limits / POST safety all pass');
})().catch(error => { console.error(error); process.exitCode = 1; });
