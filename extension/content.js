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
    case "comment":       return await doComment(msg.payload);
    case "reply_comment": return await doReplyComment(msg.payload);
    case "scrape":        return await doScrape(msg.payload);
    case "post":          return await doPost(msg.payload);
    default:              return { success: false, detail: `未知動作: ${msg.action}` };
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

// ── 回覆指定留言（扣 1 點） ──────────────────────────────────────────────────
async function doReplyComment({ post_url, comment_author, comment_text_hint, reply_text }) {
  try {
    const credit = await chrome.runtime.sendMessage({
      action: "deduct", type: "reply_comment", detail: post_url
    });
    if (!credit.ok) return { success: false, detail: credit.reason };

    // 前往貼文頁
    window.location.href = post_url;
    await delay(3500);

    // 找目標留言：在頁面所有 article / div 中找包含留言者名稱的那個
    const authorLower = (comment_author || "").toLowerCase().replace(/^@/, "");
    const hintLower   = (comment_text_hint || "").slice(0, 30).toLowerCase();

    let targetEl = null;

    // 嘗試找包含留言者名稱的節點
    const candidates = document.querySelectorAll("article, [role='article'], div[tabindex]");
    for (const el of candidates) {
      const text = el.innerText?.toLowerCase() || "";
      if (authorLower && text.includes(authorLower)) {
        if (!hintLower || text.includes(hintLower)) {
          targetEl = el;
          break;
        }
        if (!targetEl) targetEl = el; // 退而求其次只匹配作者
      }
    }

    if (targetEl) {
      // 嘗試在該節點附近點 Reply
      const replyBtn = [...targetEl.querySelectorAll("button, span[role='button']")]
        .find(b => b.innerText?.match(/Reply|回覆/i));
      if (replyBtn) {
        replyBtn.click();
        await delay(800);
      }
    } else {
      // 找不到特定留言，fallback：點貼文底部的主留言框
      const mainReplyBtn = document.querySelector('[aria-label*="Reply"], [aria-label*="留言"]');
      if (mainReplyBtn) { mainReplyBtn.click(); await delay(800); }
    }

    // 找輸入框
    const input = document.querySelector('[contenteditable="true"][role="textbox"]')
                  || document.querySelector('textarea[placeholder*="Reply"]');
    if (!input) return { success: false, detail: "找不到回覆輸入框" };

    input.focus();
    document.execCommand("insertText", false, reply_text);
    await delay(500);

    const submitBtn = [...document.querySelectorAll("button")].find(b =>
      b.innerText?.match(/Post|發布|Reply|回覆/i)
    );
    if (!submitBtn) return { success: false, detail: "找不到送出按鈕" };
    submitBtn.click();
    await delay(1000);

    return { success: true, detail: `回覆成功：${reply_text.slice(0, 30)}` };
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
