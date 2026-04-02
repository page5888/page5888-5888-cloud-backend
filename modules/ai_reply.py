"""
ai_reply.py — 用 Gemini API 生成符合人設的 Threads 回覆
免費方案：Google AI Studio 取得的 API Key
模型：gemini-2.0-flash（免費、速度快）
"""

import time
from google import genai


def generate_reply(
    api_key: str,
    account: dict,
    post_text: str,
    post_author: str,
    product_title: str,
    product_url: str,
    keywords: list[str],
) -> dict:
    """
    根據帳號人設和貼文內容，生成自然的 Threads 回覆。
    回傳：{"success": True, "reply": str} 或 {"success": False, "error": str}
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    client = genai.Client(api_key=api_key)
    prompt = _build_prompt(account, post_text, post_author, product_title, product_url, keywords)

    models_to_try = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-001"]

    for model_name in models_to_try:
        for attempt in range(2):
            try:
                print(f"[Gemini] 使用模型：{model_name}")
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                )
                reply = response.text.strip()
                # 確保商品連結一定在回覆裡（Gemini 有時會忽略指示）
                if product_url and product_url not in reply:
                    reply = reply + f"\n{product_url}"
                return {"success": True, "reply": reply}

            except Exception as e:
                err = str(e)
                print(f"[Gemini 錯誤 model={model_name} attempt={attempt}] {err}")

                if "API_KEY_INVALID" in err or "API key not valid" in err:
                    return {"success": False, "error": "Gemini API Key 無效，請重新確認"}

                if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower() or "429" in err:
                    if attempt == 0:
                        time.sleep(5)
                        continue
                    # 這個模型配額不夠，換下一個
                    print(f"[Gemini] {model_name} 配額不足，換下一個模型")
                    break

                return {"success": False, "error": f"生成失敗：{err[:400]}"}

    return {
        "success": False,
        "error": "所有模型配額均已用盡。\n請前往 aistudio.google.com 確認 API Key 狀態，或等幾分鐘後再試。"
    }


def _call_gemini(api_key: str, prompt: str) -> dict:
    """共用的 Gemini 呼叫邏輯，回傳 {"success": True, "text": str} 或 error。"""
    client = genai.Client(api_key=api_key)
    for model_name in ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-001"]:
        for attempt in range(2):
            try:
                response = client.models.generate_content(model=model_name, contents=prompt)
                return {"success": True, "text": response.text.strip()}
            except Exception as e:
                err = str(e)
                if "API_KEY_INVALID" in err or "API key not valid" in err:
                    return {"success": False, "error": "Gemini API Key 無效，請重新確認"}
                if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower() or "429" in err:
                    if attempt == 0:
                        time.sleep(5)
                        continue
                    break
                return {"success": False, "error": f"生成失敗：{err[:400]}"}
    return {"success": False, "error": "所有模型配額均已用盡，請稍後再試。"}


def generate_promo_keywords(api_key: str, product_desc: str, target_audience: str) -> dict:
    """
    根據產品描述和目標客群，用 Gemini 生成 Threads 搜尋關鍵字。
    回傳：{"success": True, "keywords": list[str]} 或 error
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    prompt = f"""你是一個 Threads 社群行銷專家。

我要在 Threads 上找潛在客戶留言推廣，請根據以下資訊，給我 8 個最適合在 Threads 搜尋的關鍵字。

【產品描述】
{product_desc}

【目標客群】
{target_audience or "一般大眾"}

要求：
1. 關鍵字要是台灣人在 Threads 上會討論的自然用語
2. 涵蓋問題型（例：「哪裡買」「推薦」）和話題型（例：產品類別名稱）
3. 每個關鍵字 2-6 個字，不要太長
4. 只輸出關鍵字，每行一個，不要編號也不要說明"""

    result = _call_gemini(api_key, prompt)
    if not result["success"]:
        return result

    keywords = [k.strip().strip("・•-") for k in result["text"].splitlines() if k.strip()]
    keywords = [k for k in keywords if 1 < len(k) <= 20][:8]
    return {"success": True, "keywords": keywords}


def generate_promo_comment(
    api_key: str,
    post_text: str,
    post_author: str,
    product_desc: str,
    product_url: str,
) -> dict:
    """
    針對一篇貼文，生成自然的推廣留言（不硬塞廣告）。
    回傳：{"success": True, "comment": str} 或 error
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    url_instruction = f"\n5. 結尾自然帶上連結：{product_url}" if product_url else ""

    prompt = f"""你是一個在 Threads 上真實留言的用戶，不是廣告機器人。

以下是一篇 Threads 貼文，你要針對這篇文章寫一則留言，同時自然地提到你有一個相關的東西想推薦。

【貼文作者】@{post_author}
【貼文內容】
{post_text}

【你想推廣的產品/服務】
{product_desc}

