// photo.js / md5 客户端算法 单元测试（node test/photo.test.js）
const assert = require('assert');
const { parsePhotoHtml, extractObject, lenientParse } = require('../lib/photo');
const crypto = require('crypto');

// 1) 常规格式
const html1 = "<html><script>const result = { images: ['00001.webp', '00002.webp', '00003.gif'] };\nconst config = { jmid: '340972', imghost: 'https://cdn-msp.example.com', cache: '?v=1' };\nvar aid = 340972; var scramble_id = 220980; var speed = '';</script></html>";
const r1 = parsePhotoHtml(html1);
assert.strictEqual(r1.images.length, 3);
assert.strictEqual(r1.images[2].name, '00003.gif');
assert.strictEqual(r1.images[2].page, '00003');
assert.strictEqual(r1.imghost, 'https://cdn-msp.example.com');
assert.strictEqual(r1.jmid, '340972');
assert.strictEqual(r1.aid, 340972);
assert.strictEqual(r1.scrambleId, 220980);
assert.strictEqual(r1.images[0].url, 'https://cdn-msp.example.com/media/photos/340972/00001.webp?v=1');
console.log('case1 OK');

// 2) 嵌套花括号 / 字符串含逗号和右括号（旧非贪婪正则会在此截断）
const html2 = "const result = { images: ['a.webp'], extra: { nested: 'x,}y' } };";
const o2 = lenientParse(extractObject(html2, 'result'));
assert.ok(o2, 'parse null');
assert.strictEqual(o2.images.length, 1);
assert.strictEqual(o2.extra.nested, 'x,}y');
console.log('case2 OK');

// 3) 无引号键名 + 单引号内含双引号 + 尾逗号
const o3 = lenientParse("{ title: '他说:\"你好\"', list: ['a', 'b',], }");
assert.ok(o3, 'parse null');
assert.ok(o3.title.includes('你好'), JSON.stringify(o3));
assert.strictEqual(o3.list.length, 2);
assert.strictEqual(o3.list[1], 'b');
console.log('case3 OK');

// 4) 解析失败抛错
assert.throws(() => parsePhotoHtml('garbage'), /解析章节 HTML 失败/);
console.log('case4 OK');

// 5) speed
const r5 = parsePhotoHtml("<script>const result = { images: ['1.webp'] }; const config = { jmid: '1', imghost: 'https://x.example' };</script>var speed = '1';");
assert.strictEqual(r5.speed, '1');
console.log('case5 OK');

// 6) 前端 md5 与 Node crypto 一致（含多字节字符）
const md5Src = require('fs').readFileSync('../jm-web/public/js/md5.js', 'utf8');
const md5Module = new Function(md5Src.replace('export function md5', 'function md5') + '; return md5;')();
for (const s of ['34097200001', 'hello', '', '中文测试123', 'a'.repeat(1000)]) {
  assert.strictEqual(md5Module(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), 'md5 mismatch for ' + JSON.stringify(s));
}
console.log('case6 OK (md5)');

console.log('photo/md5 all pass');
