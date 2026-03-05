/**
 * OpenAI Responses API ラッパー
 * Structured Outputs (json_schema) で TransactionAI を返す
 * Phase6: retry/timeout/usage強化
 */

function callOpenAI_TextToTransaction_(text, clientContext, traceId) {
  const model = getModelText_(); // config.gsから取得
  const schema = getTransactionAiSchema_();

  const payload = {
    model: model,
    input: [
      {
        role: "system",
        content: [{ type: "text", text: buildSystemPrompt_() }]
      },
      {
        role: "user",
        content: [{ type: "text", text: text }]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "kakeibo_transaction",
        schema: schema,
        strict: true
      }
    }
  };

  return fetchTransactionFromOpenAI_(payload, traceId, "processText", text.length);
}

function callOpenAI_ImageToTransaction_(mimeType, base64, clientContext, traceId) {
  const model = getModelImage_(); // config.gsから取得
  const schema = getTransactionAiSchema_();

  const payload = {
    model: model,
    input: [
      {
        role: "system",
        content: [{ type: "text", text: buildSystemPrompt_() }]
      },
      {
        role: "user",
        content: [
          { type: "text", text: "このレシート画像から、1件の取引（基本は合計金額で1件）を抽出してJSONで返してください。" },
          { type: "input_image", image_url: `data:${mimeType};base64,${base64}` }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "kakeibo_transaction",
        schema: schema,
        strict: true
      }
    }
  };

  // 画像サイズ（base64デコード後のバイト数概算）
  const imageSize = Math.round(base64.length * 0.75);

  return fetchTransactionFromOpenAI_(payload, traceId, "processReceipt", imageSize);
}

/**
 * OpenAI APIを呼び出し（リトライ付き）
 */
function fetchTransactionFromOpenAI_(payload, traceId, operation, inputSize) {
  const apiKey = getRequiredProp_("OPENAI_API_KEY");
  const url = "https://api.openai.com/v1/responses";
  const timeout = getOpenAITimeout_();
  const maxRetries = getOpenAIMaxRetries_();
  const model = payload.model;

  let lastError = null;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const callStarted = Date.now();

    let res;
    try {
      res = UrlFetchApp.fetch(url, {
        method: "post",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        timeout: timeout
      });
    } catch (e) {
      const callDuration = Date.now() - callStarted;
      logOpenAICall_(traceId, operation, model, 0, 0, callDuration, false, String(e));

      lastError = makeAppError_("E_OPENAI_TIMEOUT", `UrlFetch failed: ${e}`, traceId, true, "通信が混雑しています。もう一度お試しください。");

      if (attempt < maxRetries) {
        Utilities.sleep(getBackoffDelay_(attempt));
        continue;
      }
      throw lastError;
    }

    const callDuration = Date.now() - callStarted;
    const status = res.getResponseCode();
    const bodyText = res.getContentText();

    // レート制限/サーバーエラーはリトライ
    if (status === 429 || status >= 500) {
      logOpenAICall_(traceId, operation, model, 0, 0, callDuration, false, `HTTP ${status}: ${truncate_(bodyText, 200)}`);

      const code = status === 429 ? "E_OPENAI_RATE_LIMIT" : "E_OPENAI_SERVER_ERROR";
      lastError = makeAppError_(
        code,
        `OpenAI HTTP ${status}: ${truncate_(bodyText, 500)}`,
        traceId,
        true,
        status === 429 ? "混雑しています。少し待って再送してください。" : "AI解析に失敗しました。もう一度お試しください。"
      );

      if (attempt < maxRetries) {
        Utilities.sleep(getBackoffDelay_(attempt));
        continue;
      }
      throw lastError;
    }

    // 認証/権限エラーはリトライしない
    if (status === 401 || status === 403) {
      logOpenAICall_(traceId, operation, model, 0, 0, callDuration, false, `HTTP ${status}: Auth error`);
      throw makeAppError_(
        "E_OPENAI_QUOTA",
        `OpenAI HTTP ${status}: ${truncate_(bodyText, 500)}`,
        traceId,
        false,
        "AI解析に失敗しました。管理者に連絡してください。"
      );
    }

    // その他の4xxエラー
    if (status >= 400) {
      logOpenAICall_(traceId, operation, model, 0, 0, callDuration, false, `HTTP ${status}: ${truncate_(bodyText, 200)}`);
      throw makeAppError_(
        "E_OPENAI_BAD_RESPONSE",
        `OpenAI HTTP ${status}: ${truncate_(bodyText, 500)}`,
        traceId,
        false,
        "AI解析に失敗しました。もう一度お試しください。"
      );
    }

    // 成功時のパース
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      logOpenAICall_(traceId, operation, model, 0, 0, callDuration, false, `Invalid JSON: ${truncate_(bodyText, 100)}`);

      lastError = makeAppError_("E_OPENAI_BAD_RESPONSE", `Invalid JSON response: ${truncate_(bodyText, 200)}`, traceId, true, "AI応答の解析に失敗しました。再度お試しください。");

      if (attempt < maxRetries) {
        Utilities.sleep(getBackoffDelay_(attempt));
        continue;
      }
      throw lastError;
    }

    // usage情報を抽出
    const usage = extractUsage_(body);

    const jsonText = extractStructuredJsonText_(body);
    if (!jsonText) {
      logOpenAICall_(traceId, operation, model, usage.input, usage.output, callDuration, false, "No structured output");

      lastError = makeAppError_("E_PARSE_FAILED", `No structured output text found`, traceId, true, "AI応答の解析に失敗しました。もう一度お試しください。");

      if (attempt < maxRetries) {
        Utilities.sleep(getBackoffDelay_(attempt));
        continue;
      }
      throw lastError;
    }

    let ai;
    try {
      ai = JSON.parse(jsonText);
    } catch (e) {
      logOpenAICall_(traceId, operation, model, usage.input, usage.output, callDuration, false, `Parse structured JSON failed: ${truncate_(jsonText, 100)}`);

      lastError = makeAppError_("E_PARSE_FAILED", `Failed to parse structured JSON: ${truncate_(jsonText, 200)}`, traceId, true, "AI応答の解析に失敗しました。もう一度お試しください。");

      if (attempt < maxRetries) {
        Utilities.sleep(getBackoffDelay_(attempt));
        continue;
      }
      throw lastError;
    }

    if (!ai || ai.type !== "transaction") {
      if (ai && ai.type === "unknown") {
        // 成功ログ
        logOpenAICall_(traceId, operation, model, usage.input, usage.output, callDuration, true, "");
        return ai;
      }

      logOpenAICall_(traceId, operation, model, usage.input, usage.output, callDuration, false, `Unexpected type: ${ai?.type}`);
      throw makeAppError_("E_PARSE_FAILED", `Unexpected AI object: ${truncate_(jsonText, 200)}`, traceId, true, "AI応答の形式が不正です。もう一度お試しください。");
    }

    // 成功ログ
    logOpenAICall_(traceId, operation, model, usage.input, usage.output, callDuration, true, "");

    // usage情報をAIオブジェクトに付与（ログ用）
    ai.__openai_usage = usage;
    ai.__openai_model = model;

    return ai;
  }

  throw lastError || new Error("Unexpected: no result after retries");
}

