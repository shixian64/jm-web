// 启动失败可见化：模块加载/启动阶段抛错时，把错误显示在启动屏上，避免无声黑屏
// （外置为独立文件以满足 CSP script-src 'self'）
(function () {
  function showBootError(msg) {
    var splash = document.querySelector('.boot-splash');
    if (!splash) return; // 应用已接管页面，忽略后续无关错误
    var box = document.getElementById('boot-err') || document.createElement('div');
    box.id = 'boot-err';
    box.style.cssText = 'margin:16px auto;max-width:640px;padding:12px 16px;background:#3a1e24;color:#ffb4c0;border:1px solid #6b2f3a;border-radius:8px;font:12px/1.6 monospace;word-break:break-all;text-align:left;white-space:pre-wrap';
    if (!box.parentNode) splash.appendChild(box);
    box.textContent += (box.textContent ? '\n' : '') + msg;
  }
  window.addEventListener('error', function (e) {
    if (String(e.filename || '').match(/\/js\//) || !e.filename) {
      showBootError((e.message || '脚本错误') + '  @' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showBootError('REJ: ' + String((r && r.stack) || r).split('\n').slice(0, 3).join('\n'));
  });
})();
