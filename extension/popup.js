const CLOUD_URL = "https://prospective-dani-5888-4102b520.koyeb.app"; // 部署後填入

async function refreshStatus() {
  try {
    const res  = await fetch(`${CLOUD_URL}/auth/status`, { credentials: "include" });
    const data = await res.json();

    if (data.logged_in) {
      document.getElementById("loginView").style.display = "none";
      document.getElementById("mainView").style.display  = "block";
      document.getElementById("creditsNum").textContent  = data.credits;
      document.getElementById("dailyInfo").textContent   =
        `今日已用 ${data.daily_used} / 100 次`;
      document.getElementById("statusText").textContent  =
        `登入：${data.email}`;
    } else {
      document.getElementById("loginView").style.display = "block";
      document.getElementById("mainView").style.display  = "none";
    }
  } catch (e) {
    document.getElementById("statusText").textContent = "無法連線到伺服器";
  }
}

function openDashboard() {
  chrome.tabs.create({ url: CLOUD_URL });
}

function openBuyPage() {
  chrome.tabs.create({ url: `${CLOUD_URL}/#credits` });
}

async function runTest() {
  const box = document.getElementById("testResult");
  box.style.display = "block";
  box.style.color = "#64748b";
  box.textContent = "測試中…";
  try {
    // 1. 檢查登入
    const r1 = await fetch(`${CLOUD_URL}/auth/status`, { credentials: "include" });
    const d1 = await r1.json();
    if (!d1.logged_in) { box.style.color="#ef4444"; box.textContent = "❌ 未登入：請先點「前往登入」"; return; }
    // 2. 檢查 ext/tasks
    const r2 = await fetch(`${CLOUD_URL}/ext/tasks`, { credentials: "include" });
    if (r2.status === 401) { box.style.color="#ef4444"; box.textContent = "❌ 任務端點 401：Session 異常，請重新登入"; return; }
    const d2 = await r2.json();
    // 3. 檢查 Threads 分頁
    const tabs = await chrome.tabs.query({ url: ["*://www.threads.com/*","*://threads.net/*"] });
    const threadsOk = tabs.length > 0;
    box.style.color = "#16a34a";
    box.textContent = `✅ 登入：${d1.email}\n點數：${d1.credits}\n待執行任務：${d2.tasks?.length ?? 0} 個\nThreads 分頁：${threadsOk ? "開著" : "⚠️ 沒有（請開一個 threads.com）"}`;
  } catch(e) {
    box.style.color = "#ef4444";
    box.textContent = "❌ 連線失敗：" + e.message;
  }
}

document.getElementById("btnLogin").addEventListener("click", openDashboard);
document.getElementById("btnDashboard").addEventListener("click", openDashboard);
document.getElementById("btnTest").addEventListener("click", runTest);
document.getElementById("btnBuy").addEventListener("click", openBuyPage);

refreshStatus();