留言規則：
1. 先對貼文內容做真誠回應（1-2句），讓人覺得你真的有看這篇文
2. 再用很自然的方式帶入你的推薦（1-2句），語氣像朋友推薦，不像廣告
3. 不用 hashtag
4. 總長度控制在 2-4 句
5. 直接輸出留言內容，不要加任何說明或前言{url_instruction}"""

    result = _call_gemini(api_key, prompt)
    if not result["success"]:
        return result

    comment = result["text"]
    if product_url and product_url not in comment:
        comment = comment + f"\n{product_url}"
    return {"success": True, "comment": comment}


def generate_editor_reply(
    api_key: str,
    account: dict,
    post_text: str,
    comment_author: str,
    comment_text: str,
    product_title: str = "",
    product_url: str = "",
) -> dict:
    """
    AI 小編模式：針對自己貼文收到的留言，生成品牌口吻的回覆。
    回傳：{"success": True, "reply": str} 或 {"success": False, "error": str}
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    persona      = account.get("persona", "")
    account_name = account.get("name", "")

    url_line = f"\n若提到商品，自然帶入連結：{product_url}" if product_url else ""
    product_line = f"\n【貼文商品】{product_title}" if product_title else ""

    prompt = f"""你是 {account_name}，一個 Threads 帳號的品牌小編。

你的人設：
{persona}

你剛發了一篇貼文，有人在下面留言了，你要用品牌口吻回覆這則留言。
{product_line}

【你的貼文內容（摘要）】
{post_text[:300]}

【留言者】@{comment_author}
【留言內容】
{comment_text}

回覆規則：
1. 語氣符合你的人設，自然真實不像機器人
2. 直接回應留言內容，讓對方感覺被重視
3. 可適時引導私訊或附商品連結，但不要硬塞
4. 長度 1-3 句，像真人在 Threads 上互動的感覺
5. 不用 hashtag，直接輸出回覆，不加說明{url_line}"""

    result = _call_gemini(api_key, prompt)
    if not result["success"]:
        return result
    return {"success": True, "reply": result["text"]}


def _build_prompt(
    account: dict,
    post_text: str,
    post_author: str,
    product_title: str,
    product_url: str,
    keywords: list[str],
) -> str:
    persona      = account.get("persona", "")
    account_name = account.get("name", "")

    # 商品連結區塊
    if product_title and product_url:
        product_block = f"""
【必須包含的商品資訊】
商品名稱：{product_title}
蝦皮連結：{product_url}

⚠️ 以上連結必須完整寫進回覆裡，不可省略或縮短。
自然帶入即可，不要讓人覺得是廣告。"""
    elif product_title:
        product_block = f"\n相關商品：{product_title}（自然帶入，不要硬塞）"
    else:
        product_block = ""

    return f"""你是 {account_name}。

人設：
{persona}

回覆規則：
1. 語氣自然真實，不能像廣告文
2. 先對貼文有真誠回應，再帶入商品
3. 不用 hashtag
4. 長度 2-4 句話，像真人留言
5. 直接輸出回覆，不要加說明或前言
{product_block}

以下是你要回覆的 Threads 貼文：
作者：@{post_author}
內容：{post_text}

請用你的人設語氣寫一則回覆："""


def generate_trending_post(api_key: str, account: dict, title: str, summary: str, source: str) -> dict:
    """
    把一則熱門話題/新聞，用帳號人設改寫成 Threads 貼文。
    回傳：{"success": True, "text": str} 或 {"success": False, "error": str}
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    persona  = account.get("persona", "")
    username = account.get("name", "")
    summary_block = f"\n【摘要】{summary}" if summary else ""

    prompt = f"""你是 {username}，你的個人風格如下：
{persona}

你看到了一則來自「{source}」的熱門話題，請用你自己的口吻把它改寫成一篇 Threads 貼文。

【話題標題】{title}{summary_block}

規則：
1. 用你的人設語氣，把這個話題「當成自己的觀點」說出來，不要像新聞播報或轉貼
2. 可以加入個人觀點、生活連結、或提問引發互動
3. 不加 hashtag
4. 長度 2-5 句，自然真實
5. 直接輸出貼文內容，不加說明前言

請直接輸出貼文："""

    result = _call_gemini(api_key, prompt)
    if not result["success"]:
        return result
    return {"success": True, "text": result["text"]}


def generate_schedule_post(api_key: str, account: dict, prompt: str) -> dict:
    """
    根據帳號人設和用戶給的 prompt，生成一篇 Threads 貼文。
    回傳：{"success": True, "text": str} 或 {"success": False, "error": str}
    """
    if not api_key or api_key.startswith("填入"):
        return {"success": False, "error": "請先在設定中填入 Gemini API Key"}

    from google import genai as _genai
    client = _genai.Client(api_key=api_key)

    persona  = account.get("persona", "")
    username = account.get("name", "")

    full_prompt = f"""你是 {username}，你的個人風格如下：
{persona}

現在你要在 Threads 上發一篇新貼文。用戶給你的發文主題或指示是：
{prompt}

規則：
1. 語氣完全符合你的人設，自然真實
2. 不加 hashtag
3. 不加「發文：」「以下是…」等說明前言，直接輸出貼文內容
4. 長度 2-5 句，像真人在 Threads 上發文的感覺

請直接輸出貼文內容："""

    models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-001"]
    for model in models:
        try:
            resp = client.models.generate_content(model=model, contents=full_prompt)
            text = resp.text.strip()
            if text:
                return {"success": True, "text": text}
        except Exception:
            continue

    return {"success": False, "error": "AI 生成失敗，請檢查 Gemini API Key"}
