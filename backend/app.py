"""
app.py — 5888小編助手 雲端後端
部署到 Railway / Render 後，Extension 和用戶瀏覽器都連這裡
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

from flask import Flask, request, jsonify, session, render_template, redirect

from modules.db import (
    init_db, get_or_create_user, get_user, get_all_users,
    add_credits, set_blocked, deduct_credit,
    get_accounts, add_account, update_account, delete_account, get_account,
    push_task, pop_pending_tasks, complete_task, get_task_result,
    get_schedules, add_schedule, update_schedule, toggle_schedule, delete_schedule,
    get_due_schedules, mark_schedule_run, advance_fixed_index,
    get_patrol_config, save_patrol_config, pop_next_phrase, pop_next_keyword,
    log_action, get_action_log,
)

TAIWAN_TZ  = timezone(timedelta(hours=8))
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")   # 你的 Google 帳號 email

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "5888cloud-secret-change-me")
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"] = True

init_db()


# ── CORS（允許 Chrome Extension 跨域帶 Cookie） ────────────────────────────────

@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if origin.startswith("chrome-extension://"):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    return response


@app.route("/ext/<path:subpath>", methods=["OPTIONS"])
@app.route("/auth/<path:subpath>", methods=["OPTIONS"])
@app.route("/api/<path:subpath>", methods=["OPTIONS"])
def cors_preflight(subpath):
    return "", 204


# ── Google OAuth ──────────────────────────────────────────────────────────────

GOOGLE_CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")


@app.route("/auth/google", methods=["POST"])
def auth_google():
    """Extension 或前端傳入 Google ID Token，驗證後建立 session。"""
    from google.oauth2 import id_token
    from google.auth.transport import requests as google_requests

    credential = (request.json or {}).get("credential", "")
    try:
        info = id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
        email = info["email"]
        name  = info.get("name", "")
        user  = get_or_create_user(email, name)
        session["email"] = email
        session["name"]  = name
        return jsonify({"success": True, "user": {
            "email": email, "name": name, "credits": user["credits"]
        }})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 401


@app.route("/auth/status")
def auth_status():
    email = session.get("email")
    if not email:
        return jsonify({"logged_in": False})
    user = get_user(email)
    if not user:
        return jsonify({"logged_in": False})
    return jsonify({
        "logged_in": True,
        "email": email,
        "name": session.get("name", ""),
        "credits": user["credits"],
        "daily_used": user["daily_used"],
        "is_admin": email == ADMIN_EMAIL,
    })


@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"success": True})


# ── 頁面 ─────────────────────────────────────────────────────────────────────

@app.route("/")
def landing():
    return render_template("landing.html")


@app.route("/app")
def index():
    return render_template("index.html",
                           google_client_id=GOOGLE_CLIENT_ID)


# ── 帳號管理 ─────────────────────────────────────────────────────────────────

def _require_login():
    email = session.get("email")
    if not email:
        return None, jsonify({"success": False, "error": "請先登入"}), 401
    return email, None, None


@app.route("/api/accounts", methods=["GET"])
def api_get_accounts():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    accs = get_accounts(email)
    # 隱藏 token 完整內容
    for a in accs:
        t = a.get("access_token", "")
        a["token_preview"] = t[:8] + "..." if len(t) > 8 else t
        a.pop("access_token", None)
        a.pop("gemini_key", None)
    return jsonify({"success": True, "accounts": accs})


@app.route("/api/accounts", methods=["POST"])
def api_add_account():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data = request.json or {}
    if not data.get("name"):
        return jsonify({"success": False, "error": "帳號名稱為必填"}), 400
    acc = add_account(email, data)
    return jsonify({"success": True, "id": acc["id"]})


@app.route("/api/accounts/<acc_id>", methods=["PUT"])
def api_update_account(acc_id):
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    update_account(acc_id, email, request.json or {})
    return jsonify({"success": True})


@app.route("/api/accounts/<acc_id>", methods=["DELETE"])
def api_delete_account(acc_id):
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    delete_account(acc_id, email)
    return jsonify({"success": True})


# ── 點數 ─────────────────────────────────────────────────────────────────────

@app.route("/api/credits")
def api_credits():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    user = get_user(email)
    return jsonify({"success": True, "credits": user["credits"], "daily_used": user["daily_used"]})


# ── 排程 ─────────────────────────────────────────────────────────────────────

@app.route("/api/schedules", methods=["GET"])
def api_get_schedules():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    return jsonify({"success": True, "schedules": get_schedules(email)})


@app.route("/api/schedules", methods=["POST"])
def api_add_schedule():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data = request.json or {}
    if not data.get("name"):
        return jsonify({"success": False, "error": "名稱為必填"}), 400
    s = add_schedule(email, data)
    return jsonify({"success": True, "id": s["id"]})


@app.route("/api/schedules/<sid>", methods=["PUT"])
def api_update_schedule(sid):
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data = request.json or {}
    if "enabled" in data:
        toggle_schedule(sid, email, bool(data["enabled"]))
    else:
        update_schedule(sid, email, data)
    return jsonify({"success": True})


@app.route("/api/schedules/<sid>", methods=["DELETE"])
def api_delete_schedule(sid):
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    delete_schedule(sid, email)
    return jsonify({"success": True})


# ── Extension API（Extension 輪詢這些端點） ───────────────────────────────────

def _run_due_schedules(email: str):
    """檢查並執行到期的排程（直接用 Threads API 發文，不需要 Extension）。"""
    from modules.threads_api import create_post
    from modules.ai_reply import generate_schedule_post

    due = get_due_schedules(email)
    for sched in due:
        run_key = sched["_run_key"]
        mark_schedule_run(sched["id"], run_key)  # 先標記避免重複

        acc = get_account(sched["account_id"], email)
        if not acc or not acc.get("access_token"):
            continue

        result = deduct_credit(email)
        if not result["ok"]:
            continue

        try:
            text = ""
            if sched["content_mode"] == "fixed":
                texts = json.loads(sched.get("fixed_texts") or "[]")
                if texts:
                    idx  = sched.get("fixed_index", 0)
                    text = texts[idx % len(texts)]
                    advance_fixed_index(sched["id"], idx, len(texts))
            if not text:
                gemini_key = acc.get("gemini_key", "")
                prompt     = sched.get("ai_prompt", "") or "寫一篇今日心情短文"
                gen        = generate_schedule_post(gemini_key, acc, prompt)
                text       = gen.get("text", "")

            if text:
                post_result = create_post(acc["access_token"], text)
                if post_result["success"]:
                    log_action(email, "schedule_post", text[:100])
                else:
                    add_credits(email, 1)  # 發文失敗退點
        except Exception:
            add_credits(email, 1)


@app.route("/ext/tasks", methods=["GET"])
def ext_get_tasks():
    """Extension 輪詢：取得待執行任務列表，同時觸發排程。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    threading.Thread(target=_run_due_schedules, args=(email,), daemon=True).start()
    tasks = pop_pending_tasks(email)
    return jsonify({"success": True, "tasks": tasks})


