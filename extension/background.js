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

  const actionLabel = { search: "搜尋", comment: "留言", reply_comment: "回覆留言", post: "發文", scan_inbox: "掃描留言", follow_comment: "追蹤留言" }[task.type] || task.type;
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

  // ── 共用：找 Lexical 輸入框（移植桌機板選擇器，data-lexical-editor 優先） ──
  async function findLexicalInput(tabId) {
    return execSync(tabId, () => {
      const sels = [
        'div[data-lexical-editor="true"]',
        'div[role="textbox"]',
        'div[contenteditable="true"]',
        'p[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[contenteditable]',
        'textarea',
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 0) return true;
        }
      }
      return false;
    });
  }

  // ── 共用：點留言欄（移植桌機板 click_mobile_comment_bar 三策略） ────────────
  async function clickCommentBar(tabId) {
    return execSync(tabId, () => {
      window.scrollTo(0, document.body.scrollHeight);
      // 策略 1：placeholder / aria-placeholder 包含留言關鍵字
      const phs = ['留言', 'comment', 'Comment', '回覆', 'Reply', 'reply', 'Add'];
      for (const tag of ['input','textarea','div','span']) {
        for (const el of document.querySelectorAll(tag)) {
          const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '';
          if (phs.some(p => ph.toLowerCase().includes(p.toLowerCase()))) {
            const r = el.getBoundingClientRect();
            if (r.width > 30 && r.height > 5) { el.click(); return "placeholder"; }
          }
        }
      }
      // 策略 1b：innerText 完全符合（手機版文字留言欄）
      const kws = ['留言', '新增回覆', 'Add a comment', 'Reply', 'Comment'];
      const vh = window.innerHeight;
      for (const el of document.querySelectorAll('div,span,a,button,[role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.top < vh * 0.45 || r.width < 50 || r.height < 15) continue;
        const txt = (el.textContent || '').trim();
        if (kws.some(k => txt === k || txt.startsWith(k))) { el.click(); return "innerText"; }
      }
      // 策略 2：底部任何可點元素（放寬到 60%）
      for (const el of document.querySelectorAll('[role="button"],button,input,textarea,[contenteditable]')) {
        const r = el.getBoundingClientRect();
        if (r.top > vh * 0.6 && r.width > 30 && r.height > 5) { el.click(); return "bottom"; }
      }
      // 策略 3：article 裡帶 SVG 的 role=button（電腦版）
      for (const container of document.querySelectorAll('article,[data-pressable-container="true"],[role="article"],main')) {
        for (const btn of container.querySelectorAll('[role="button"]')) {
          const r = btn.getBoundingClientRect();
          if (btn.querySelector('svg') && r.width >= 5 && r.width <= 120 && r.height >= 5) {
            btn.click(); return "svg-btn";
          }
        }
      }
      return false;
    });
  }

  // ── 共用：找送出按鈕（移植桌機板 normalize-space XPath 邏輯，JS 版本） ─────
  async function clickSubmitBtn(tabId) {
    return execSync(tabId, () => {
      const targets = ['發佈', 'Post', '張貼', '回覆', 'Reply'];
      // 從 Lexical 輸入框往上找
      const input = document.querySelector('[data-lexical-editor="true"]')
                 || document.querySelector('[contenteditable="true"]')
                 || document.querySelector('[contenteditable]');
      let root = input;
      for (let i = 0; i < 15 && root; i++) {
        const btn = [...root.querySelectorAll('[role="button"],button')].find(el => {
          const t = (el.innerText || '').trim();
          return targets.includes(t) && !el.closest('[aria-hidden="true"]') && !el.disabled;
        });
        if (btn) { btn.click(); return true; }
        root = root.parentElement;
      }
      // Fallback：aria-label
      for (const label of ['Post','發佈','張貼','Reply','回覆']) {
        const fb = document.querySelector(`[aria-label="${label}"]`);
        if (fb) { fb.click(); return true; }
      }
      // 全域搜尋（最後手段）
      const globalBtn = [...document.querySelectorAll('[role="button"],button')]
        .find(el => targets.includes((el.innerText || '').trim()) && !el.closest('[aria-hidden="true"]'));
      if (globalBtn) { globalBtn.click(); return true; }
      return false;
    });
  }

  // ── 共用：輸入文字（移植桌機板：focus + execCommand + input event） ────────
  async function typeText(tabId, txt) {
    return execSync(tabId, (text) => {
      const sels = ['div[data-lexical-editor="true"]','div[role="textbox"]',
                    'div[contenteditable="true"]','[contenteditable]','textarea'];
      let input = null;
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) { input = el; break; }
      }
      if (!input) return false;
      // scrollIntoView + 點擊（觸發真實事件）
      input.scrollIntoView({ block: 'center' });
      input.click();
      input.focus();
      // 清空 + 插入
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      // 觸發 beforeinput + input 讓 Lexical/React 更新狀態
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return (input.textContent || input.value || '').trim().length > 0;
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

      // 步驟 1：先直接找輸入框（移植桌機板：find_visible_input 優先，找不到才點留言欄）
      let inputFound = await findLexicalInput(commentTabId);
      let barClicked = false;
      if (!inputFound) {
        // 找不到輸入框：點底部留言欄（移植桌機板 click_mobile_comment_bar）
        barClicked = await clickCommentBar(commentTabId);
        console.log("[5888] clickCommentBar:", barClicked);
        // 等 modal/input 展開，最多輪詢 8 次 × 0.5s = 4s（移植桌機板 for _ in range(8)）
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          inputFound = await findLexicalInput(commentTabId);
          if (inputFound) break;
        }
      }
      console.log("[5888] inputFound:", inputFound, "barClicked:", barClicked);

      if (!inputFound) {
        // 仍找不到：嘗試逐一點 article 的 SVG 按鈕（移植桌機板 Step 1c）
        const svgBtns = await execSync(commentTabId, () => {
          const result = [];
          for (const c of document.querySelectorAll('article,[data-pressable-container="true"],[role="article"],main')) {
            [...c.querySelectorAll('[role="button"]')].forEach((b, i) => {
              const r = b.getBoundingClientRect();
              if (b.querySelector('svg') && r.width >= 5 && r.width <= 120 && r.height >= 5) result.push(i);
            });
            if (result.length) break;
          }
          return result;
        });
        for (const btnIdx of (svgBtns || []).slice(0, 5)) {
          await execSync(commentTabId, (idx) => {
            const container = document.querySelector('article,[data-pressable-container="true"],[role="article"],main');
            if (!container) return;
            const btns = [...container.querySelectorAll('[role="button"]')].filter(b => b.querySelector('svg'));
            if (btns[idx]) btns[idx].click();
          }, [btnIdx]);
          await sleep(1500);
          inputFound = await findLexicalInput(commentTabId);
          if (inputFound) break;
        }
      }

      if (!inputFound) {
        const detail = `找不到 Lexical 輸入框 barClicked=${barClicked} page="${pageInfo?.title?.slice(0,25)}"`;
        notify("❌ 留言失敗", detail.slice(0, 100));
        await reportDone(task.id, task.type, false, detail);
        return;
      }

      // 步驟 2：輸入文字（移植桌機板 scrollIntoView + click + execCommand + dispatch events）
      const typed = await typeText(commentTabId, comment_text);
      console.log("[5888] typeText:", typed);
      if (!typed) {
        const detail = `輸入失敗：找到框但文字未進入 page="${pageInfo?.title?.slice(0,25)}"`;
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

      // 步驟 1：找目標留言的 SVG 按鈕（逐一嘗試，移植桌機板 Step 1c 逐一嘗試邏輯）
      const authorLower = (comment_author || "").toLowerCase().replace(/^@/, "");
      const hintLower   = (comment_text_hint || "").slice(0, 30).toLowerCase();

      // 先找包含該留言者的容器裡的 SVG 按鈕
      const targetClicked = await execSync(replyTabId, (author, hint) => {
        const aL = author.toLowerCase(); const hL = hint.toLowerCase();
        for (const el of document.querySelectorAll("article,[role='article'],[data-pressable-container='true']")) {
          const txt = (el.innerText || "").toLowerCase();
          if (aL && !txt.includes(aL)) continue;
          if (hL && !txt.includes(hL)) continue;
          const svgBtn = [...el.querySelectorAll('[role="button"]')]
            .find(b => { const r = b.getBoundingClientRect(); return b.querySelector('svg') && r.width >= 5 && r.width <= 120 && r.height >= 5; });
          if (svgBtn) { svgBtn.click(); return true; }
          const textBtn = [...el.querySelectorAll('[role="button"],button')].find(b => /Reply|回覆/i.test(b.innerText || ''));
          if (textBtn) { textBtn.click(); return true; }
        }
        return false;
      }, [authorLower, hintLower]);

      if (!targetClicked) {
        // 找不到特定留言，退而求其次用 clickCommentBar
        await clickCommentBar(replyTabId);
      }

      // 步驟 2：等輸入框出現（最多 8 × 0.5s）
      let inputFound = false;
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        inputFound = await findLexicalInput(replyTabId);
        if (inputFound) break;
      }
      if (!inputFound) {
        await reportDone(task.id, task.type, false, `找不到回覆輸入框 author=${comment_author}`);
        return;
      }

      // 步驟 3：輸入文字
      const typed = await typeText(replyTabId, reply_text);
      if (!typed) { await reportDone(task.id, task.type, false, "回覆輸入失敗（文字未進入）"); return; }
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

      // 步驟 2：等輸入框出現並輸入文字
      await sleep(800);
      let postInputFound = false;
      for (let i = 0; i < 6; i++) {
        postInputFound = await findLexicalInput(postTabId);
        if (postInputFound) break;
        await sleep(500);
      }
      if (!postInputFound) { await reportDone(task.id, task.type, false, "找不到發文輸入框"); return; }
      const typed = await typeText(postTabId, payload.text);
      if (!typed) { await reportDone(task.id, task.type, false, "文字無法輸入到發文框"); return; }
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

  // ── 追蹤留言任務（移植桌機板 follow_and_comment_selenium） ──────────────────
  if (task.type === "follow_comment") {
    const { post_url, comment_text } = payload;
    let tabId;
    try {
      const tab = await chrome.tabs.create({ url: post_url, active: true });
      tabId = tab.id;
      await sleep(6000);

      // Step 1：從 URL 取得作者帳號名（/@username/post/... 或 /@username/t/...）
      const authorInfo = await execSync(tabId, () => {
        const m = location.pathname.match(/@([^/?#]+)/);
        return { author: m ? m[1] : "" };
      });
      const author = authorInfo?.author || "";
      let followed = false;

      // Step 2：前往個人頁追蹤（移植桌機板 Step 1）
      if (author) {
        await navAndWait(tabId, `https://www.threads.com/@${author}`, 4000);
        followed = await execSync(tabId, () => {
          // 找「追蹤」button（text 或 aria-label）
          const btn = [...document.querySelectorAll('[role="button"],button')]
            .find(b => {
              const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
              return t === '追蹤' || t === 'Follow';
            });
          if (btn) { btn.click(); return true; }
          return false;
        });
        console.log("[5888] follow @" + author + ":", followed);
        await sleepR(1200, 2000);
      }

      // Step 3：回到貼文留言（移植桌機板 Step 2–4）
      await navAndWait(tabId, post_url, 7000);

      let inputFound = await findLexicalInput(tabId);
      if (!inputFound) {
        await clickCommentBar(tabId);
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          inputFound = await findLexicalInput(tabId);
          if (inputFound) break;
        }
      }

      if (!inputFound) {
        const detail = `找不到留言輸入框 followed=${followed} author=${author}`;
        notify("❌ 追蹤留言失敗", detail.slice(0, 80));
        await reportDone(task.id, task.type, false, detail);
        return;
      }

      const typed = await typeText(tabId, comment_text);
      if (!typed) {
        await reportDone(task.id, task.type, false, `留言輸入失敗 followed=${followed}`);
        return;
      }
      await sleepR(800, 1400);

      const submitted = await clickSubmitBtn(tabId);
      await sleepR(1800, 2500);

      const detail = `追蹤=${followed ? '✓' : '已追蹤/找不到'} 留言=${submitted ? '✓' : '失敗'} @${author}`;
      notify(submitted ? "✅ 追蹤留言完成" : "❌ 追蹤留言失敗", detail.slice(0, 80));
      await reportDone(task.id, task.type, submitted, detail);
    } catch(e) {
      notify("❌ 追蹤留言失敗", e.message.slice(0, 80));
      await reportDone(task.id, task.type, false, e.message);
    } finally {
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
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
