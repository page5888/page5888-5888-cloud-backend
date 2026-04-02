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
    const tabs = await chrome.tabs.query({ url: ["*://www.threads.net/*", "*://threads.net/*"] });
    if (tabs.length > 0) return tabs[0].id;
    const tab = await chrome.tabs.create({ url: initUrl || "https://www.threads.net", active: false });
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
    const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
    let searchTabId;

    try {
      // 開新頁面 + 固定等 9 秒讓 SPA 渲染（不用 onUpdated listener）
      const tab = await chrome.tabs.create({ url: searchUrl, active: false });
      searchTabId = tab.id;
      console.log("[5888] search tab:", searchTabId, searchUrl);
      await sleep(9000);

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
              const full = href.startsWith("http") ? href : "https://www.threads.net" + href;
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
      notify("❌ 搜尋失敗", e.message.slice(0, 100));
      await reportDone(task.id, task.type, false, e.message, []);
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

    const tabId = await getThreadsTab(`https://www.threads.net/@${handle}`);
    await navAndWait(tabId, `https://www.threads.net/@${handle}`, 3500);

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

  // 留言 / 發文任務
  const tabs = await chrome.tabs.query({ url: ["*://www.threads.net/*", "*://threads.net/*"] });
  let tabId;
  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    const tab = await chrome.tabs.create({ url: "https://www.threads.net", active: true });
    tabId = tab.id;
    await new Promise(r => setTimeout(r, 3000));
  }

  // 確保 content.js 有注入
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise(r => setTimeout(r, 300));
  } catch(e) { /* 已注入則忽略 */ }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: task.type, payload });
    const ok = result?.success ?? false;
    notify(ok ? "✅ 任務完成" : "❌ 任務失敗", result?.detail || "");
    await reportDone(task.id, task.type, ok, result?.detail ?? "");
  } catch (e) {
    notify("❌ 任務失敗", e.message);
    await reportDone(task.id, task.type, false, e.message);
  }
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