/**
 * usage情報を抽出
 */
function extractUsage_(body) {
  if (body && body.usage) {
    return {
      input: body.usage.input_tokens || body.usage.prompt_tokens || 0,
      output: body.usage.output_tokens || body.usage.completion_tokens || 0
    };
  }
  return { input: 0, output: 0 };
}

/**
 * 指数バックオフ遅延（ms）
 */
function getBackoffDelay_(attempt) {
  // 300ms, 1000ms, 3000ms...
  const base = 300;
  return Math.min(base * Math.pow(3, attempt - 1), 10000);
}

/**
 * Responses APIのレスポンスからJSONテキストを抽出
 */
function extractStructuredJsonText_(body) {
  // output_text (SDK helper形式)
  if (body && typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  // body.output[*].content[*].text (標準形式)
  if (body && Array.isArray(body.output)) {
    for (const out of body.output) {
      if (out && Array.isArray(out.content)) {
        for (const c of out.content) {
          if (c && c.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
            return c.text.trim();
          }
          if (c && typeof c.text === "string" && c.text.trim()) {
            return c.text.trim();
          }
        }
      }
    }
  }

  return "";
}

function buildSystemPrompt_() {
  return [
    "あなたは家計簿入力の受付です。",
    "ユーザー入力（テキスト/レシート画像）から「1件の取引」を抽出し、指定JSON Schemaに厳密に従って返してください。",
    "",
    "- 日付は YYYY-MM-DD。不明なら空文字にする。",
    "- 取引種別は txn_type=expense/income/transfer/settlement。",
    "- amountは数値（常に正の数）。支出か収入かは txn_type で区別する。",
    "- カテゴリは一般的な家計簿の大分類から選ぶ（例：食費/日用品/住居/光熱費/通信/交通/医療/教育/娯楽/美容・衣服/交際/子ども/貯蓄・投資/特別費/収入/その他）。",
    "- 不明点がある場合は needs_clarification=true にし、clarification_questions に短い質問を入れる。",
    "- 迷った場合は confidence を低めに設定する。",
    "",
    "【クレジットカード精算の判定】",
    "以下のキーワードがあり、かつ店名・商品名がない場合は txn_type=settlement（カード精算）として扱う：",
    "- 「請求」「お支払い」「引き落とし」「まとめて請求」「精算」",
    "例：「楽天カードの請求が来てお支払いです、3万円」→ settlement",
    "例：「JCBカードの引き落とし、25000円」→ settlement",
    "",
    "通常のカード利用（店名・商品名あり）は expense として扱う：",
    "例：「ガソリンをJCBカードで2000円」→ expense（settlement_statusはunsettled）",
    "",
    "settlement の場合は card_name にカード名を正規化して入れる（楽天カード、JCBカード等）。",
    "",
    "注意：Spreadsheet列名typeと衝突しないよう、JSONは txn_type を用いる。"
  ].join("\n");
}

function getTransactionAiSchema_() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["transaction", "unknown"] },
      date: { type: "string", description: "YYYY-MM-DD or empty" },
      txn_type: { type: "string", enum: ["expense", "income", "transfer", "settlement"] },
      account: { type: "string" },
      merchant: { type: "string" },
      item: { type: "string" },
      category: { type: "string" },
      subcategory: { type: "string" },
      payment_method: { type: "string" },
      amount: { type: "number" },
      memo: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      needs_clarification: { type: "boolean" },
      clarification_questions: { type: "array", items: { type: "string" } },
      card_name: { type: "string", description: "正規化されたカード名（精算時に使用）" }
    },
    required: [
      "type", "date", "txn_type", "account", "merchant", "item", "category", "subcategory",
      "payment_method", "amount", "memo", "tags", "confidence", "needs_clarification", "clarification_questions", "card_name"
    ]
  };
}

