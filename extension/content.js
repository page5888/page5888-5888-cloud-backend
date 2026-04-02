/**
 * content.js — 注入 Threads 頁面
 * 接收 background 的指令，實際執行搜尋/留言動作
 */

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 接收 background 指令 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleAction(msg).then(sendResponse).catch(e => sendResponse({ success: false, detail: e.message }));
  return true;
});

async function handleAction(msg) {
  switch (msg.action) {
    case "comment":    return await doComment(msg.payload);
    case "scrape":     return await doScrape(msg.payload);
    case "post":       return await doPost(msg.payload);
    default:           return { success: false, detail: `未知動作: ${msg.action}` };
  }
}

// ── 抓取搜尋結果（background 已跳頁完成後才呼叫） ───────────────────────────
async function doScrape({ keyword }) {
  try {
    const posts = [];
    const seen = new Set();

    document.querySelectorAll("article, [data-pressable-container]").forEach(el => {
      const link = el.querySelector("a[href*='/post/']")?.href;
      if (!link || seen.has(link)) return;
      seen.add(link);
      const text = el.innerText?.trim().slice(0, 300);
      if (text) posts.push({ text, link });
    });

    return { success: true, posts, detail: `搜尋「${keyword}」找到 ${posts.length} 篇` };
  } catch (e) {
    return { success: false, detail: e.message };
  }
}

// ── 留言（扣 1 點） ─────────────────────────────────────────────────────────
async function doComment({ post_url, comment_text }) {
  try {
    // 先跟 background 確認點數
    const credit = await chrome.runtime.sendMessage({
      action: "deduct", type: "comment", detail: post_url
    });
    if (!credit.ok) return { success: false, detail: credit.reason };

    // 前往貼文
    window.location.href = post_url;
    await delay(3000);

    // 找留言框
    const replyBtn = document.querySelector('[aria-label*="Reply"], [aria-label*="留言"]');
    if (replyBtn) replyBtn.click();
    await delay(800);

    const input = document.querySelector('[contenteditable="true"][role="textbox"]')
                  || document.querySelector('textarea[placeholder*="Reply"]');
    if (!input) return { success: false, detail: "找不到留言輸入框" };

    input.focus();
    document.execCommand("insertText", false, comment_text);
    await delay(500);

    // 送出
    const submitBtn = [...document.querySelectorAll("button")].find(b =>
      b.innerText?.includes("Post") || b.innerText?.includes("發布") || b.innerText?.includes("Reply")
    );
    if (!submitBtn) return { success: false, detail: "找不到送出按鈕" };
    submitBtn.click();
    await delay(1000);

    return { success: true, detail: `留言成功：${comment_text.slice(0, 30)}` };
  } catch (e) {
    return { success: false, detail: e.message };
  }
}

// ── 發文（扣 1 點，備用：API 發文優先，這是 fallback） ───────────────────────
async function doPost({ text }) {
  try {
    const credit = await chrome.runtime.sendMessage({
      action: "deduct", type: "post", detail: text.slice(0, 50)
    });
    if (!credit.ok) return { success: false, detail: credit.reason };

    window.location.href = "https://www.threads.net";
    await delay(3000);

    const composeBtn = document.querySelector('[aria-label*="New thread"], [aria-label*="新貼文"]');
    if (!composeBtn) return { success: false, detail: "找不到發文按鈕" };
    composeBtn.click();
    await delay(800);

    const input = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!input) return { success: false, detail: "找不到發文輸入框" };
    input.focus();
    document.execCommand("insertText", false, text);
    await delay(500);

    const postBtn = [...document.querySelectorAll("button")].find(b =>
      b.innerText?.includes("Post") || b.innerText?.includes("發布")
    );
    if (!postBtn) return { success: false, detail: "找不到發布按鈕" };
    postBtn.click();
    await delay(1000);

    return { success: true, detail: "發文成功" };
  } catch (e) {
    return { success: false, detail: e.message };
  }
}