@app.route("/ext/done", methods=["POST"])
def ext_task_done():
    """Extension 回報：任務完成，扣點。"""
    email   = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data    = request.json or {}
    task_id = data.get("task_id")
    success = data.get("success", False)
    detail  = data.get("detail", "")
    posts   = data.get("posts", [])

    if not task_id:
        return jsonify({"success": False, "error": "缺少 task_id"}), 400

    complete_task(task_id, success, posts if posts else None)

    if success:
        result = deduct_credit(email)
        if not result["ok"]:
            return jsonify({"success": False, "error": result["reason"]})
        log_action(email, data.get("type", "action"), detail)

    return jsonify({"success": True})


@app.route("/ext/deduct", methods=["POST"])
def ext_deduct():
    """Extension 即時動作（留言/發文）時直接扣點。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    result = deduct_credit(email)
    if result["ok"]:
        log_action(email, data.get("type", "action"), data.get("detail", ""))
    return jsonify(result)


# ── AI 生成 ───────────────────────────────────────────────────────────────────

@app.route("/api/ai/generate", methods=["POST"])
def api_ai_generate():
    """用帳號自己的 Gemini Key 生成貼文（不扣點）。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    acc_id = data.get("account_id")
    prompt = data.get("prompt", "")

    acc = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404

    gemini_key = acc.get("gemini_key") or data.get("gemini_key", "")
    if not gemini_key:
        return jsonify({"success": False, "error": "請先設定 Gemini API Key"}), 400

    from modules.ai_reply import generate_schedule_post
    return jsonify(generate_schedule_post(gemini_key, acc, prompt))


