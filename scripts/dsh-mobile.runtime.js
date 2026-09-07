/*!
 * dsh-mobile.runtime.js — DSH Web 移动端适配运行时
 * 由 scripts/dsh-mobile-patch.js 安装到前端 dist；仅窄屏（<=700px）生效。
 * 结构化定位布局节点（data-* 标记），不依赖构建哈希类名，升级后重打补丁即可。
 */
(function () {
  'use strict';
  if (window.__DSH_MOBILE__) return;
  window.__DSH_MOBILE__ = true;

  var MOBILE_MAX = 700;        // 窄屏断点
  var DRAWER_MIN = 120;        // 第一列超过该宽度视为“侧边栏展开”
  var DETAILS_MIN = 40;        // 第三列超过该宽度视为“详情面板打开”

  var doc = document;
  var root = doc.documentElement;

  /* ---------------- 样式 ---------------- */
  var CSS = [
    '#dsh-mobile-scrim{position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.32);',
      'display:none;-webkit-tap-highlight-color:transparent;}',
    'html[data-dsh-mobile-drawer] #dsh-mobile-scrim,',
    'html[data-dsh-mobile-details] #dsh-mobile-scrim{display:block;}',
    '@media (max-width:' + MOBILE_MAX + 'px){',
      /* 布局列改由适配层接管：显式落轨，展开的列不占轨道、改为悬浮 */
      'html[data-dsh-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-sidebar]{grid-column:1;}',
      'html[data-dsh-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-center]{grid-column:2;}',
      'html[data-dsh-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-detailscol]{grid-column:3;}',
      'html[data-dsh-mobile] [data-dsh-mobile-frame]{',
        'grid-template-columns:var(--dsh-mc1,56px) minmax(0px,1fr) var(--dsh-mc3,0px) !important;}',
      'html[data-dsh-mobile-drawer] [data-dsh-mobile-sidebar]{',
        'position:absolute;top:0;bottom:0;left:0;width:min(82vw,300px) !important;',
        'z-index:901;box-shadow:0 0 28px rgba(0,0,0,.28);}',
      'html[data-dsh-mobile-details] [data-dsh-mobile-detailscol]{',
        'position:absolute;top:0;bottom:0;right:0;width:min(94vw,440px) !important;',
        'z-index:901;box-shadow:0 0 28px rgba(0,0,0,.28);}',
      /* 弹窗钳制在视口内 */
      '[class*="overlay"] > [class*="panel"],[role="dialog"],dialog{',
        'max-width:calc(100vw - 16px) !important;max-height:calc(100dvh - 16px);}',
      /* 安全区与触控舒适度 */
      '[class*="composerSeat"]{padding-bottom:max(8px,env(safe-area-inset-bottom)) !important;}',
      '[class*="header"] [class*="tabs"]{overflow-x:auto;scrollbar-width:none;}',
      '[class*="centerCol"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]){',
        'font-size:16px !important;}',
      'img,video{max-width:100%;}',
      'html[data-dsh-mobile] body{overflow-x:hidden;}',
    '}'
  ].join('\n');

  var style = doc.createElement('style');
  style.id = 'dsh-mobile-style';
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);

  var scrim = doc.createElement('div');
  scrim.id = 'dsh-mobile-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  (doc.body || doc.documentElement).appendChild(scrim);

  /* ---------------- 布局发现 ---------------- */
  var frame = null, sidebar = null, center = null, details = null;
  var lastTracks = { c1: -1, c3: -1 };
  var applied = { drawer: false, det: false, mc1: false, mc3: false };

  function findFrame() {
    var all = doc.querySelectorAll('div[style*="grid-template-columns"]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length >= 3 && el.querySelector('textarea, [class*="composer"]')) {
        frame = el;
        sidebar = el.children[0];
        center = el.children[1];
        details = el.children[2];
        frame.setAttribute('data-dsh-mobile-frame', '');
        if (sidebar) sidebar.setAttribute('data-dsh-mobile-sidebar', '');
        if (center) center.setAttribute('data-dsh-mobile-center', '');
        if (details) details.setAttribute('data-dsh-mobile-detailscol', '');
        return true;
      }
    }
    return false;
  }

  function parseTracks(tpl) {
    var m1 = /^\s*([\d.]+)px/.exec(tpl);
    var m3 = /([\d.]+)px\s*$/.exec(tpl);
    return { c1: m1 ? parseFloat(m1[1]) : 0, c3: m3 ? parseFloat(m3[1]) : 0 };
  }

  function isMobile() { return window.innerWidth <= MOBILE_MAX; }

  /* React 写回的内联网格列 → 生成窄屏下的等效布局 */
  function sync() {
    if (!frame || !frame.isConnected) {
      frame = null;
      if (!findFrame()) return;
    }
    var mobile = isMobile();
    if (mobile) root.setAttribute('data-dsh-mobile', ''); else root.removeAttribute('data-dsh-mobile');

    if (!mobile) {
      if (applied.mc1) { frame.style.removeProperty('--dsh-mc1'); applied.mc1 = false; }
      if (applied.mc3) { frame.style.removeProperty('--dsh-mc3'); applied.mc3 = false; }
      root.removeAttribute('data-dsh-mobile-drawer');
      root.removeAttribute('data-dsh-mobile-details');
      applied.drawer = applied.det = false;
      lastTracks = { c1: -1, c3: -1 };
      return;
    }

    var tpl = frame.style.gridTemplateColumns || '';
    if (!tpl) return;
    var t = parseTracks(tpl);
    if (t.c1 === lastTracks.c1 && t.c3 === lastTracks.c3) return; // 无变化（含本适配层自身写入）
    lastTracks = t;

    var drawer = t.c1 > DRAWER_MIN;
    var det = t.c3 > DETAILS_MIN;

    if (drawer) root.setAttribute('data-dsh-mobile-drawer', ''); else root.removeAttribute('data-dsh-mobile-drawer');
    if (det) root.setAttribute('data-dsh-mobile-details', ''); else root.removeAttribute('data-dsh-mobile-details');
    applied.drawer = drawer; applied.det = det;

    if (drawer !== applied.mc1) {
      if (drawer) frame.style.setProperty('--dsh-mc1', '0px'); else frame.style.removeProperty('--dsh-mc1');
      applied.mc1 = drawer;
    }
    if (det !== applied.mc3) {
      if (det) frame.style.setProperty('--dsh-mc3', '0px'); else frame.style.removeProperty('--dsh-mc3');
      applied.mc3 = det;
    }
  }

  /* ---------------- 抽屉关闭 ---------------- */
  function sidebarToggle() {
    if (!sidebar) return null;
    var btns = sidebar.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = b.getAttribute('aria-label') || b.title || '';
      if (/侧边栏|sidebar/i.test(label)) return b;
    }
    return null;
  }

  function pressEscape() {
    var target = doc.activeElement || doc.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }

  scrim.addEventListener('click', function () {
    if (applied.drawer) {
      var btn = sidebarToggle();
      if (btn) btn.click(); else pressEscape();
    } else if (applied.det) {
      pressEscape();
    }
  });

  /* ---------------- 观察者 ---------------- */
  var t1 = null;
  function debounce(fn) {
    return function () {
      clearTimeout(t1);
      t1 = setTimeout(fn, 60);
    };
  }
  var syncSoon = debounce(sync);

  var styleObserver = new MutationObserver(syncSoon);

  var bodyObserver = new MutationObserver(function () {
    if (!frame || !frame.isConnected) syncSoon();
  });
  bodyObserver.observe(doc.body || doc.documentElement, { childList: true, subtree: true });

  function attach() {
    if (frame) styleObserver.observe(frame, { attributes: true, attributeFilter: ['style'] });
  }

  var tries = 0;
  (function boot() {
    if (findFrame()) { sync(); attach(); return; }
    if (tries++ < 200) setTimeout(boot, 100);
  })();

  window.addEventListener('resize', syncSoon);
  sync();
})();