/** ========== Smart Input用 Chat Completions API ========== */

/**
 * OpenAI Chat Completions APIを呼び出し、JSONを返す（processSmartInput用）
 * @param {Array} messages [{role,content},...]
 * @param {Object} schemaHint 期待するJSONの形式（プロンプト補強用）
 * @param {string} traceId
 * @return {Object} パースされたJSON
 */
function callOpenAiJson_(messages, schemaHint, traceId) {
  const apiKey = getOpenAiApiKey_();
  if (!apiKey) {
    throw makeAppError_("E_AI_KEY_MISSING", "OPENAI_API_KEY missing", traceId, false,
      "AIキーが未設定です。設定を確認してください。");
  }

  const model = getOpenAiModel_();
  const url = "https://api.openai.com/v1/chat/completions";

  const payload = {
    model,
    messages,
    temperature: 0.2
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: { Authorization: "Bearer " + apiKey },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code >= 400) {
    throw makeAppError_("E_AI_CALL_FAILED", `OpenAI error ${code}: ${text}`, traceId, true,
      "AI呼び出しに失敗しました。しばらくしてから再度お試しください。");
  }

  const json = JSON.parse(text);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) {
    throw makeAppError_("E_AI_EMPTY", "Empty AI response", traceId, true, "AIの応答が空でした。");
  }

  // AIに「JSONだけ返せ」を要求しているので、最初のJSONブロックを抽出
  const parsed = safeParseJsonFromText_(content);
  if (!parsed) {
    throw makeAppError_("E_AI_PARSE_FAILED", "Failed to parse JSON from AI response: " + content, traceId, true,
      "AIの結果解析に失敗しました。");
  }
  return parsed;
}

/**
 * テキストからJSONを安全にパース（マークダウンコードブロック対応）
 */
function safeParseJsonFromText_(txt) {
  try {
    return JSON.parse(txt);
  } catch (e) {
    // ```json ... ``` を剥がす
    const m = txt.match(/```json([\s\S]*?)```/i) || txt.match(/```([\s\S]*?)```/);
    if (m) {
      try { return JSON.parse(m[1].trim()); } catch (_) {}
    }
    // 最初の { から最後の } を拾う
    const i = txt.indexOf("{");
    const j = txt.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try { return JSON.parse(txt.slice(i, j + 1)); } catch (_) {}
    }
    return null;
  }
}

/** ---------- props/util ---------- */

function getRequiredProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Missing script property: ${key}`);
  return v;
}

function getProp_(key, defaultValue) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? v : defaultValue;
}

function truncate_(s, n) {
  s = String(s || "");
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

/** ========== Gemini API Support ========== */

/**
 * Gemini APIを呼び出し、JSONを返す
 * @param {Array} messages OpenAI形式のメッセージ [{role,content},...]
 * @param {Object} schemaHint 期待するJSONの形式
 * @param {string} traceId
 * @return {Object} パースされたJSON
 */
function callGeminiJson_(messages, schemaHint, traceId) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) {
    throw makeAppError_("E_AI_KEY_MISSING", "GEMINI_API_KEY missing", traceId, false,
      "Gemini APIキーが未設定です。設定を確認してください。");
  }

  const model = getGeminiModel_();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // OpenAI形式のメッセージをGemini形式に変換
  const contents = convertToGeminiFormat_(messages);

  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code >= 400) {
    throw makeAppError_("E_AI_CALL_FAILED", `Gemini error ${code}: ${text}`, traceId, true,
      "Gemini呼び出しに失敗しました。しばらくしてから再度お試しください。");
  }

  const json = JSON.parse(text);

  // Geminiのレスポンス形式からテキストを抽出
  const content = json.candidates &&
                  json.candidates[0] &&
                  json.candidates[0].content &&
                  json.candidates[0].content.parts &&
                  json.candidates[0].content.parts[0] &&
                  json.candidates[0].content.parts[0].text;

  if (!content) {
    throw makeAppError_("E_AI_EMPTY", "Empty Gemini response", traceId, true, "Geminiの応答が空でした。");
  }

  const parsed = safeParseJsonFromText_(content);
  if (!parsed) {
    throw makeAppError_("E_AI_PARSE_FAILED", "Failed to parse JSON from Gemini response: " + content, traceId, true,
      "Geminiの結果解析に失敗しました。");
  }
  return parsed;
}

/**
 * OpenAI形式のメッセージをGemini形式に変換
 */
function convertToGeminiFormat_(messages) {
  const contents = [];
  let systemInstruction = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      // Geminiではsystem instructionは別扱い、またはuserの最初に含める
      systemInstruction = msg.content;
    } else if (msg.role === "user") {
      // systemがあれば、最初のuserメッセージに含める
      let text = msg.content;
      if (systemInstruction && contents.length === 0) {
        text = systemInstruction + "\n\n" + text;
        systemInstruction = "";
      }
      contents.push({
        role: "user",
        parts: [{ text: text }]
      });
    } else if (msg.role === "assistant") {
      contents.push({
        role: "model",
        parts: [{ text: msg.content }]
      });
    }
  }

  return contents;
}

/**
 * 統合AI呼び出し関数（プロバイダーに応じて切り替え）
 * @param {Array} messages [{role,content},...]
 * @param {Object} schemaHint 期待するJSONの形式
 * @param {string} traceId
 * @return {Object} パースされたJSON
 */
function callAiJson_(messages, schemaHint, traceId) {
  const provider = getAiProvider_();

  if (provider === "gemini") {
    return callGeminiJson_(messages, schemaHint, traceId);
  } else {
    // デフォルトはOpenAI
    return callOpenAiJson_(messages, schemaHint, traceId);
  }
}

/**
 * AIプロバイダーを取得
 * @return {string} "openai" or "gemini"
 */
function getAiProvider_() {
  const cfg = getConfigKV_();
  const provider = String(cfg.AI_PROVIDER || "").toLowerCase().trim();
  if (provider === "gemini") return "gemini";

  // Script Propertiesもチェック
  const propProvider = PropertiesService.getScriptProperties().getProperty("AI_PROVIDER");
  if (propProvider && propProvider.toLowerCase().trim() === "gemini") return "gemini";

  return "openai"; // デフォルト
}

/**
 * Gemini APIキーを取得
 */
function getGeminiApiKey_() {
  // Script Properties優先
  const props = PropertiesService.getScriptProperties();
  const pv = props.getProperty("GEMINI_API_KEY");
  if (pv) return pv.trim();

  // 01_SettingsKV シート
  const cfg = getConfigKV_();
  if (cfg.GEMINI_API_KEY) return String(cfg.GEMINI_API_KEY).trim();

  return "";
}

/**
 * Geminiモデル名を取得
 */
function getGeminiModel_() {
  const cfg = getConfigKV_();
  const model = cfg.GEMINI_MODEL ||
                PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") ||
                "gemini-1.5-flash";
  return model;
}

/**
 * いずれかのAI APIキーが設定されているかチェック
 * プロバイダー設定に応じて適切なキーをチェック
 */
function hasAnyAiApiKey_() {
  const provider = getAiProvider_();
  if (provider === "gemini") {
    return !!getGeminiApiKey_();
  } else {
    return !!getOpenAiApiKey_();
  }
}

/**
 * 現在のAI設定情報を返す（デバッグ用）
 */
function getAiProviderInfo_() {
  const provider = getAiProvider_();
  if (provider === "gemini") {
    return {
      provider: "gemini",
      model: getGeminiModel_(),
      hasKey: !!getGeminiApiKey_()
    };
  } else {
    return {
      provider: "openai",
      model: getOpenAiModel_(),
      hasKey: !!getOpenAiApiKey_()
    };
  }
}
