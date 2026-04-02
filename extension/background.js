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

  const actionLabel = { search: "搜尋", comment: "留言", post: "發文" }[task.type] || task.type;
  notify("5888 小編助手", `正在執行${actionLabel}任務…`);

  // 搜尋任務：先導航到搜尋頁，等載入完再叫 content script 抓資料
  if (task.type === "search") {
    const keyword = payload.keyword || "";
    const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(keyword)}&serp_type=default`;

    const tabs = await chrome.tabs.query({ url: ["*://www.threads.net/*", "*://threads.net/*"] });
    let tabId;
    if (tabs.length > 0) {
      tabId = tabs[0].id;
    } else {
      const tab = await chrome.tabs.create({ url: searchUrl, active: false });
      tabId = tab.id;
    }

    const loadPromise = waitForTabLoad(tabId);
    chrome.tabs.update(tabId, { url: searchUrl });
    await loadPromise;
    await new Promise(r => setTimeout(r, 2000)); // 等 React 渲染

    try {
      const result = await chrome.tabs.sendMessage(tabId, { action: "scrape", payload: { keyword } });
      const ok = result?.success ?? false;
      notify(ok ? "✅ 搜尋完成" : "❌ 搜尋失敗", result?.detail || "");
      await reportDone(task.id, task.type, ok, result?.detail ?? "", result?.posts ?? []);
    } catch (e) {
      notify("❌ 搜尋失敗", e.message);
      await reportDone(task.id, task.type, false, e.message, []);
    }
    return;
  }

  // 留言 / 發文任務
  const tabs = await chrome.tabs.query({ url: ["*://www.threads.net/*", "*://threads.net/*"] });
  let tabId;
  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    const tab = await chrome.tabs.create({ url: "https://www.threads.net", active: false });
    tabId = tab.id;
    await new Promise(r => setTimeout(r, 3000));
  }

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
async function reportDone(taskId, type, success, detail, posts = []) {
  try {
    await fetch(`${CLOUD_URL}/ext/done`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, type, success, detail, posts }),
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
