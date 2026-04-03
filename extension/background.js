/**
 * background.js — Service Worker
 * 每 30 秒輪詢雲端，有任務就轉給 content script 執行
 */

const CLOUD_URL = "https://prospective-dani-5888-4102b520.koyeb.app"; // 部署後填入

// ── 通知工具 ────────────────────────────────────────────────────────────────
function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon48.png",
    title,
    message,
  });
}

// ── 啟動時設定輪詢 alarm ────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 }); // 每 30 秒
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") pollTasks();
});

// ── 輪詢雲端任務 ────────────────────────────────────────────────────────────
async function pollTasks() {
  try {
    const res  = await fetch(`${CLOUD_URL}/ext/tasks`, { credentials: "include" });
    if (res.status === 401) {
      // 未登入：每 5 分鐘提示一次（用 storage 避免頻繁通知）
      const { lastAuthWarn } = await chrome.storage.local.get("lastAuthWarn");
      const now = Date.now();
      if (!lastAuthWarn || now - lastAuthWarn > 5 * 60 * 1000) {
        await chrome.storage.local.set({ lastAuthWarn: now });
        notify("⚠️ 尚未登入", "請點擊 Extension 圖示 → 前往登入，否則任務無法執行");
      }
      return;
    }
    const data = await res.json();
    if (!data.success || !data.tasks?.length) return;

    notify("5888 小編助手", `收到 ${data.tasks.length} 個任務，開始執行…`);
    for (const task of data.tasks) {
      await executeTask(task);
    }
  } catch (e) {
    console.log("[5888] 輪詢失敗", e.message);
  }
}

