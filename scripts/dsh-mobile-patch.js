#!/usr/bin/env node
/**
 * dsh-mobile-patch.js — 为 DSH Web GUI 注入移动端适配层
 *
 * 作用：
 *   1. 把移动端运行时 (CSS + JS) 写入 DSH 前端 dist 目录（dsh-mobile.js）
 *   2. 在 dist/index.html 注入 <script src="/dsh-mobile.js"> 与 viewport-fit=cover
 *
 * 特性（仅窄屏 <=700px 生效，桌面端零影响）：
 *   - 侧边栏展开时变为悬浮抽屉（不再把会话区挤成一条缝）
 *   - 右侧详情面板同样抽屉化，从右侧滑出
 *   - 遮罩层点击关闭抽屉；对话输入区适配 iPhone 安全区
 *   - 弹窗/面板宽度钳制到视口内，杜绝横向溢出
 *   - 输入框字号 >=16px，避免 iOS 聚焦自动放大
 *
 * 用法：
 *   node scripts/dsh-mobile-patch.js            # 安装 / 更新补丁
 *   node scripts/dsh-mobile-patch.js --restore  # 卸载补丁，还原 index.html
 *
 * 注意：DSH 通过 npm 升级后 dist 会被覆盖，重新运行本脚本即可恢复适配。
 *      安装后刷新浏览器页面即可生效，无需重启 DSH。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RESTORE = process.argv.includes('--restore');
const MARKER = 'dsh-mobile.js';
const RUNTIME_FILE = path.join(__dirname, 'dsh-mobile.runtime.js');

function candidateDistDirs() {
  const list = [];
  if (process.env.DSH_FRONTEND_DIST) list.push(process.env.DSH_FRONTEND_DIST);
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    list.push(path.join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'));
  } catch (_) { /* npm 不可用时忽略 */ }
  list.push(
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist',
  );
  const extra = process.argv.find((a, i) => process.argv[i - 1] === '--dist');
  if (extra) list.unshift(extra);
  return list;
}

function findDist() {
  for (const dir of candidateDistDirs()) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  console.error('未找到 DSH 前端 dist（含 index.html）。可用 --dist <路径> 指定。');
  process.exit(1);
}

const dist = findDist();
const indexPath = path.join(dist, 'index.html');
const runtimePath = path.join(dist, MARKER);
let html = fs.readFileSync(indexPath, 'utf8');

if (RESTORE) {
  let changed = false;
  if (html.includes(MARKER)) {
    html = html.replace(/\s*<script[^>]*src="\/dsh-mobile\.js"[^>]*><\/script>/i, '');
    changed = true;
  }
  const before = html;
  html = html.replace(', viewport-fit=cover', '');
  if (before !== html) changed = true;
  if (changed) fs.writeFileSync(indexPath, html);
  if (fs.existsSync(runtimePath)) fs.unlinkSync(runtimePath);
  console.log('已还原：', indexPath);
  process.exit(0);
}

// ---- 1. 写入运行时 ----
const runtime = fs.readFileSync(RUNTIME_FILE, 'utf8');
fs.writeFileSync(runtimePath, runtime);

// ---- 2. 修改 index.html ----
if (!html.includes(MARKER)) {
  html = html.replace(/<\/head>/i, '    <script src="/dsh-mobile.js" defer></script>\n  </head>');
}
if (!/viewport-fit=cover/.test(html)) {
  html = html.replace(
    /(<meta name="viewport" content="[^"]*)"/i,
    '$1, viewport-fit=cover"',
  );
}
fs.writeFileSync(indexPath, html);

console.log('移动端适配已安装：');
console.log('  +', runtimePath);
console.log('  ~', indexPath);
console.log('刷新 DSH 网页（http://127.0.0.1:3080）即可生效。');
