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
            email       TEXT PRIMARY KEY,
            name        TEXT DEFAULT '',
            credits     INTEGER DEFAULT 0,
            daily_used  INTEGER DEFAULT 0,
            daily_date  TEXT DEFAULT '',
            blocked     INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now'))
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
            return dict(row)
        # 新用戶送 100 點
        c.execute(
            "INSERT INTO users (email, name, credits) VALUES (?,?,100)",
            (email, name)
        )
        return {"email": email, "name": name, "credits": 100, "daily_used": 0,
                "daily_date": "", "blocked": 0}


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


def complete_task(task_id: str, success: bool):
    with _lock, _conn() as c:
        status = "done" if success else "failed"
        c.execute(
            "UPDATE tasks SET status=?, executed_at=datetime('now') WHERE id=?",
            (status, task_id)
        )


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
