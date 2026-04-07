import cron from "node-cron";
import pg from "pg";
import { generateCalMessage } from "./generateCalMessage.js";

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendNotification(user) {
  const message = await generateCalMessage(user);

  await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: user.push_token,
      title: "Cal",
      body: message,
      data: { screen: "Chat" },
    }),
  });

  await db.query(
    "UPDATE users SET last_notification_at = NOW() WHERE id = $1",
    [user.id]
  );

  return message;
}

async function runScheduler() {
  const { rows: users } = await db.query(
    "SELECT * FROM users WHERE notifications_enabled = true AND push_token IS NOT NULL"
  );

  const now = Date.now();

  for (const user of users) {
    try {
      const lastNotif = user.last_notification_at
        ? new Date(user.last_notification_at).getTime()
        : null;

      if (user.id === 3) {
        // Joey: 18% random chance, max once per 6 hours
        const sixHoursMs = 6 * 60 * 60 * 1000;
        const enoughTimePassed = !lastNotif || now - lastNotif > sixHoursMs;
        if (enoughTimePassed && Math.random() < 0.18) {
          await sendNotification(user);
        }
      } else {
        // All other users: inactive 39+ hours, last notified 24+ hours ago
        const lastActive = user.last_active_at
          ? new Date(user.last_active_at).getTime()
          : null;
        const thirtyNineHoursMs = 39 * 60 * 60 * 1000;
        const twentyFourHoursMs = 24 * 60 * 60 * 1000;
        const isInactive = !lastActive || now - lastActive > thirtyNineHoursMs;
        const enoughTimePassed =
          !lastNotif || now - lastNotif > twentyFourHoursMs;
        if (isInactive && enoughTimePassed) {
          await sendNotification(user);
        }
      }
    } catch (e) {
      console.warn(`[NOTIF] Failed for user ${user.id}:`, e.message);
    }
  }
}

export function start() {
  cron.schedule("0 * * * *", () => {
    console.log("[NOTIF] Running hourly notification scheduler");
    runScheduler().catch((e) =>
      console.error("[NOTIF] Scheduler error:", e)
    );
  });
  console.log("[NOTIF] Notification scheduler started");
}
