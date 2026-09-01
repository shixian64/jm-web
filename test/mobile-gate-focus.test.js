'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const gatePath = path.resolve(__dirname, '..', 'public', 'js', 'gate.js');
  const gateUrl = `${pathToFileURL(gatePath).href}?mobile-focus=${Date.now()}`;
  const { shouldAutoFocusPasswordInput, passwordGateInitialFocusTarget } = await import(gateUrl);

  const mediaWindow = (...matchedQueries) => ({
    matchMedia: (query) => ({ matches: matchedQueries.includes(query) }),
  });
  const input = { id: 'input' };
  const dialog = { id: 'dialog' };

  assert.strictEqual(shouldAutoFocusPasswordInput(mediaWindow('(pointer: coarse)')), false,
    '粗指针触屏设备不得自动聚焦密码输入框');
  assert.strictEqual(shouldAutoFocusPasswordInput(mediaWindow('(hover: none)')), false,
    '无悬停能力的移动设备不得自动聚焦密码输入框');
  assert.strictEqual(passwordGateInitialFocusTarget(input, dialog, mediaWindow('(pointer: coarse)')), dialog,
    '移动端初始焦点应落在对话框，避免 iOS 持续显示粘贴浮层');

  const desktop = mediaWindow();
  assert.strictEqual(shouldAutoFocusPasswordInput(desktop), true);
  assert.strictEqual(passwordGateInitialFocusTarget(input, dialog, desktop), input,
    '桌面端应继续支持直接输入口令');

  assert.strictEqual(shouldAutoFocusPasswordInput({}), true,
    '不支持 matchMedia 的旧浏览器保持原有桌面行为');
  assert.strictEqual(shouldAutoFocusPasswordInput({ matchMedia: () => { throw new Error('unsupported'); } }), true,
    '媒体查询异常不得阻断口令门控');

  // 策略函数必须真正接入门禁挂载和下一帧抢焦点路径，防止后续重构又直接
  // 对 password input 调用 focus，导致 iOS 的系统粘贴浮层回归。
  const source = fs.readFileSync(gatePath, 'utf8');
  const mountStart = source.indexOf("if (appRoot) appRoot.setAttribute('inert', '');");
  const mountEnd = source.indexOf('\n  return cleanup;', mountStart);
  assert.ok(mountStart >= 0 && mountEnd > mountStart);
  const mountSource = source.slice(mountStart, mountEnd);
  assert.match(mountSource, /passwordGateInitialFocusTarget\(input, overlay\)/);
  assert.strictEqual((mountSource.match(/initialFocusTarget\.focus\(/g) || []).length, 2,
    '立即挂载和 RAF 竞争处理必须复用同一个触屏安全焦点目标');
  assert.ok(!mountSource.includes('input.focus('), '门禁挂载路径不得绕过移动端焦点策略');
  assert.match(source, /role: 'dialog'.*tabindex: '-1'/,
    '移动端焦点目标 dialog 必须可被程序化聚焦');

  console.log('mobile password gate focus checks pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
