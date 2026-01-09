/**
 * OpenAI Responses API ラッパー
 * Structured Outputs (json_schema) で TransactionAI を返す
 */

function callOpenAI_TextToTransaction_(text, clientContext, traceId) {
  const model = getProp_("OPENAI_MODEL_TEXT", "gpt-4o-mini");
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

  return fetchTransactionFromOpenAI_(payload, traceId);
}

function callOpenAI_ImageToTransaction_(mimeType, base64, clientContext, traceId) {
  const model = getProp_("OPENAI_MODEL_IMAGE", "gpt-4o-mini");
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

  return fetchTransactionFromOpenAI_(payload, traceId);
}

function fetchTransactionFromOpenAI_(payload, traceId) {
  const apiKey = getRequiredProp_("OPENAI_API_KEY");
  const url = "https://api.openai.com/v1/responses";

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: "post",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    throw makeAppError_("E_OPENAI_TIMEOUT", `UrlFetch failed: ${e}`, traceId, true, "通信が混雑しています。もう一度お試しください。");
  }

  const status = res.getResponseCode();
  const bodyText = res.getContentText();

  if (status >= 400) {
    const retryable = (status === 429 || status >= 500);
    const code = status === 429 ? "E_OPENAI_RATE_LIMIT"
      : status === 401 || status === 403 ? "E_OPENAI_QUOTA"
      : "E_OPENAI_BAD_RESPONSE";

    throw makeAppError_(
      code,
      `OpenAI HTTP ${status}: ${truncate_(bodyText, 500)}`,
      traceId,
      retryable,
      status === 429 ? "混雑しています。少し待って再送してください。" : "AI解析に失敗しました。もう一度お試しください。"
    );
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    throw makeAppError_("E_OPENAI_BAD_RESPONSE", `Invalid JSON response: ${truncate_(bodyText, 200)}`, traceId, true, "AI応答の解析に失敗しました。再度お試しください。");
  }

  const jsonText = extractStructuredJsonText_(body);
  if (!jsonText) {
    throw makeAppError_("E_PARSE_FAILED", `No structured output text found`, traceId, true, "AI応答の解析に失敗しました。もう一度お試しください。");
  }

  let ai;
  try {
    ai = JSON.parse(jsonText);
  } catch (e) {
    throw makeAppError_("E_PARSE_FAILED", `Failed to parse structured JSON: ${truncate_(jsonText, 200)}`, traceId, true, "AI応答の解析に失敗しました。もう一度お試しください。");
  }

  if (!ai || ai.type !== "transaction") {
    if (ai && ai.type === "unknown") return ai;
    throw makeAppError_("E_PARSE_FAILED", `Unexpected AI object: ${truncate_(jsonText, 200)}`, traceId, true, "AI応答の形式が不正です。もう一度お試しください。");
  }

  return ai;
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
