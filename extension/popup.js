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

document.getElementById("btnLogin").addEventListener("click", openDashboard);
document.getElementById("btnDashboard").addEventListener("click", openDashboard);
document.getElementById("btnRefresh").addEventListener("click", refreshStatus);
document.getElementById("btnBuy").addEventListener("click", openBuyPage);

refreshStatus();
