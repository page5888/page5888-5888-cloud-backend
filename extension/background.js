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
                .replace(new RegExp(`^${commenter}\\s*\\n?`, "i"), "").trim()
                .split("\n").slice(0, 4).join(" ").slice(0, 200);
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

  // ── 留言任務 ─────────────────────────────────────────────────────────────────
  if (task.type === "comment") {
    const { post_url, comment_text } = payload;
    let commentTabId;
    try {
      const tab = await chrome.tabs.create({ url: post_url, active: true });
      commentTabId = tab.id;
      await sleep(9000); // 等頁面完整渲染

      // 步驟 1：點 Reply 開留言框（廣泛選擇器）
      await execSync(commentTabId, () => {
        const btn =
          document.querySelector('[aria-label*="Reply"]') ||
          document.querySelector('[aria-label*="留言"]') ||
          document.querySelector('[aria-label*="回覆"]') ||
          [...document.querySelectorAll("span,div")].find(el =>
            /^(Reply|留言|回覆)$/.test(el.innerText?.trim()) && el.role !== "none"
          );
        if (btn) btn.click();
        return !!btn;
      });
      await sleep(1500); // 等留言框展開動畫

      // 步驟 2：找輸入框並輸入文字（模擬人工輸入）
      const typed = await execSync(commentTabId, (txt) => {
        const input =
          document.querySelector('[contenteditable="true"][role="textbox"]') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('textarea[placeholder*="Reply"]') ||
          document.querySelector('textarea');
        if (!input) return false;
        input.focus();
        // 清空再輸入，避免疊字
        const sel = window.getSelection();
        if (sel) { sel.selectAllChildren(input); sel.collapseToEnd(); }
        document.execCommand("insertText", false, txt);
        return !!input.innerText?.trim();
      }, [comment_text]);
      if (!typed) { await reportDone(task.id, task.type, false, "找不到留言輸入框"); return; }
      await sleep(1000);

      // 步驟 3：找送出按鈕（從 input 往上找，避免誤點追蹤按鈕）
      const submitted = await execSync(commentTabId, () => {
        const input = document.querySelector('[contenteditable="true"][role="textbox"]')
                   || document.querySelector('[contenteditable="true"]');
        let el = input, btn = null;
        for (let i = 0; i < 10 && el && !btn; i++) {
          btn = [...el.querySelectorAll("button")].find(b =>
            /Post|發布|張貼|Reply|回覆/i.test(b.innerText?.trim()) &&
            !b.disabled
          );
          el = el.parentElement;
        }
        if (!btn) {
          btn = document.querySelector('[aria-label="Post"],[aria-label="發布"],[aria-label="張貼"]');
        }
        if (!btn) return false;
        btn.click();
        return true;
      });
      await sleep(2000); // 等送出完成

      if (submitted) {
        notify("✅ 留言完成", comment_text.slice(0, 50));
        await reportDone(task.id, task.type, true, "留言成功: " + comment_text.slice(0, 30));
      } else {
        notify("❌ 留言失敗", "找不到送出按鈕");
        await reportDone(task.id, task.type, false, "找不到送出按鈕");
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

      // 步驟 1：找目標留言的 Reply 按鈕並點擊
      await execSync(replyTabId, (author, hint) => {
        const authorLower = (author || "").toLowerCase().replace(/^@/, "");
        const hintLower   = (hint || "").slice(0, 30).toLowerCase();
        let targetEl = null;
        for (const el of document.querySelectorAll("article, [role='article'], div[tabindex]")) {
          const text = el.innerText?.toLowerCase() || "";
          if (authorLower && text.includes(authorLower)) {
            if (!hintLower || text.includes(hintLower)) { targetEl = el; break; }
            if (!targetEl) targetEl = el;
          }
        }
        const btn = targetEl
          ? [...targetEl.querySelectorAll("button, span[role='button']")].find(b => /Reply|回覆/i.test(b.innerText))
          : document.querySelector('[aria-label*="Reply"], [aria-label*="留言"]');
        if (btn) btn.click();
        return true;
      }, [comment_author, comment_text_hint]);
      await sleep(1500);

      // 步驟 2：輸入回覆文字
      const typed = await execSync(replyTabId, (txt) => {
        const input =
          document.querySelector('[contenteditable="true"][role="textbox"]') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('textarea');
        if (!input) return false;
        input.focus();
        const sel = window.getSelection();
        if (sel) { sel.selectAllChildren(input); sel.collapseToEnd(); }
        document.execCommand("insertText", false, txt);
        return !!input.innerText?.trim();
      }, [reply_text]);
      if (!typed) { await reportDone(task.id, task.type, false, "找不到回覆輸入框"); return; }
      await sleep(1000);

      // 步驟 3：送出
      const submitted = await execSync(replyTabId, () => {
        const input = document.querySelector('[contenteditable="true"][role="textbox"]')
                   || document.querySelector('[contenteditable="true"]');
        let el = input, btn = null;
        for (let i = 0; i < 10 && el && !btn; i++) {
          btn = [...el.querySelectorAll("button")].find(b =>
            /Post|發布|張貼|Reply|回覆/i.test(b.innerText?.trim()) && !b.disabled
          );
          el = el.parentElement;
        }
        if (!btn) btn = document.querySelector('[aria-label="Post"],[aria-label="發布"],[aria-label="張貼"]');
        if (!btn) return false;
        btn.click();
        return true;
      });
      await sleep(2000);

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

      const results = await chrome.scripting.executeScript({
        target: { tabId: postTabId },
        func: (txt) => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const composeBtn = document.querySelector('[aria-label*="New thread"], [aria-label*="新貼文"]');
          if (!composeBtn) return { success: false, detail: "找不到發文按鈕" };
          composeBtn.click();
          return wait(800).then(() => {
            const input = document.querySelector('[contenteditable="true"][role="textbox"]');
            if (!input) return { success: false, detail: "找不到發文輸入框" };
            input.focus();
            document.execCommand("insertText", false, txt);
            return wait(500).then(() => {
              const btn = [...document.querySelectorAll("button")].find(b => b.innerText?.match(/Post|發布/i));
              if (!btn) return { success: false, detail: "找不到發布按鈕" };
              btn.click();
              return wait(1000).then(() => ({ success: true, detail: "發文成功" }));
            });
          });
        },
        args: [payload.text],
      });
      const r = results?.[0]?.result || { success: false, detail: "無回傳" };
      notify(r.success ? "✅ 發文完成" : "❌ 發文失敗", r.detail);
      await reportDone(task.id, task.type, r.success, r.detail);
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