@app.route("/api/ai/editor-reply", methods=["POST"])
def api_ai_editor_reply():
    """AI 小編模式：針對自己貼文收到的留言，生成品牌口吻的回覆（不扣點）。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    acc_id = data.get("account_id")
    acc    = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404

    gemini_key = acc.get("gemini_key") or data.get("gemini_key", "")
    if not gemini_key:
        return jsonify({"success": False, "error": "請先設定 Gemini API Key"}), 400

    from modules.ai_reply import generate_editor_reply
    return jsonify(generate_editor_reply(
        gemini_key, acc,
        data.get("post_text", ""),
        data.get("comment_author", ""),
        data.get("comment_text", ""),
        data.get("product_title", ""),
        data.get("product_url", ""),
    ))


@app.route("/api/ai/patrol-comment", methods=["POST"])
def api_ai_patrol_comment():
    """針對指定貼文生成留言（不扣點）。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    acc_id = data.get("account_id")
    acc    = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404

    gemini_key = acc.get("gemini_key") or data.get("gemini_key", "")
    if not gemini_key:
        return jsonify({"success": False, "error": "請先設定 Gemini API Key"}), 400

    from modules.ai_reply import generate_patrol_comment
    return jsonify(generate_patrol_comment(
        gemini_key, acc, data.get("post_text", "")
    ))


@app.route("/api/editor/send-reply", methods=["POST"])
def api_editor_send_reply():
    """推送回覆留言任務到 Extension（扣 1 點）。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data = request.json or {}
    post_url    = data.get("post_url", "").strip()
    reply_text  = data.get("reply_text", "").strip()
    acc_id      = data.get("account_id", "")
    if not post_url or not reply_text:
        return jsonify({"success": False, "error": "缺少貼文連結或回覆內容"}), 400
    task_id = push_task(email, acc_id, "reply_comment", {
        "post_url":          post_url,
        "comment_author":    data.get("comment_author", ""),
        "comment_text_hint": data.get("comment_text", "")[:30],
        "reply_text":        reply_text,
    })
    return jsonify({"success": True, "task_id": task_id})


@app.route("/api/patrol/comment", methods=["POST"])
def api_patrol_comment():
    """推送留言任務到 Extension。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data     = request.json or {}
    post_url = data.get("post_url", "")
    comment  = data.get("comment", "").strip()
    acc_id   = data.get("account_id", "")
    if not post_url or not comment:
        return jsonify({"success": False, "error": "缺少必填欄位"}), 400
    task_id = push_task(email, acc_id, "comment", {"post_url": post_url, "comment_text": comment})
    return jsonify({"success": True, "task_id": task_id})


@app.route("/api/ai/trending-rewrite", methods=["POST"])
def api_trending_rewrite():
    """熱門話題改寫（不扣點）。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    acc_id = data.get("account_id")
    acc    = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404

    gemini_key = acc.get("gemini_key") or data.get("gemini_key", "")
    from modules.ai_reply import generate_trending_post
    return jsonify(generate_trending_post(
        gemini_key, acc,
        data.get("title", ""), data.get("summary", ""), data.get("source", "")
    ))


# ── 熱門話題 ──────────────────────────────────────────────────────────────────

@app.route("/api/trending")
def api_trending():
    source = request.args.get("source", "google_news")
    hours  = int(request.args.get("hours", 24))
    from modules.trending import fetch_trending
    return jsonify(fetch_trending(source, hours))


# ── 發文（扣點） ──────────────────────────────────────────────────────────────

@app.route("/api/post", methods=["POST"])
def api_post():
    """直接透過 Threads API 發文，扣 1 點。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data   = request.json or {}
    acc_id = data.get("account_id")
    text   = (data.get("text") or "").strip()

    if not text:
        return jsonify({"success": False, "error": "內容不能空白"}), 400

    acc = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404
    if not acc.get("access_token"):
        return jsonify({"success": False, "error": "帳號尚未設定 Threads API Token"}), 400

    # 先扣點
    result = deduct_credit(email)
    if not result["ok"]:
        return jsonify({"success": False, "error": result["reason"]})

    from modules.threads_api import create_post
    post_result = create_post(acc["access_token"], text)
    if post_result["success"]:
        log_action(email, "post", text[:100])
    else:
        # 發文失敗退回點數
        add_credits(email, 1)

    return jsonify(post_result)


# ── 管理員 ────────────────────────────────────────────────────────────────────

def _require_admin():
    email = session.get("email")
    if not email or email != ADMIN_EMAIL:
        return None, jsonify({"success": False, "error": "無權限"}), 403
    return email, None, None


@app.route("/api/admin/users")
def api_admin_users():
    email, err, code = _require_admin()
    if err:
        return err, code
    return jsonify({"success": True, "users": get_all_users()})


@app.route("/api/admin/add-credits", methods=["POST"])
def api_admin_add_credits():
    email, err, code = _require_admin()
    if err:
        return err, code
    data = request.json or {}
    add_credits(data["email"], int(data["amount"]))
    return jsonify({"success": True})


