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
    "- 取引種別は txn_type=expense/income/transfer。",
    "- amountは数値（常に正の数）。支出か収入かは txn_type で区別する。",
    "- カテゴリは一般的な家計簿の大分類から選ぶ（例：食費/日用品/住居/光熱費/通信/交通/医療/教育/娯楽/美容・衣服/交際/子ども/貯蓄・投資/特別費/収入/その他）。",
    "- 不明点がある場合は needs_clarification=true にし、clarification_questions に短い質問を入れる。",
    "- 迷った場合は confidence を低めに設定する。",
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
      txn_type: { type: "string", enum: ["expense", "income", "transfer"] },
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
      clarification_questions: { type: "array", items: { type: "string" } }
    },
    required: [
      "type", "date", "txn_type", "account", "merchant", "item", "category", "subcategory",
      "payment_method", "amount", "memo", "tags", "confidence", "needs_clarification", "clarification_questions"
    ]
  };
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
