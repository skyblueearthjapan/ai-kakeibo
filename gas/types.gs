/**
 * JSDoc型定義（api-contract.md / data-dictionary.md準拠）
 */

/**
 * @typedef {Object} TransactionAI
 * @property {"transaction"|"unknown"} type
 * @property {string} date
 * @property {"expense"|"income"|"transfer"} txn_type
 * @property {string} account
 * @property {string} merchant
 * @property {string} item
 * @property {string} category
 * @property {string} subcategory
 * @property {string} payment_method
 * @property {number} amount
 * @property {string} memo
 * @property {string[]} tags
 * @property {number} confidence
 * @property {boolean} needs_clarification
 * @property {string[]} clarification_questions
 */

/**
 * @typedef {Object} TransactionRow
 * @property {string} id
 * @property {string} date
 * @property {string} type
 * @property {string} account
 * @property {string} merchant
 * @property {string} item
 * @property {string} category
 * @property {string} subcategory
 * @property {string} payment_method
 * @property {number} amount
 * @property {string} memo
 * @property {string} tags
 * @property {string} source
 * @property {number} confidence
 * @property {string} receipt_file_id
 * @property {string} raw_text
 * @property {"confirmed"|"pending"|"needs_review"} status
 */

/**
 * @typedef {Object} TransactionResult
 * @property {boolean} ok
 * @property {Object} [result]
 * @property {TransactionRow} [result.transaction]
 * @property {string} [result.appended_id]
 * @property {Object} [result.clarification]
 * @property {Object} [error]
 * @property {string} [error.code]
 * @property {string} [error.message]
 * @property {string} [error.trace_id]
 * @property {boolean} [error.retryable]
 * @property {string} [error.user_message]
 */

/**
 * @typedef {Object} ClientContext
 * @property {string} client_time
 * @property {string} timezone
 * @property {string} device
 * @property {string} ui_version
 */