@app.route("/api/admin/set-blocked", methods=["POST"])
def api_admin_set_blocked():
    email, err, code = _require_admin()
    if err:
        return err, code
    data = request.json or {}
    set_blocked(data["email"], data["blocked"])
    return jsonify({"success": True})


# ── 使用記錄 ─────────────────────────────────────────────────────────────────

@app.route("/api/log")
def api_log():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    return jsonify({"success": True, "log": get_action_log(email)})


# ── 海巡設定 ──────────────────────────────────────────────────────────────────

@app.route("/api/patrol/config", methods=["GET"])
def api_patrol_config_get():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    return jsonify({"success": True, "config": get_patrol_config(email)})


@app.route("/api/patrol/config", methods=["PUT"])
def api_patrol_config_put():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    save_patrol_config(email, request.json or {})
    return jsonify({"success": True})


@app.route("/api/ai/patrol-keywords", methods=["POST"])
def api_ai_patrol_keywords():
    """根據產品描述 AI 生成海巡關鍵字。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data   = request.json or {}
    acc_id = data.get("account_id")
    acc    = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404
    gemini_key = acc.get("gemini_key") or data.get("gemini_key", "")
    if not gemini_key:
        return jsonify({"success": False, "error": "請先設定 Gemini API Key"}), 400
    from modules.ai_reply import generate_promo_keywords
    return jsonify(generate_promo_keywords(
        gemini_key, data.get("product_desc", ""), data.get("target_audience", "")
    ))


@app.route("/api/patrol/batch-comment", methods=["POST"])
def api_patrol_batch_comment():
    """批次建立留言任務：從關鍵字輪換中取一組，加上詞句庫輪換留言。"""
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401

    data     = request.json or {}
    posts    = data.get("posts", [])   # [{link, text}, ...]
    acc_id   = data.get("account_id", "")
    mode     = data.get("mode", "phrase")  # "phrase" | "ai" | "promo"
    acc      = get_account(acc_id, email)
    if not acc:
        return jsonify({"success": False, "error": "帳號不存在"}), 404

    cfg = get_patrol_config(email)
    max_c   = cfg.get("max_comments", 20)
    posts   = posts[:max_c]
    tasks   = []

    for post in posts:
        comment = ""
        if mode == "phrase":
            comment = pop_next_phrase(email)
        elif mode == "ai":
            gemini_key = acc.get("gemini_key", "")
            if gemini_key:
                from modules.ai_reply import generate_patrol_comment
                r = generate_patrol_comment(gemini_key, acc, post.get("text", ""))
                comment = r.get("comment", "") if r.get("success") else pop_next_phrase(email)
            else:
                comment = pop_next_phrase(email)
        elif mode == "promo":
            gemini_key = acc.get("gemini_key", "")
            product_desc = data.get("product_desc", "")
            product_url  = data.get("product_url", "")
            if gemini_key and product_desc:
                from modules.ai_reply import generate_promo_comment
                r = generate_promo_comment(gemini_key, post.get("text", ""), "", product_desc, product_url)
                comment = r.get("comment", "") if r.get("success") else ""
            if not comment:
                comment = pop_next_phrase(email)

        if comment:
            task_id = push_task(email, acc_id, "comment", {
                "post_url": post.get("link", ""),
                "comment_text": comment,
            })
            tasks.append({"task_id": task_id, "comment": comment, "post_url": post.get("link", "")})

    return jsonify({"success": True, "tasks": tasks, "count": len(tasks)})


# ── 海巡搜尋任務（Extension 輪詢後執行） ─────────────────────────────────────

@app.route("/api/patrol/search", methods=["POST"])
def api_patrol_search():
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    data       = request.json or {}
    account_id = data.get("account_id", "")
    keyword    = data.get("keyword", "")
    if not keyword:
        return jsonify({"success": False, "error": "關鍵字不能空白"}), 400
    task_id = push_task(email, account_id, "search", {"keyword": keyword})
    return jsonify({"success": True, "task_id": task_id})


@app.route("/api/patrol/result/<task_id>")
def api_patrol_result(task_id):
    email = session.get("email")
    if not email:
        return jsonify({"success": False, "error": "未登入"}), 401
    task = get_task_result(task_id, email)
    if not task:
        return jsonify({"success": False, "error": "找不到任務"}), 404
    return jsonify({
        "success": True,
        "status": task["status"],
        "posts": task.get("result") or [],
        "detail": task.get("payload", ""),
    })


# ── 啟動 ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("🚀 5888小編助手 雲端版啟動")
    app.run(debug=True, port=5001, host="0.0.0.0")
