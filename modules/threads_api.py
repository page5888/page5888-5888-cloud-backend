"""
threads_api.py — Threads 官方 API 操作（發回覆、取得用戶資訊）
"""

import time
import requests

API_BASE = "https://graph.threads.net/v1.0"


def get_user_info(token: str) -> dict:
    """取得帳號資訊，用於驗證 token 是否有效。"""
    try:
        r = requests.get(
            f"{API_BASE}/me",
            params={"fields": "id,username,name", "access_token": token},
            timeout=10,
        )
        r.raise_for_status()
        return {"success": True, "data": r.json()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_my_posts(token: str, limit: int = 10) -> dict:
    """取得自己最近的貼文列表（含 id、text、timestamp）。"""
    try:
        info = get_user_info(token)
        if not info["success"]:
            return {"success": False, "error": info["error"]}
        user_id = info["data"]["id"]

        r = requests.get(
            f"{API_BASE}/{user_id}/threads",
            params={
                "fields": "id,text,timestamp,reply_count",
                "limit": limit,
                "access_token": token,
            },
            timeout=10,
        )
        r.raise_for_status()
        return {"success": True, "posts": r.json().get("data", [])}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_post_replies(token: str, media_id: str) -> dict:
    """取得指定貼文的直接留言（一層回覆）。"""
    try:
        r = requests.get(
            f"{API_BASE}/{media_id}/replies",
            params={
                "fields": "id,text,username,timestamp",
                "access_token": token,
            },
            timeout=10,
        )
        r.raise_for_status()
        return {"success": True, "replies": r.json().get("data", [])}
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_post(token: str, text: str) -> dict:
    """建立新 Threads 貼文（非回覆）。"""
    try:
        info = get_user_info(token)
        if not info["success"]:
            return {"success": False, "error": info["error"]}
        user_id = info["data"]["id"]

        r = requests.post(
            f"{API_BASE}/{user_id}/threads",
            params={"media_type": "TEXT", "text": text, "access_token": token},
            timeout=15,
        )
        if r.status_code != 200:
            return {"success": False, "error": r.text}

        creation_id = r.json()["id"]
        time.sleep(2)

        r = requests.post(
            f"{API_BASE}/{user_id}/threads_publish",
            params={"creation_id": creation_id, "access_token": token},
            timeout=15,
        )
        if r.status_code != 200:
            return {"success": False, "error": r.text}

        return {"success": True, "post_id": r.json()["id"]}
    except Exception as e:
        return {"success": False, "error": str(e)}


def post_reply(token: str, post_id: str, text: str) -> dict:
    """
    透過 Threads API 回覆指定貼文。
    post_id：Threads API 的 media object ID（非 URL shortcode）。

    回傳：
      成功 → {"success": True, "reply_id": str}
      失敗 → {"success": False, "error": str}
    """
    try:
        # Step 1：取得 user_id
        info = get_user_info(token)
        if not info["success"]:
            return {"success": False, "error": f"Token 驗證失敗：{info['error']}"}
        user_id = info["data"]["id"]

        # Step 2：建立 reply container
        r = requests.post(
            f"{API_BASE}/{user_id}/threads",
            params={
                "media_type": "TEXT",
                "text": text,
                "reply_to_id": post_id,
                "access_token": token,
            },
            timeout=15,
        )
        if r.status_code != 200:
            return {"success": False, "error": f"建立回覆失敗：{r.text}"}

        creation_id = r.json()["id"]
        time.sleep(2)

        # Step 3：發布 reply
        r = requests.post(
            f"{API_BASE}/{user_id}/threads_publish",
            params={"creation_id": creation_id, "access_token": token},
            timeout=15,
        )
        if r.status_code != 200:
            return {"success": False, "error": f"發布回覆失敗：{r.text}"}

        return {"success": True, "reply_id": r.json()["id"]}

    except Exception as e:
        return {"success": False, "error": str(e)}
