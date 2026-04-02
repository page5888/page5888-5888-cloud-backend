"""
trending.py — 熱門話題抓取
支援來源：PTT 熱門看板、Google 新聞 RSS、Yahoo 新聞 RSS
"""
import re
import requests
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET
from bs4 import BeautifulSoup

TAIWAN_TZ = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def _cutoff(hours: int) -> datetime:
    return datetime.now(TAIWAN_TZ) - timedelta(hours=hours)


def _parse_rss_dt(s: str):
    try:
        return parsedate_to_datetime(s).astimezone(TAIWAN_TZ)
    except Exception:
        return None


def fetch_google_news(hours: int = 24, max_items: int = 15) -> list:
    cutoff = _cutoff(hours)
    results = []
    try:
        url = "https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
        resp = requests.get(url, headers=HEADERS, timeout=15)
        root = ET.fromstring(resp.content)
        channel = root.find("channel")
        for item in channel.findall("item"):
            title = item.findtext("title", "").strip()
            link = item.findtext("link", "").strip()
            pub_str = item.findtext("pubDate", "")
            desc = re.sub(r"<[^>]+>", "", item.findtext("description", ""))[:200].strip()

            pub_dt = _parse_rss_dt(pub_str)
            if pub_dt and pub_dt < cutoff:
                continue
            time_str = pub_dt.strftime("%m/%d %H:%M") if pub_dt else pub_str[:16]

            results.append({
                "title": title, "source": "Google 新聞",
                "link": link, "summary": desc, "time": time_str, "nrec": "",
            })
            if len(results) >= max_items:
                break
    except Exception as e:
        print(f"[Google News] {e}")
    return results


def fetch_yahoo_news(hours: int = 24, max_items: int = 15) -> list:
    cutoff = _cutoff(hours)
    results = []
    try:
        url = "https://tw.news.yahoo.com/rss"
        resp = requests.get(url, headers=HEADERS, timeout=15)
        root = ET.fromstring(resp.content)
        channel = root.find("channel")
        if channel is None:
            return results
        for item in channel.findall("item"):
            title = item.findtext("title", "").strip()
            link = item.findtext("link", "").strip()
            pub_str = item.findtext("pubDate", "")
            desc = re.sub(r"<[^>]+>", "", item.findtext("description", ""))[:200].strip()

            pub_dt = _parse_rss_dt(pub_str)
            if pub_dt and pub_dt < cutoff:
                continue
            time_str = pub_dt.strftime("%m/%d %H:%M") if pub_dt else pub_str[:16]

            results.append({
                "title": title, "source": "Yahoo 新聞",
                "link": link, "summary": desc, "time": time_str, "nrec": "",
            })
            if len(results) >= max_items:
                break
    except Exception as e:
        print(f"[Yahoo News] {e}")
    return results


def fetch_ptt_hot(hours: int = 24, max_items: int = 15) -> list:
    results = []
    boards = ["Gossiping", "HatePolitics", "NBA", "Baseball", "Beauty", "Tech_Job"]
    headers = {**HEADERS, "Cookie": "over18=1"}

    for board in boards:
        if len(results) >= max_items:
            break
        try:
            url = f"https://www.ptt.cc/bbs/{board}/index.html"
            resp = requests.get(url, headers=headers, timeout=10)
            soup = BeautifulSoup(resp.text, "html.parser")
            for ent in soup.select(".r-list-container .r-ent"):
                title_el = ent.select_one(".title a")
                if not title_el:
                    continue
                date_el = ent.select_one(".date")
                nrec_el = ent.select_one(".nrec span")
                results.append({
                    "title": title_el.text.strip(),
                    "source": f"PTT/{board}",
                    "link": "https://www.ptt.cc" + title_el["href"],
                    "summary": "",
                    "time": date_el.text.strip() if date_el else "",
                    "nrec": nrec_el.text.strip() if nrec_el else "",
                })
                if len(results) >= max_items:
                    break
        except Exception as e:
            print(f"[PTT/{board}] {e}")

    return results


def fetch_trending(source: str, hours: int) -> dict:
    if source == "ptt":
        items = fetch_ptt_hot(hours=hours)
    elif source == "yahoo_news":
        items = fetch_yahoo_news(hours=hours)
    else:
        items = fetch_google_news(hours=hours)

    if not items:
        return {"success": False, "error": "找不到話題，請確認網路或換個來源試試"}
    return {"success": True, "items": items}
