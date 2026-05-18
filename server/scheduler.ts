import * as db from "./db";

async function runMonthlyTrafficReset() {
  try {
    const today = new Date().getDate();
    const usersToReset = await db.getUsersForAutoReset(today);
    for (const user of usersToReset) {
      await db.resetUserTraffic(user.id);
      console.log(`[Scheduler] Auto-reset traffic for user ${user.id} (${user.username})`);
    }
    if (usersToReset.length > 0) {
      console.log(`[Scheduler] Monthly traffic reset: ${usersToReset.length} user(s) reset`);
    }

    const recharged = await db.rechargeSubscriptionTrafficCycles();
    if (recharged > 0) {
      console.log(`[Scheduler] Subscription traffic recharge: ${recharged} user(s) reset`);
    }
  } catch (error) {
    console.error("[Scheduler] Monthly traffic reset error:", error);
  }
}

async function runExpirationCheck() {
  try {
    const expiredUsers = await db.getExpiredUsers();
    for (const user of expiredUsers) {
      await db.disableAllUserRules(user.id);
      console.log(`[Scheduler] User ${user.id} (${user.username}) expired, disabled all rules`);
    }
    if (expiredUsers.length > 0) {
      console.log(`[Scheduler] Expiration check: ${expiredUsers.length} user(s) expired`);
    }
  } catch (error) {
    console.error("[Scheduler] Expiration check error:", error);
  }
}

async function runSelfTestTimeoutSweep() {
  try {
    const n = await db.timeoutStaleForwardTests(60);
    if (n > 0) {
      console.log(`[Scheduler] Self-test timeout sweep: ${n} test(s) marked as timeout`);
    }
  } catch (error) {
    console.error("[Scheduler] Self-test timeout sweep error:", error);
  }
}

async function runTcpingCleanup() {
  try {
    await db.cleanOldTcpingStats(48);
  } catch (error) {
    console.error("[Scheduler] TCPing cleanup error:", error);
  }
}

export function startScheduler() {
  setInterval(async () => {
    const now = new Date();
    if (now.getMinutes() < 10) await runMonthlyTrafficReset();
  }, 60 * 60 * 1000);

  setInterval(async () => {
    await runExpirationCheck();
  }, 60 * 60 * 1000);

  setInterval(async () => {
    await runSelfTestTimeoutSweep();
  }, 30 * 1000);

  setInterval(async () => {
    await runTcpingCleanup();
  }, 60 * 60 * 1000);

  setTimeout(async () => {
    await runMonthlyTrafficReset();
    await runExpirationCheck();
    await runSelfTestTimeoutSweep();
    await runTcpingCleanup();
  }, 5000);

  console.log("[Scheduler] Scheduled tasks started (monthly reset + expiration check + selftest timeout sweep + tcping cleanup)");
}
