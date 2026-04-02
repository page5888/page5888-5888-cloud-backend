"""
db.py — 資料庫（SQLite）
管理用戶、點數、任務、排程
"""
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

DB_PATH  = Path(__file__).parent.parent / "data" / "5888.db"
TAIWAN_TZ = timezone(timedelta(hours=8))
_lock    = threading.Lock()


def _conn():
    DB_PATH.parent.mkdir(exist_ok=True)
    c = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _lock, _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            email          TEXT PRIMARY KEY,
            name           TEXT DEFAULT '',
            credits        INTEGER DEFAULT 0,
            daily_used     INTEGER DEFAULT 0,
            daily_date     TEXT DEFAULT '',
            blocked        INTEGER DEFAULT 0,
            referral_code  TEXT DEFAULT '',
            referred_by    TEXT DEFAULT '',
            referral_count INTEGER DEFAULT 0,
            created_at     TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id           TEXT PRIMARY KEY,
            user_email   TEXT NOT NULL,
            name         TEXT NOT NULL,
            access_token TEXT DEFAULT '',
            persona      TEXT DEFAULT '',
            gemini_key   TEXT DEFAULT '',
            created_at   TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_email) REFERENCES users(email)
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id          TEXT PRIMARY KEY,
            user_email  TEXT NOT NULL,
            account_id  TEXT NOT NULL,
            type        TEXT NOT NULL,
            payload     TEXT DEFAULT '{}',
            status      TEXT DEFAULT 'pending',
            result      TEXT DEFAULT NULL,
            created_at  TEXT DEFAULT (datetime('now')),
            executed_at TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS schedules (
            id           TEXT PRIMARY KEY,
            user_email   TEXT NOT NULL,
            account_id   TEXT NOT NULL,
            name         TEXT NOT NULL,
            enabled      INTEGER DEFAULT 1,
            times        TEXT DEFAULT '[]',
            content_mode TEXT DEFAULT 'ai',
            ai_prompt    TEXT DEFAULT '',
            fixed_texts  TEXT DEFAULT '[]',
            fixed_index  INTEGER DEFAULT 0,
            last_run     TEXT DEFAULT '',
            created_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS patrol_config (
            user_email        TEXT PRIMARY KEY,
            keywords          TEXT DEFAULT '[]',
            kw_index          INTEGER DEFAULT 0,
            phrases           TEXT DEFAULT NULL,
            ph_index          INTEGER DEFAULT 0,
            max_comments      INTEGER DEFAULT 20,
            pause_after       INTEGER DEFAULT 10,
            pause_minutes     INTEGER DEFAULT 30,
            auto_enabled      INTEGER DEFAULT 0,
            auto_interval     INTEGER DEFAULT 30,
            auto_mode         TEXT DEFAULT 'phrase',
            auto_account_id   TEXT DEFAULT '',
            auto_last_run     TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS action_log (
            id         TEXT PRIMARY KEY,
            user_email TEXT NOT NULL,
            type       TEXT NOT NULL,
            detail     TEXT DEFAULT '',
            cost       INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        """)


# ── 用戶 ─────────────────────────────────────────────────────────────────────

def get_or_create_user(email: str, name: str = "") -> dict:
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if row:
            # 確保老用戶有推薦碼
            d = dict(row)
            if not d.get("referral_code"):
                code = _make_referral_code(email)
                c.execute("UPDATE users SET referral_code=? WHERE email=?", (code, email))
                d["referral_code"] = code
            return d
        # 新用戶：送 100 點 + 生成推薦碼
        code = _make_referral_code(email)
        c.execute(
            "INSERT INTO users (email, name, credits, referral_code) VALUES (?,?,100,?)",
            (email, name, code)
        )
        return {"email": email, "name": name, "credits": 100, "daily_used": 0,
                "daily_date": "", "blocked": 0, "referral_code": code}


def get_user(email: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        return dict(row) if row else None


def get_all_users() -> list:
    with _lock, _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM users ORDER BY created_at DESC")]


def add_credits(email: str, amount: int):
    with _lock, _conn() as c:
        c.execute("UPDATE users SET credits = credits + ? WHERE email=?", (amount, email))


def set_blocked(email: str, blocked: bool):
    with _lock, _conn() as c:
        c.execute("UPDATE users SET blocked=? WHERE email=?", (int(blocked), email))


DAILY_LIMIT = 100

def deduct_credit(email: str) -> dict:
    """
    扣 1 點。同時檢查：有無點數、今日是否超過 100 次上限。
    回傳 {"ok": True} 或 {"ok": False, "reason": str}
    """
    today = datetime.now(TAIWAN_TZ).strftime("%Y-%m-%d")
    with _lock, _conn() as c:
        user = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not user:
            return {"ok": False, "reason": "帳號不存在"}
        if user["blocked"]:
            return {"ok": False, "reason": "帳號已被封鎖"}
        if user["credits"] <= 0:
            return {"ok": False, "reason": "點數不足，請儲值"}

        daily_used = user["daily_used"] if user["daily_date"] == today else 0
        if daily_used >= DAILY_LIMIT:
            return {"ok": False, "reason": f"今日已達每日上限 {DAILY_LIMIT} 次"}

        new_daily = daily_used + 1
        c.execute(
            "UPDATE users SET credits=credits-1, daily_used=?, daily_date=? WHERE email=?",
            (new_daily, today, email)
        )
        return {"ok": True}


# ── 帳號 ─────────────────────────────────────────────────────────────────────

def get_accounts(user_email: str) -> list:
    with _lock, _conn() as c:
        return [dict(r) for r in
                c.execute("SELECT * FROM accounts WHERE user_email=?", (user_email,))]


def add_account(user_email: str, data: dict) -> dict:
    acc_id = str(uuid.uuid4())[:8]
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO accounts (id, user_email, name, access_token, persona, gemini_key) VALUES (?,?,?,?,?,?)",
            (acc_id, user_email, data.get("name",""), data.get("access_token",""),
             data.get("persona",""), data.get("gemini_key",""))
        )
    return {"id": acc_id, **data}


def update_account(acc_id: str, user_email: str, data: dict):
    with _lock, _conn() as c:
        c.execute(
            """UPDATE accounts SET name=?, access_token=?, persona=?, gemini_key=?
               WHERE id=? AND user_email=?""",
            (data.get("name",""), data.get("access_token",""),
             data.get("persona",""), data.get("gemini_key",""),
             acc_id, user_email)
        )


def delete_account(acc_id: str, user_email: str):
    with _lock, _conn() as c:
        c.execute("DELETE FROM accounts WHERE id=? AND user_email=?", (acc_id, user_email))


def get_account(acc_id: str, user_email: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT * FROM accounts WHERE id=? AND user_email=?", (acc_id, user_email)
        ).fetchone()
        return dict(row) if row else None


# ── 任務（Extension 輪詢用） ──────────────────────────────────────────────────

def push_task(user_email: str, account_id: str, task_type: str, payload: dict) -> str:
    task_id = str(uuid.uuid4())[:12]
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO tasks (id, user_email, account_id, type, payload) VALUES (?,?,?,?,?)",
            (task_id, user_email, account_id, task_type, json.dumps(payload))
        )
    return task_id


def pop_pending_tasks(user_email: str) -> list:
    """Extension 呼叫：取得所有 pending 任務並標記為 running。"""
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM tasks WHERE user_email=? AND status='pending' ORDER BY created_at LIMIT 20",
            (user_email,)
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            c.execute(
                f"UPDATE tasks SET status='running' WHERE id IN ({','.join('?'*len(ids))})",
                ids
            )
        return [dict(r) for r in rows]


def complete_task(task_id: str, success: bool, result: list = None):
    with _lock, _conn() as c:
        status = "done" if success else "failed"
        c.execute(
            "UPDATE tasks SET status=?, executed_at=datetime('now'), result=? WHERE id=?",
            (status, json.dumps(result) if result is not None else None, task_id)
        )


def get_task_result(task_id: str, user_email: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT * FROM tasks WHERE id=? AND user_email=?", (task_id, user_email)
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["result"] = json.loads(d["result"]) if d.get("result") else []
        return d


# ── 排程 ─────────────────────────────────────────────────────────────────────

def get_schedules(user_email: str) -> list:
    with _lock, _conn() as c:
        return [dict(r) for r in
                c.execute("SELECT * FROM schedules WHERE user_email=? ORDER BY created_at DESC", (user_email,))]


def add_schedule(user_email: str, data: dict) -> dict:
    sid = str(uuid.uuid4())[:12]
    with _lock, _conn() as c:
        c.execute(
            """INSERT INTO schedules
               (id, user_email, account_id, name, enabled, times, content_mode, ai_prompt, fixed_texts)
               VALUES (?,?,?,?,1,?,?,?,?)""",
            (sid, user_email,
             data.get("account_id", ""),
             data.get("name", "排程"),
             json.dumps(data.get("times", [])),
             data.get("content_mode", "ai"),
             data.get("ai_prompt", ""),
             json.dumps(data.get("fixed_texts", [])))
        )
    return {"id": sid, **data}


def update_schedule(sid: str, user_email: str, data: dict):
    with _lock, _conn() as c:
        c.execute(
            """UPDATE schedules SET name=?, account_id=?, times=?, content_mode=?,
               ai_prompt=?, fixed_texts=? WHERE id=? AND user_email=?""",
            (data.get("name",""), data.get("account_id",""),
             json.dumps(data.get("times",[])), data.get("content_mode","ai"),
             data.get("ai_prompt",""), json.dumps(data.get("fixed_texts",[])),
             sid, user_email)
        )


def toggle_schedule(sid: str, user_email: str, enabled: bool):
    with _lock, _conn() as c:
        c.execute("UPDATE schedules SET enabled=? WHERE id=? AND user_email=?",
                  (int(enabled), sid, user_email))


def delete_schedule(sid: str, user_email: str):
    with _lock, _conn() as c:
        c.execute("DELETE FROM schedules WHERE id=? AND user_email=?", (sid, user_email))


def get_due_schedules(user_email: str) -> list:
    """取得現在應該執行的排程（每分鐘最多觸發一次）。"""
    now     = datetime.now(TAIWAN_TZ)
    today   = now.strftime("%Y-%m-%d")
    cur_hm  = now.strftime("%H:%M")
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM schedules WHERE user_email=? AND enabled=1", (user_email,)
        ).fetchall()
        due = []
        for r in rows:
            r = dict(r)
            times    = json.loads(r.get("times") or "[]")
            last_run = r.get("last_run") or ""
            run_key  = f"{today} {cur_hm}"
            if cur_hm in times and last_run != run_key:
                r["_run_key"] = run_key
                due.append(r)
        return due


def mark_schedule_run(sid: str, run_key: str):
    with _lock, _conn() as c:
        c.execute("UPDATE schedules SET last_run=? WHERE id=?", (run_key, sid))


def advance_fixed_index(sid: str, current: int, total: int):
    with _lock, _conn() as c:
        c.execute("UPDATE schedules SET fixed_index=? WHERE id=?",
                  ((current + 1) % max(total, 1), sid))


# ── 海巡設定 ─────────────────────────────────────────────────────────────────

DEFAULT_PHRASES = [
    "留友看", "先留個言等下看", "先收藏等", "標記一下", "先占位", "先記著",
    "卡一個", "坐等後續", "蹲", "敲碗", "期待！", "等等等等",
    "推給演算法", "演算法帶我來的", "幫推一下",
    "推推！", "推爆！", "頂一個", "讚讚", "強！",
    "真的！", "同感！", "確實", "深有同感", "這個我懂",
    "感謝分享", "學到了", "內容很棒", "謝謝分享", "有用！",
    "哈哈哈哈", "笑死", "太真實了", "完全說中我",
    "支持！", "加油！", "繼續更新！", "等你的下一篇",
    "好奇想了解更多", "可以說更詳細嗎", "這是哪裡有的",
    "我也想要！", "在哪買得到", "求連結",
    "剛好需要這個", "來得正是時候", "看到這篇賺到了",
    "好想試試看", "馬上去查", "存起來回頭研究",
]


def _migrate_users():
    """補齊舊版 users 表缺少的欄位。"""
    new_cols = [
        ("referral_code",  "TEXT DEFAULT ''"),
        ("referred_by",    "TEXT DEFAULT ''"),
        ("referral_count", "INTEGER DEFAULT 0"),
    ]
    with _lock, _conn() as c:
        for col, definition in new_cols:
            try:
                c.execute(f"ALTER TABLE users ADD COLUMN {col} {definition}")
            except Exception:
                pass


_migrate_users()


def _make_referral_code(email: str) -> str:
    """生成 8 位英數推薦碼（固定且唯一）。"""
    import hashlib
    h = hashlib.md5(email.encode()).hexdigest()[:8].upper()
    return h


def ensure_referral_code(email: str) -> str:
    """確保用戶有推薦碼，沒有的話自動生成。"""
    with _lock, _conn() as c:
        row = c.execute("SELECT referral_code FROM users WHERE email=?", (email,)).fetchone()
        if not row:
            return ""
        code = row["referral_code"] or ""
        if not code:
            code = _make_referral_code(email)
            c.execute("UPDATE users SET referral_code=? WHERE email=?", (code, email))
        return code


def get_user_by_referral_code(code: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM users WHERE referral_code=?", (code.upper(),)).fetchone()
        return dict(row) if row else None


REFERRAL_BONUS = 100

def process_referral(new_email: str, ref_code: str) -> bool:
    """新用戶首次登入時處理推薦獎勵，回傳是否成功發放。"""
    if not ref_code:
        return False
    referrer = get_user_by_referral_code(ref_code)
    if not referrer or referrer["email"] == new_email:
        return False
    with _lock, _conn() as c:
        # 確認新用戶還沒有被推薦過（避免重複）
        row = c.execute("SELECT referred_by FROM users WHERE email=?", (new_email,)).fetchone()
        if not row or row["referred_by"]:
            return False
        # 記錄推薦關係 + 給推薦人加點
        c.execute("UPDATE users SET referred_by=? WHERE email=?", (ref_code, new_email))
        c.execute(
            "UPDATE users SET credits=credits+?, referral_count=referral_count+1 WHERE email=?",
            (REFERRAL_BONUS, referrer["email"])
        )
    return True


def get_referral_stats(email: str) -> dict:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT referral_code, referral_count FROM users WHERE email=?", (email,)
        ).fetchone()
        if not row:
            return {"code": "", "count": 0, "earned": 0}
        return {
            "code":   row["referral_code"] or "",
            "count":  row["referral_count"] or 0,
            "earned": (row["referral_count"] or 0) * REFERRAL_BONUS,
        }


def _migrate_patrol_config():
    """補齊舊版資料庫缺少的欄位。"""
    new_cols = [
        ("auto_enabled",    "INTEGER DEFAULT 0"),
        ("auto_interval",   "INTEGER DEFAULT 30"),
        ("auto_mode",       "TEXT DEFAULT 'phrase'"),
        ("auto_account_id", "TEXT DEFAULT ''"),
        ("auto_last_run",   "TEXT DEFAULT ''"),
    ]
    with _lock, _conn() as c:
        for col, definition in new_cols:
            try:
                c.execute(f"ALTER TABLE patrol_config ADD COLUMN {col} {definition}")
            except Exception:
                pass  # 欄位已存在，忽略


_migrate_patrol_config()


def get_patrol_config(user_email: str) -> dict:
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM patrol_config WHERE user_email=?", (user_email,)).fetchone()
        if row:
            d = dict(row)
            d["phrases"]  = json.loads(d["phrases"]) if d.get("phrases") else DEFAULT_PHRASES[:]
            d["keywords"] = json.loads(d.get("keywords") or "[]")
            return d
        return {
            "user_email": user_email,
            "keywords": [], "kw_index": 0,
            "phrases": DEFAULT_PHRASES[:],
            "ph_index": 0,
            "max_comments": 20, "pause_after": 10, "pause_minutes": 30,
            "auto_enabled": 0, "auto_interval": 30,
            "auto_mode": "phrase", "auto_account_id": "", "auto_last_run": "",
        }


def save_patrol_config(user_email: str, data: dict):
    with _lock, _conn() as c:
        c.execute("""
            INSERT INTO patrol_config (user_email, keywords, kw_index, phrases, ph_index,
                                       max_comments, pause_after, pause_minutes,
                                       auto_enabled, auto_interval, auto_mode,
                                       auto_account_id, auto_last_run)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_email) DO UPDATE SET
                keywords=excluded.keywords, kw_index=excluded.kw_index,
                phrases=excluded.phrases, ph_index=excluded.ph_index,
                max_comments=excluded.max_comments,
                pause_after=excluded.pause_after,
                pause_minutes=excluded.pause_minutes,
                auto_enabled=excluded.auto_enabled,
                auto_interval=excluded.auto_interval,
                auto_mode=excluded.auto_mode,
                auto_account_id=excluded.auto_account_id
        """, (user_email,
              json.dumps(data.get("keywords", [])),
              int(data.get("kw_index", 0)),
              json.dumps(data.get("phrases", DEFAULT_PHRASES)),
              int(data.get("ph_index", 0)),
              int(data.get("max_comments", 20)),
              int(data.get("pause_after", 10)),
              int(data.get("pause_minutes", 30)),
              int(data.get("auto_enabled", 0)),
              int(data.get("auto_interval", 30)),
              str(data.get("auto_mode", "phrase")),
              str(data.get("auto_account_id", "")),
              str(data.get("auto_last_run", ""))))


def should_auto_patrol(user_email: str) -> bool:
    """判斷是否到了自動海巡的時間。"""
    cfg = get_patrol_config(user_email)
    if not cfg.get("auto_enabled"):
        return False
    if not cfg.get("keywords"):
        return False
    if not cfg.get("auto_account_id"):
        return False
    interval = int(cfg.get("auto_interval", 30))
    last_run = cfg.get("auto_last_run", "")
    if not last_run:
        return True
    try:
        last = datetime.fromisoformat(last_run)
        elapsed = (datetime.now(TAIWAN_TZ) - last).total_seconds() / 60
        return elapsed >= interval
    except Exception:
        return True


def mark_auto_patrol_run(user_email: str):
    now = datetime.now(TAIWAN_TZ).isoformat()
    with _lock, _conn() as c:
        c.execute("""
            INSERT INTO patrol_config (user_email, auto_last_run)
            VALUES (?,?)
            ON CONFLICT(user_email) DO UPDATE SET auto_last_run=excluded.auto_last_run
        """, (user_email, now))


def get_task_payload(task_id: str) -> dict:
    with _lock, _conn() as c:
        row = c.execute("SELECT payload FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row:
            try:
                return json.loads(row["payload"])
            except Exception:
                return {}
        return {}


def pop_next_phrase(user_email: str) -> str:
    """取得下一句詞句並推進索引。"""
    cfg = get_patrol_config(user_email)
    phrases = cfg["phrases"] or DEFAULT_PHRASES[:]
    idx = cfg.get("ph_index", 0) % max(len(phrases), 1)
    phrase = phrases[idx]
    new_idx = (idx + 1) % max(len(phrases), 1)
    with _lock, _conn() as c:
        c.execute("""
            INSERT INTO patrol_config (user_email, ph_index)
            VALUES (?,?)
            ON CONFLICT(user_email) DO UPDATE SET ph_index=excluded.ph_index
        """, (user_email, new_idx))
    return phrase


def pop_next_keyword(user_email: str) -> str:
    """取得下一組關鍵字並推進索引。"""
    cfg = get_patrol_config(user_email)
    keywords = cfg["keywords"]
    if not keywords:
        return ""
    idx = cfg.get("kw_index", 0) % len(keywords)
    kw = keywords[idx]
    new_idx = (idx + 1) % len(keywords)
    with _lock, _conn() as c:
        c.execute("""
            INSERT INTO patrol_config (user_email, kw_index)
            VALUES (?,?)
            ON CONFLICT(user_email) DO UPDATE SET kw_index=excluded.kw_index
        """, (user_email, new_idx))
    return kw


# ── 行動記錄 ─────────────────────────────────────────────────────────────────

def log_action(user_email: str, action_type: str, detail: str = "", cost: int = 1):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO action_log (id, user_email, type, detail, cost) VALUES (?,?,?,?,?)",
            (str(uuid.uuid4())[:12], user_email, action_type, detail, cost)
        )


def get_action_log(user_email: str, limit: int = 50) -> list:
    with _lock, _conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM action_log WHERE user_email=? ORDER BY created_at DESC LIMIT ?",
            (user_email, limit)
        )]
