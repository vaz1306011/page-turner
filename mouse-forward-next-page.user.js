// ==UserScript==
// @name         滑鼠側鍵「下一頁」自動翻頁
// @namespace    local.mouse-forward-next
// @version      1.2.3
// @updateURL    https://raw.githubusercontent.com/vaz1306011/mouse-forward-next/main/mouse-forward-next-page.user.js
// @downloadURL  https://raw.githubusercontent.com/vaz1306011/mouse-forward-next/main/mouse-forward-next-page.user.js
// @description  沒有可前進的歷史紀錄時,按滑鼠側鍵「下一頁」會自動跳到網頁的下一頁
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const FORWARD_BUTTON = 4; // 滑鼠側鍵:3 = 上一頁, 4 = 下一頁

  const NEXT_TEXT = /^(下一頁|下一页|下頁|下页|下一章|下一篇|下一話|下一话|下一節|下一节|後一頁|后一页|next|next page|next »|older|older posts|›|»|>|>>|→|▶|‹?\s*次へ|次のページ)$/i;

  // ---------- 是否還有「下一頁」的瀏覽紀錄 ----------
  function canGoForward() {
    // Chrome 102+ / Edge 的 Navigation API
    if (window.navigation && typeof navigation.canGoForward === 'boolean') {
      return navigation.canGoForward;
    }
    return false; // 無法判斷時,視為沒有(Firefox 會走這裡)
  }

  // ---------- 找下一頁連結 ----------
  function isUsable(a) {
    if (!a || !a.href) return false;
    if (a.getAttribute('href') === '#' || a.href.startsWith('javascript:')) return false;
    if (a.href.split('#')[0] === location.href.split('#')[0]) return false;
    return true;
  }

  function findNextByRel() {
    return document.querySelector('link[rel~="next"][href], a[rel~="next"][href]');
  }

  function findNextByText() {
    const anchors = document.querySelectorAll('a[href], button');
    for (const el of anchors) {
      const label = [
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ];
      for (const t of label) {
        if (t && NEXT_TEXT.test(t.trim())) {
          if (el.tagName === 'A' && !isUsable(el)) continue;
          return el;
        }
      }
    }
    return null;
  }

  function findNextByClass() {
    return document.querySelector(
      'a.next, a.nextpage, a.next-page, a.page-next, a.pagination-next, ' +
      '.next > a, .next-page > a, li.next a, .pagination .next a, #pnnext, a[id*="next" i][href]'
    );
  }

  // 目前頁碼(.active / .current / aria-current)的下一個兄弟
  function findNextByCurrent() {
    const cur = document.querySelector(
      '.pagination .active, .pager .active, .pagination .current, .pager .current, ' +
      '.page-numbers.current, [aria-current="page"], .pagenavi .current, .page .current'
    );
    // 必須在分頁區塊內,避免誤抓到導覽分頁籤(例如 GitHub 的 Repositories 分頁籤)
    if (!cur || !cur.closest('.pagination, .pager, .pagenavi, .page-numbers, [class*="pagination" i], nav[aria-label*="pagination" i]')) return null;
    let node = cur.closest('li') || cur;
    for (let n = node.nextElementSibling; n; n = n.nextElementSibling) {
      const a = n.tagName === 'A' ? n : n.querySelector('a[href]');
      if (a && isUsable(a) && /^\d+$/.test(a.textContent.trim())) return a;
    }
    return null;
  }

  // 純按鈕式分頁(SPA,例如 BepisDB):目前頁按鈕(.active / aria-current)的下一個數字按鈕。
  // 直接點它只會換內容,比整頁重新載入快
  function findNextByActiveButton() {
    for (const cur of document.querySelectorAll('button.active, button[aria-current], button[aria-pressed="true"]')) {
      const curNum = parseInt(cur.textContent.trim(), 10);
      if (isNaN(curNum) || !/^\d+$/.test(cur.textContent.trim())) continue;
      // 同一排至少要有 3 個數字按鈕,避免誤抓到一般的切換按鈕
      const nums = [...cur.parentElement.children].filter(b => /^\d+$/.test(b.textContent.trim()));
      if (nums.length < 3) continue;
      const next = nums.find(b => parseInt(b.textContent.trim(), 10) === curNum + 1);
      if (next) return next;
    }
    return null;
  }

  // 由網址推算:?page=N / &p=N / /page/N / 結尾數字
  function guessNextUrl() {
    const url = new URL(location.href);
    for (const key of ['page', 'p', 'pn', 'paged', 'pageNum', 'pageno', 'pg']) {
      if (url.searchParams.has(key)) {
        const n = parseInt(url.searchParams.get(key), 10);
        if (!isNaN(n)) {
          url.searchParams.set(key, String(n + 1));
          return url.href;
        }
      }
    }
    // 只認明確的分頁路徑(/page/N、/p/N);不能用「結尾數字 +1」,
    // 否則像 pixiv 的 /artworks/123 這種作品 ID 會跳到不相干的內容
    const m = url.pathname.match(/^(.*\/(?:page|p)\/)(\d+)(\/?)$/i);
    if (m) {
      url.pathname = m[1] + (parseInt(m[2], 10) + 1) + (m[3] || '');
      return url.href;
    }
    return null;
  }

  // 連結或其外層是否被停用(最後一頁時,「下一頁」通常會變成停用狀態)
  function isDisabled(el) {
    for (let n = el, i = 0; n && i < 2; n = n.parentElement, i++) {
      if (n.disabled || n.getAttribute('aria-disabled') === 'true') return true;
      if (/(^|[\s_-])(disabled|inactive|is-disabled)([\s_-]|$)/i.test(n.className || '')) return true;
    }
    return false;
  }

  // 驗證猜出來的網址:不存在(404)或被導回原頁就當作已是最後一頁
  async function guessExists(guess) {
    try {
      const res = await fetch(guess, { credentials: 'include' });
      if (!res.ok) return false;
      const strip = u => u.split('#')[0];
      if (strip(res.url) === strip(location.href)) return false;
      return true;
    } catch (e) {
      return false; // 跨網域或網路錯誤:保守起見不跳轉
    }
  }

  // 找「頁碼參數 = 目前頁 + 1」的連結(pixiv 這類 class 被雜湊、按鈕只有圖示的網站)
  const PAGE_KEYS = ['p', 'page', 'pn', 'paged', 'pageNum', 'pageno', 'pg'];
  function findNextByPageParam() {
    const cur = new URL(location.href);
    let key = PAGE_KEYS.find(k => cur.searchParams.has(k));
    const curNum = key ? parseInt(cur.searchParams.get(key), 10) : 1;
    if (isNaN(curNum)) return null;
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href, location.href); } catch (e) { continue; }
      if (u.origin !== cur.origin || u.pathname !== cur.pathname) continue;
      const k = key || PAGE_KEYS.find(x => u.searchParams.has(x));
      if (!k) continue;
      const n = parseInt(u.searchParams.get(k), 10);
      // 頁碼等於目前頁的連結(例如卡片連結 ?page=6#)不算分頁連結
      if (isNaN(n) || n === curNum) continue;
      paginationSeen = true; // 頁面上有分頁連結
      if (n === curNum + 1) return a;
    }
    return null;
  }

  // 回傳:true = 已觸發翻頁;false = 已是最後一頁/找不到;Promise = 非同步驗證網址猜測
  let paginationSeen = false;
  // 找出下一頁元素;回傳 { el, last }:last = true 表示已確定是最後一頁
  function findNextEl() {
    paginationSeen = false;
    const finders = [findNextByRel, findNextByPageParam, findNextByClass, findNextByText, findNextByCurrent, findNextByActiveButton];
    let sawDisabled = false;
    for (const find of finders) {
      const el = find();
      // 頁面有頁碼連結,卻沒有「目前頁 + 1」 → 已是最後一頁,不再用其他方式猜
      if (!el && find === findNextByPageParam && paginationSeen) return { el: null, last: true };
      if (!el) continue;
      if (isDisabled(el)) { sawDisabled = true; continue; }
      return { el, last: false };
    }
    // 下一頁按鈕被停用,或頁面有分頁但沒有更後面的頁碼 → 已是最後一頁
    return { el: null, last: sawDisabled || paginationSeen };
  }

  function goNext() {
    const { el, last } = findNextEl();
    if (el) {
      if (el.tagName === 'LINK') { location.href = el.href; }
      else {
        // 一般連結直接用 location 導向:腳本觸發的 el.click() 會被 AdGuard 之類的
        // 彈出視窗阻擋器當成彈窗攔下
        if (el.tagName === 'A' && isUsable(el)) location.href = el.href;
        else el.click();
      }
      return true;
    }
    if (last) return false;
    const guess = guessNextUrl();
    if (!guess) return false;
    return guessExists(guess).then(ok => {
      if (ok) location.href = guess;
      return ok;
    });
  }

  // ---------- 預先載入下一頁 ----------
  // 同站用 Speculation Rules 預先渲染(按下後幾乎瞬間顯示),
  // 不支援或跨站時退而求其次用 <link rel="prefetch"> 先抓 HTML
  let prefetched = '';
  function prefetchNext() {
    const conn = navigator.connection;
    if (conn && conn.saveData) return;
    const { el } = findNextEl();
    if (!el || !el.href || (el.tagName !== 'A' && el.tagName !== 'LINK')) return;
    const url = el.href;
    if (url === prefetched || url.split('#')[0] === location.href.split('#')[0]) return;
    if (!/^https?:/.test(url)) return;
    prefetched = url;
    const sameSite = new URL(url).origin === location.origin;
    if (sameSite && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify({ prerender: [{ source: 'list', urls: [url] }] });
      document.head.appendChild(s);
      // 預先渲染時,靠捲動才載入的懶載入圖片不會被載入,所以同站再額外預載圖片
      preloadWithImages(url);
    } else if (sameSite) {
      // 不支援預先渲染(例如 Firefox):自己抓 HTML,並把裡面的圖片一併預載
      preloadWithImages(url);
    } else {
      const l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = url;
      document.head.appendChild(l);
    }
  }

  async function preloadWithImages(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const srcs = new Set();
      for (const img of doc.querySelectorAll('img')) {
        // 懶載入的圖片常把真正網址放在 data-src 之類的屬性
        const raw = img.getAttribute('data-src') || img.getAttribute('data-original') ||
                    img.getAttribute('data-lazy-src') || img.getAttribute('src');
        if (!raw || raw.startsWith('data:')) continue;
        try { srcs.add(new URL(raw, url).href); } catch (e) {}
        if (srcs.size >= 30) break;
      }
      for (const src of srcs) new Image().src = src;
    } catch (e) {}
  }

  // 前端路由的網站(例如 pixiv)換頁不會觸發 load,分頁列也常是晚點才渲染,
  // 所以每次網址改變(或載入完成)後,在 10 秒內監看頁面變動,找到下一頁就預載
  let watchTimer = 0;
  let watchObserver = null;
  function watchForNext() {
    if (watchObserver) watchObserver.disconnect();
    clearTimeout(watchTimer);
    let timer = 0;
    const run = () => { try { prefetchNext(); } catch (e) {} };
    run();
    if (!document.documentElement) return;
    watchObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 500);
    });
    watchObserver.observe(document.documentElement, { childList: true, subtree: true });
    watchTimer = setTimeout(() => { watchObserver.disconnect(); clearTimeout(timer); }, 10000);
  }

  function onUrlChange() {
    prefetched = '';
    watchForNext();
  }
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () {
      const before = location.href;
      const ret = orig.apply(this, arguments);
      if (location.href !== before) setTimeout(onUrlChange, 300);
      return ret;
    };
  }
  window.addEventListener('popstate', () => setTimeout(onUrlChange, 300));
  if (document.readyState === 'complete') watchForNext();
  else window.addEventListener('load', watchForNext, { once: true });

  // ---------- 事件 ----------
  function isEditing(e) {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function handler(e) {
    if (e.button !== FORWARD_BUTTON || isEditing(e)) return;
    if (canGoForward()) return; // 有下一頁歷史就交給瀏覽器
    // 先擋掉瀏覽器預設(避免沒作用或誤觸),再嘗試翻頁
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'mouseup') goNext();
  }

  // 注意:不能監聽 pointerdown/pointerup 並 preventDefault,
  // 否則瀏覽器會取消後續的 mouse 事件,導致 mouseup 收不到
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    window.addEventListener(type, handler, true);
  }
})();
