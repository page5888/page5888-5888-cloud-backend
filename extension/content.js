/**
 * content.js — 注入 Threads 頁面
 * 接收 background 的指令，實際執行搜尋/留言動作
 */

// 防止重複注入時重複綁定 listener
if (!window._5888_initialized) {
  window._5888_initialized = true;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 接收 background 指令 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleAction(msg).then(sendResponse).catch(e => sendResponse({ success: false, detail: e.message }));
  return true;
});

async function handleAction(msg) {
  switch (msg.action) {
    case "comment":         return await doComment(msg.payload);
    case "reply_comment":   return await doReplyComment(msg.payload);
    case "scrape":          return await doScrape(msg.payload);
    case "scrape_posts":    return await doScrapePosts();
    case "scrape_comments": return await doScrapeComments(msg.payload);
    case "post":            return await doPost(msg.payload);
    default:                return { success: false, detail: `未知動作: ${msg.action}` };
  }
}

// ── 抓取搜尋結果（background 已跳頁完成後才呼叫） ───────────────────────────
async function doScrape({ keyword }) {
  try {
    // 滾動頁面觸發 lazy load
    window.scrollTo(0, 600);
    await delay(800);
    window.scrollTo(0, 1200);
    await delay(600);
    window.scrollTo(0, 0);

    const posts = [];
    const seen  = new Set();

    // Threads 貼文連結可能是 /post/ 或 /t/ 兩種格式
    const anchors = [
      ...document.querySelectorAll("a[href*='/post/']"),
      ...document.querySelectorAll("a[href*='/t/']"),
    ];

    anchors.forEach(a => {
      const raw  = a.href || "";
      const link = raw.split("?")[0];
      // 過濾掉非貼文連結（/t/ 可能匹配到不相關路徑）
      if (!link) return;
      if (link.includes("/t/") && !/\/t\/[A-Za-z0-9_-]{5,}/.test(link)) return;
      if (seen.has(link)) return;
      seen.add(link);

      // 往上找有文字內容的容器（最多爬 10 層）
      let el = a.parentElement;
      let text = "";
      for (let i = 0; i < 10 && el; i++) {
        const t = el.innerText?.trim();
        if (t && t.length > 15) { text = t.slice(0, 300); break; }
        el = el.parentElement;
      }
      if (!text) text = a.innerText?.trim().slice(0, 300) || link;
      posts.push({ text, link });
    });

    if (posts.length === 0) {
      // 最後嘗試：抓頁面上所有帶文字的可點擊區域（暴力撈）
      document.querySelectorAll("[role='link'], [tabindex='0']").forEach(el => {
        const link = el.dataset?.href || el.getAttribute("href") || "";
        if (!link || seen.has(link)) return;
        if (!/\/(post|t)\//.test(link)) return;
        seen.add(link);
        const text = el.innerText?.trim().slice(0, 300) || link;
        posts.push({ text, link: link.startsWith("http") ? link : "https://www.threads.com" + link });
      });
    }

    return { success: true, posts, detail: `搜尋「${keyword}」找到 ${posts.length} 篇` };
  } catch (e) {
    return { success: false, detail: e.message };
  }
}

// ── 抓個人頁所有貼文連結 ─────────────────────────────────────────────────────
async function doScrapePosts() {
  try {
    const seen = new Set();
    const posts = [];
    document.querySelectorAll("a[href*='/post/']").forEach(a => {
      const url = a.href.split("?")[0];
      if (!url || seen.has(url)) return;
      seen.add(url);
      let el = a.parentElement;
      let text = "";
      for (let i = 0; i < 8 && el; i++) {
        const t = el.innerText?.trim();
        if (t && t.length > 20) { text = t.slice(0, 200); break; }
        el = el.parentElement;
      }
      posts.push({ url, text: text || url });
    });
    return { success: true, posts };
  } catch (e) {
    return { success: false, detail: e.message, posts: [] };
  }
}

// ── 抓貼文頁的留言 ───────────────────────────────────────────────────────────
async function doScrapeComments({ post_url, post_text }) {
  try {
    const comments = [];
    const seen = new Set();

    // 找所有類 article 容器；第一個通常是貼文本體，跳過
    const containers = [
      ...document.querySelectorAll("article, [role='article'], [data-pressable-container]")
    ];

    containers.forEach((el, idx) => {
      if (idx === 0) return; // 跳過貼文本體

      // 找留言者：@xxx 連結
      const profileLink = el.querySelector(
        "a[href*='threads.net/@'], a[href^='/@'], a[href*='instagram.com/']"
      );
      const authorMatch = profileLink?.href?.match(/@([^/?#]+)/);
      const commenter   = authorMatch ? authorMatch[1] : "";
      if (!commenter) return;

      // 留言文字：去掉開頭 commenter 名稱那行
      let commentText = (el.innerText || "").trim();
      commentText = commentText.replace(new RegExp(`^${commenter}\\s*\\n?`, "i"), "").trim();
      commentText = commentText.split("\n").slice(0, 4).join(" ").slice(0, 200);

      if (!commentText || seen.has(commenter + commentText)) return;
      seen.add(commenter + commentText);

      comments.push({ post_url, post_text: post_text || "", commenter, comment_text: commentText });
    });

    return { success: true, comments };
  } catch (e) {
    return { success: false, detail: e.message, comments: [] };
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

    window.location.href = "https://www.threads.com";
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

} // end if (!window._5888_initialized)