// ── 等待分頁載入完成 ────────────────────────────────────────────────────────
function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── 執行任務 ────────────────────────────────────────────────────────────────
async function executeTask(task) {
  const payload = typeof task.payload === "string"
    ? JSON.parse(task.payload) : task.payload;

  const actionLabel = { search: "搜尋", comment: "留言", reply_comment: "回覆留言", post: "發文", scan_inbox: "掃描留言" }[task.type] || task.type;
  notify("5888 小編助手", `正在執行${actionLabel}任務…`);

  // ── 共用：取得或建立 Threads 分頁 ──────────────────────────────────────────
  async function getThreadsTab(initUrl) {
    const tabs = await chrome.tabs.query({ url: ["*://www.threads.net/*", "*://threads.net/*", "*://www.threads.com/*", "*://threads.com/*"] });
    if (tabs.length > 0) return tabs[0].id;
    const tab = await chrome.tabs.create({ url: initUrl || "https://www.threads.com", active: false });
    return tab.id;
  }

  // ── 共用：固定等待（ms） ────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 共用：導覽並等待（不用 event listener，固定 sleep，MV3 更可靠） ──────────
  async function navAndWait(tabId, url, extraMs) {
    await chrome.tabs.update(tabId, { url });
    await sleep(extraMs || 5000);
  }

  // ── 搜尋任務 ─────────────────────────────────────────────────────────────────
  if (task.type === "search") {
    const keyword   = payload.keyword || "";
    const searchUrl = `https://www.threads.com/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
    let searchTabId;

    try {
      // 開新頁面（active:true 確保 Chrome 載入），等 9 秒讓 SPA 渲染
      const tab = await chrome.tabs.create({ url: searchUrl, active: true });
      searchTabId = tab.id;
      console.log("[5888] search tab:", searchTabId, searchUrl);
      await sleep(9000);

      // 確認 tab 還在且 URL 在 threads/instagram（排除其他重導向）
      let tabInfo;
      try { tabInfo = await chrome.tabs.get(searchTabId); } catch(_) {}
      const currentUrl = tabInfo?.url || "";
      console.log("[5888] tab URL after 9s:", currentUrl, "status:", tabInfo?.status);
      if (currentUrl && !currentUrl.includes("threads.net") && !currentUrl.includes("threads.com") && !currentUrl.includes("instagram.com")) {
        throw new Error("頁面跳轉到未知網址: " + currentUrl.slice(0, 60));
      }

      // 同步抓取（不用 async func，避免 Chrome 對 Promise return 的相容問題）
      const results = await chrome.scripting.executeScript({
        target: { tabId: searchTabId },
        func: (kw) => {
          const posts = [], seen = new Set();
          const harvest = (a) => {
            const link = (a.href || "").split("?")[0];
            if (!link || seen.has(link)) return;
            if (link.includes("/t/") && !/\/t\/[A-Za-z0-9_-]{5,}$/.test(link)) return;
            seen.add(link);
            let el = a.parentElement, text = "";
            for (let i = 0; i < 10 && el; i++) {
              const t = (el.innerText || "").trim();
              if (t.length > 15) { text = t.slice(0, 300); break; }
              el = el.parentElement;
            }
            posts.push({ text: text || link, link });
          };
          document.querySelectorAll("a[href*='/post/']").forEach(harvest);
          document.querySelectorAll("a[href*='/t/']").forEach(harvest);
          if (posts.length === 0) {
            document.querySelectorAll("[role='link']").forEach(el => {
              const href = el.getAttribute("href") || "";
              if (!href || seen.has(href) || !/\/(post|t)\//.test(href)) return;
              seen.add(href);
              const full = href.startsWith("http") ? href : "https://www.threads.com" + href;
              posts.push({ text: (el.innerText || "").trim().slice(0, 300) || full, link: full });
            });
          }
          return { posts, pageUrl: location.href, detail: `搜尋「${kw}」找到 ${posts.length} 篇` };
        },
        args: [keyword],
      });

      const r0 = results?.[0];
      console.log("[5888] search result:", r0?.result?.pageUrl, "posts:", r0?.result?.posts?.length, "error:", r0?.error);
      if (r0?.error) throw new Error("注入錯誤: " + JSON.stringify(r0.error));
      const res = r0?.result;
      if (!res) throw new Error("executeScript 無回傳（可能頁面未載入）");
      notify(res.posts.length > 0 ? "✅ 搜尋完成" : "⚠️ 未找到貼文（" + res.pageUrl?.slice(0,40) + "）", res.detail);
      await reportDone(task.id, task.type, true, res.detail, res.posts);
    } catch(e) {
      console.error("[5888] search error:", e.name, e.message);
      const errMsg = (e.name === "Error" ? "" : e.name + ": ") + e.message;
      notify("❌ " + errMsg.slice(0, 60), "搜尋失敗，詳見後端任務記錄");
      await reportDone(task.id, task.type, false, errMsg, []);
    } finally {
      if (searchTabId) chrome.tabs.remove(searchTabId).catch(() => {});
    }
    return;
  }

  // ── 掃描個人頁留言（scan_inbox）：同樣用 executeScript ──────────────────────
  if (task.type === "scan_inbox") {
    const handle   = payload.handle || "";
    const maxPosts = payload.max_posts || 5;
    if (!handle) {
      await reportDone(task.id, task.type, false, "缺少帳號 handle", [], []);
      return;
    }

    const tabId = await getThreadsTab(`https://www.threads.com/@${handle}`);
    await navAndWait(tabId, `https://www.threads.com/@${handle}`, 3500);

    // 抓貼文列表
    let postList = [];
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: (max) => {
          const seen = new Set(), posts = [];
          document.querySelectorAll("a[href*='/post/'], a[href*='/t/']").forEach(a => {
            const url = (a.href || "").split("?")[0];
            if (!url || seen.has(url)) return;
            if (url.includes("/t/") && !/\/t\/[A-Za-z0-9_-]{5,}$/.test(url)) return;
            seen.add(url);
            let el = a.parentElement, text = "";
            for (let i = 0; i < 8 && el; i++) {
              const t = (el.innerText || "").trim();
              if (t.length > 15) { text = t.slice(0, 200); break; }
              el = el.parentElement;
            }
            posts.push({ url, text: text || url });
          });
          return posts.slice(0, max);
        },
        args: [maxPosts],
      });
      postList = r?.[0]?.result || [];
    } catch(e) {
      await reportDone(task.id, task.type, false, "抓貼文失敗: " + e.message, [], []);
      return;
    }

    notify("5888 小編助手", `找到 ${postList.length} 篇，掃描留言中…`);

    const allInbox = [];
    for (const post of postList) {
      await navAndWait(tabId, post.url, 3000);
      try {
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          func: (postUrl, postText) => {
            const comments = [], seen = new Set();
            const containers = [...document.querySelectorAll(
              "article, [role='article'], [data-pressable-container]"
            )];
            containers.forEach((el, idx) => {
              if (idx === 0) return;
              const profileLink = el.querySelector("a[href*='/@'], a[href*='threads.net/@']");
              const m = (profileLink?.href || "").match(/@([^/?#]+)/);
              const commenter = m ? m[1] : "";
              if (!commenter) return;
              let commentText = (el.innerText || "").trim()
                .replace(new RegExp(`^${commenter}\\s*\\n?`, "i"), "").trim();
              // 過濾時間戳記（如「3天前」「1小時前」「剛剛」）
              commentText = commentText.replace(/\b\d+\s*(天|小時|分鐘|秒|週|個月|年)前\b/g, "");
              commentText = commentText.replace(/\b(剛剛|昨天|今天)\b/g, "");
              commentText = commentText.replace(/\b\d+[wdhms]\b/g, "");
              commentText = commentText.split("\n").slice(0, 4).join(" ").replace(/\s{2,}/g, " ").trim().slice(0, 200);
              if (!commentText || seen.has(commenter + commentText)) return;
              seen.add(commenter + commentText);
              comments.push({ post_url: postUrl, post_text: postText, commenter, comment_text: commentText });
            });
            return comments;
          },
          args: [post.url, post.text],
        });
        const comments = r?.[0]?.result || [];
        allInbox.push(...comments);
      } catch(e) { /* 單篇失敗繼續 */ }
    }

    notify(allInbox.length > 0 ? "✅ 掃描完成" : "⚠️ 沒找到留言",
           `掃描 ${postList.length} 篇，找到 ${allInbox.length} 則留言`);
    await reportDone(task.id, task.type, true,
                     `掃描 ${postList.length} 篇，找到 ${allInbox.length} 則留言`,
                     [], allInbox);
    return;
  }

  // ── 共用：多步驟同步 executeScript（每步 return 純值，不回傳 Promise）─────────
  async function execSync(tabId, fn, args) {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args: args || [] });
    return r?.[0]?.result;
  }

  // ── 共用：隨機 sleep（移植桌機板 random.uniform） ───────────────────────────
  const sleepR = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

  // ── 共用：找可見輸入框（移植桌機板多策略） ──────────────────────────────────
  // 回傳 true 表示找到且可見
  async function findInputVisible(tabId) {
    return execSync(tabId, () => {
      // 策略 1：標準 contenteditable textbox
      const ce = document.querySelector('[contenteditable="true"][role="textbox"]')
              || document.querySelector('[contenteditable="true"]');
      if (ce) { const r = ce.getBoundingClientRect(); if (r.width > 30 && r.height > 5) return true; }
      // 策略 2：textarea / input with reply-related placeholder（桌機板原版）
      const phs = ['留言', 'comment', '回覆', 'Reply', 'Add'];
      for (const tag of ['input', 'textarea', 'div', 'span']) {
        for (const el of document.querySelectorAll(tag)) {
          const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '';
          if (phs.some(p => ph.toLowerCase().includes(p.toLowerCase()))) {
            const r = el.getBoundingClientRect();
            if (r.width > 30 && r.height > 5) { el.click(); return true; }
          }
        }
      }
      return false;
    });
  }

  // ── 共用：點留言按鈕（移植桌機板四策略） ────────────────────────────────────
  async function clickReplyBtn(tabId) {
    return execSync(tabId, () => {
      // 策略 1：aria-label
      for (const sel of ['[aria-label*="Reply"]','[aria-label*="留言"]','[aria-label*="回覆"]']) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return true; }
      }
      // 策略 2：innerText 完全符合（桌機板原版）
      const byText = [...document.querySelectorAll('[role="button"],button,span,div')].find(el => {
        const t = el.innerText?.trim();
        const r = el.getBoundingClientRect();
        return (t === 'Reply' || t === '留言' || t === '回覆') && r.width > 10 && r.height > 5;
      });
      if (byText) { byText.click(); return true; }
      // 策略 3：底部固定列可點元素（手機版 UI，移植桌機板 vh*0.55 判斷）
      window.scrollTo(0, document.body.scrollHeight);
      const vh = window.innerHeight;
      const bottomEl = [...document.querySelectorAll('[role="button"],button,input,textarea,[contenteditable]')]
        .find(el => { const r = el.getBoundingClientRect(); return r.top > vh * 0.55 && r.width > 30 && r.height > 5; });
      if (bottomEl) { bottomEl.click(); return true; }
      // 策略 4：article 裡帶 SVG 的 role=button（桌機板電腦版邏輯）
      const article = document.querySelector('article,[role="article"],[data-pressable-container]');
      if (article) {
        const svgBtn = [...article.querySelectorAll('[role="button"]')]
          .find(el => { const r = el.getBoundingClientRect(); return el.querySelector('svg') && r.width < 120 && r.width > 5; });
        if (svgBtn) { svgBtn.click(); return true; }
      }
      return false;
    });
  }

  // ── 共用：找送出按鈕（移植桌機板 role=button 精確文字，排除 aria-hidden） ───
  async function clickSubmitBtn(tabId) {
    return execSync(tabId, () => {
      const targets = ['發佈', 'Post', '張貼'];
      // 從 input 往上找（避免點到頁面其他地方）
      const input = document.querySelector('[contenteditable="true"]');
      let root = input;
      for (let i = 0; i < 12 && root; i++) {
        const btn = [...root.querySelectorAll('[role="button"],button')].find(el => {
          const t = (el.innerText || '').trim();
          return targets.includes(t) && !el.closest('[aria-hidden="true"]') && !el.disabled;
        });
        if (btn) { btn.click(); return true; }
        root = root.parentElement;
      }
      // Fallback：aria-label
      const fb = document.querySelector('[aria-label="Post"],[aria-label="發佈"],[aria-label="張貼"]');
      if (fb) { fb.click(); return true; }
      return false;
    });
  }

  // ── 共用：輸入文字（selectAll + insertText，清空後插入） ────────────────────
  async function typeText(tabId, txt) {
    return execSync(tabId, (text) => {
      const input =
        document.querySelector('[contenteditable="true"][role="textbox"]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('textarea');
      if (!input) return false;
      input.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      return (input.textContent || input.value || "").trim().length > 0;
    }, [txt]);
  }

  // ── 留言任務 ─────────────────────────────────────────────────────────────────
  if (task.type === "comment") {
    const { post_url, comment_text } = payload;
    let commentTabId;
    try {
      const tab = await chrome.tabs.create({ url: post_url, active: true });
      commentTabId = tab.id;
      await sleep(9000); // 等頁面完整渲染

      // 步驟 0：診斷頁面狀態（確認頁面載入正確）
      const pageInfo = await execSync(commentTabId, () => ({
        title: document.title,
        url: location.href,
        hasInput: !!document.querySelector('[contenteditable="true"]'),
        hasReplyBtn: !![...document.querySelectorAll('[role="button"],button,span')].find(e =>
          /Reply|留言|回覆/i.test(e.innerText || e.getAttribute('aria-label') || '')
        ),
        bodyText: (document.body?.innerText || "").slice(0, 100),
      }));
      console.log("[5888] comment page:", JSON.stringify(pageInfo));

      if (!pageInfo?.url?.includes("threads")) {
        throw new Error("頁面異常，不在 threads: " + (pageInfo?.url || "?").slice(0, 60));
      }

      // 步驟 1：捲動到底部 + 點 Reply 按鈕
      const replyClicked = await execSync(commentTabId, () => {
        // 先捲動到底部，讓底部 Reply bar 進入視野
        window.scrollTo(0, document.body.scrollHeight);
        // 策略 1：aria-label
        for (const sel of ['[aria-label*="Reply"]','[aria-label*="留言"]','[aria-label*="回覆"]','[aria-label*="Add"]']) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return "aria-label"; }
        }
        // 策略 2：innerText 精確符合
        const byText = [...document.querySelectorAll('[role="button"],button')].find(el => {
          const t = (el.innerText || "").trim();
          return /^(Reply|留言|回覆|Add a reply)$/i.test(t);
        });
        if (byText) { byText.click(); return "innerText"; }
        // 策略 3：底部任何可點元素（包含已存在的 contenteditable，點擊可 focus）
        const vh = window.innerHeight;
        const bottomEls = [...document.querySelectorAll('[role="button"],button,[contenteditable],[role="textbox"]')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.top > vh * 0.4 && r.width > 20 && r.height > 5; });
        if (bottomEls[0]) { bottomEls[0].click(); return "bottom-el"; }
        return false;
      });
      console.log("[5888] clickReplyBtn:", replyClicked);
      await sleepR(2500, 3500); // 等待輸入框動畫出現

      // 步驟 2：嘗試找到輸入框，最多重試 5 次
      // Threads 可能用 contenteditable="true" 或 contenteditable="plaintext-only"
      let typed = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        typed = await execSync(commentTabId, (text) => {
          const el = document.querySelector('[contenteditable="true"][role="textbox"]')
                  || document.querySelector('[contenteditable][role="textbox"]')
                  || document.querySelector('[contenteditable="true"]')
                  || document.querySelector('[contenteditable="plaintext-only"]')
                  || document.querySelector('[contenteditable]');
          if (!el) return { ok: false, reason: "no_input_el", count: document.querySelectorAll('[contenteditable]').length };
          el.click();
          el.focus();
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          const content = (el.textContent || el.innerText || "").trim();
          return { ok: content.length > 0, reason: content.length > 0 ? "ok" : "type_failed_empty",
                   content: content.slice(0, 30), tag: el.tagName, ce: el.getAttribute("contenteditable") };
        }, [comment_text]);
        if (typed?.ok) break;
        await sleep(1000); // 等 1 秒後重試
      }

      console.log("[5888] typeText result:", JSON.stringify(typed));
      if (!typed?.ok) {
        const reason = typed?.reason || "type_failed";
        const detail = `輸入失敗(${reason}) replyClicked=${replyClicked} ceCount=${typed?.count ?? "?"} page="${pageInfo?.title?.slice(0,25)}"`;
        notify("❌ 留言失敗", detail.slice(0, 100));
        await reportDone(task.id, task.type, false, detail);
        return;
      }
      await sleepR(800, 1400);

      // 步驟 3：送出（role=button 精確文字，移植桌機板）
      const submitted = await clickSubmitBtn(commentTabId);
      console.log("[5888] clickSubmitBtn:", submitted);
      await sleepR(1800, 2500);

      if (submitted) {
        notify("✅ 留言完成", comment_text.slice(0, 50));
        await reportDone(task.id, task.type, true, "留言成功: " + comment_text.slice(0, 30));
      } else {
        const submitDetail = `找不到送出按鈕 typed="${typed?.content?.slice(0,20)}" page="${pageInfo?.title?.slice(0,20)}"`;
        notify("❌ 留言失敗", submitDetail.slice(0, 80));
        await reportDone(task.id, task.type, false, submitDetail);
      }
    } catch(e) {
      notify("❌ 留言失敗", e.message.slice(0, 80));
      await reportDone(task.id, task.type, false, e.message);
    } finally {
      if (commentTabId) chrome.tabs.remove(commentTabId).catch(() => {});
    }
    return;
  }

  // ── 回覆留言任務 ──────────────────────────────────────────────────────────────
  if (task.type === "reply_comment") {
    const { post_url, comment_author, comment_text_hint, reply_text } = payload;
    let replyTabId;
    try {
      const tab = await chrome.tabs.create({ url: post_url, active: true });
      replyTabId = tab.id;
      await sleep(9000);

      // 步驟 1：找目標留言的 Reply 按鈕（移植桌機板：先找 author，再點其中的 role=button SVG）
      await execSync(replyTabId, (author, hint) => {
        const authorLower = (author || "").toLowerCase().replace(/^@/, "");
        const hintLower   = (hint || "").slice(0, 30).toLowerCase();
        let targetEl = null;
        for (const el of document.querySelectorAll("article,[role='article'],[data-pressable-container]")) {
          const text = (el.innerText || "").toLowerCase();
          if (authorLower && text.includes(authorLower)) {
            if (!hintLower || text.includes(hintLower)) { targetEl = el; break; }
            if (!targetEl) targetEl = el;
          }
        }
        if (targetEl) {
          // 找 role=button 帶 SVG 的（桌機板電腦版邏輯）
          const svgBtn = [...targetEl.querySelectorAll('[role="button"]')]
            .find(el => { const r = el.getBoundingClientRect(); return el.querySelector('svg') && r.width < 120 && r.width > 5; });
          if (svgBtn) { svgBtn.click(); return true; }
          // 或找文字符合的按鈕
          const textBtn = [...targetEl.querySelectorAll('[role="button"],button')]
            .find(b => /Reply|回覆/i.test(b.innerText));
          if (textBtn) { textBtn.click(); return true; }
        }
        // Fallback：aria-label
        const fb = document.querySelector('[aria-label*="Reply"],[aria-label*="留言"]');
        if (fb) { fb.click(); return true; }
        return false;
      }, [comment_author, comment_text_hint]);
      await sleepR(1200, 2000);

      // 步驟 2：直接 focus + 輸入
      const typed = await execSync(replyTabId, (text) => {
        const el = document.querySelector('[contenteditable="true"][role="textbox"]')
                || document.querySelector('[contenteditable="true"]');
        if (!el) return { ok: false, reason: "no_input_el" };
        el.click(); el.focus();
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        const content = (el.textContent || el.innerText || "").trim();
        return { ok: content.length > 0, reason: content.length > 0 ? "ok" : "type_failed_empty" };
      }, [reply_text]);
      if (!typed?.ok) { await reportDone(task.id, task.type, false, "回覆輸入失敗: " + (typed?.reason || "")); return; }
      await sleepR(800, 1400);

      // 步驟 4：送出
      const submitted = await clickSubmitBtn(replyTabId);
      await sleepR(1800, 2500);

      if (submitted) {
        notify("✅ 回覆完成", reply_text.slice(0, 50));
        await reportDone(task.id, task.type, true, "回覆成功: " + reply_text.slice(0, 30));
      } else {
        notify("❌ 回覆失敗", "找不到送出按鈕");
        await reportDone(task.id, task.type, false, "找不到送出按鈕");
      }
    } catch(e) {
      notify("❌ 回覆失敗", e.message.slice(0, 80));
      await reportDone(task.id, task.type, false, e.message);
    } finally {
      if (replyTabId) chrome.tabs.remove(replyTabId).catch(() => {});
    }
    return;
  }

  // ── 發文任務 ─────────────────────────────────────────────────────────────────
  if (task.type === "post") {
    let postTabId;
    try {
      const tab = await chrome.tabs.create({ url: "https://www.threads.com", active: true });
      postTabId = tab.id;
      await sleep(6000);

      // 步驟 1：找並點擊「新貼文」按鈕
      const composeClicked = await execSync(postTabId, () => {
        const btn = document.querySelector('[aria-label*="New thread"],[aria-label*="新貼文"],[aria-label*="發佈"]')
                 || [...document.querySelectorAll('[role="button"],button')]
                      .find(b => /New thread|新貼文/i.test(b.getAttribute('aria-label') || b.innerText || ''));
        if (!btn) return false;
        btn.click(); return true;
      });
      if (!composeClicked) {
        await reportDone(task.id, task.type, false, "找不到發文按鈕");
        return;
      }
      await sleep(1200);

      // 步驟 2：輸入文字
      const typed = await execSync(postTabId, (text) => {
        const el = document.querySelector('[contenteditable="true"][role="textbox"]')
                || document.querySelector('[contenteditable="true"]');
        if (!el) return { ok: false };
        el.click(); el.focus();
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        return { ok: (el.textContent || "").trim().length > 0 };
      }, [payload.text]);
      if (!typed?.ok) { await reportDone(task.id, task.type, false, "找不到發文輸入框"); return; }
      await sleep(600);

      // 步驟 3：送出
      const submitted = await clickSubmitBtn(postTabId);
      await sleep(1500);

      notify(submitted ? "✅ 發文完成" : "❌ 發文失敗", submitted ? "發文成功" : "找不到發布按鈕");
      await reportDone(task.id, task.type, submitted, submitted ? "發文成功" : "找不到發布按鈕");
    } catch(e) {
      notify("❌ 發文失敗", e.message.slice(0, 80));
      await reportDone(task.id, task.type, false, e.message);
    } finally {
      if (postTabId) chrome.tabs.remove(postTabId).catch(() => {});
    }
    return;
  }

  // 未知任務類型
  await reportDone(task.id, task.type, false, "未知任務類型: " + task.type);
}

// ── 回報結果給雲端 ──────────────────────────────────────────────────────────
async function reportDone(taskId, type, success, detail, posts = [], inbox = []) {
  try {
    await fetch(`${CLOUD_URL}/ext/done`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, type, success, detail, posts, inbox }),
    });
  } catch (e) {
    console.log("[5888] 回報失敗", e.message);
  }
}

// ── Extension 即時扣點（content script 呼叫） ────────────────────────────────
async function deductCredit(type, detail) {
  try {
    const res  = await fetch(`${CLOUD_URL}/ext/deduct`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, detail }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, reason: "網路錯誤" };
  }
}

// ── 接收來自 popup / content script 的訊息 ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "deduct") {
    deductCredit(msg.type, msg.detail).then(sendResponse);
    return true; // 非同步回應
  }
  if (msg.action === "getCloudUrl") {
    sendResponse({ url: CLOUD_URL });
  }
});
