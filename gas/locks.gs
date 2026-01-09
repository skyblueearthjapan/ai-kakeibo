/**
 * locks.gs
 * Processing lock helpers（DocumentLock版）
 * - saveTransactionDraft等で確実にロック解放するため
 */

/**
 * DocumentLockを取得
 * @param {string} traceId トレースID（ログ用）
 * @return {GoogleAppsScript.Lock.Lock} ロックオブジェクト
 */
function acquireProcessingLock_(traceId) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  return lock;
}

/**
 * DocumentLockを解放（エラーでも止めない）
 * @param {GoogleAppsScript.Lock.Lock} lock ロックオブジェクト
 * @param {string} traceId トレースID（ログ用）
 */
function releaseProcessingLockSafe_(lock, traceId) {
  try {
    if (lock) lock.releaseLock();
  } catch (e) {
    console.log(`[LOCK] release failed trace=${traceId}: ${e}`);
  }
}
