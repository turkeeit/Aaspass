const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let db = null;
let firebaseInitialized = false;

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

function setDatabase(database) {
  db = database;
}

// --------------------------------------------------
// FIREBASE INITIALIZATION
// --------------------------------------------------

function initializeFirebase() {
  if (firebaseInitialized || admin.apps.length > 0) {
    firebaseInitialized = true;
    return;
  }

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!credentialsPath) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not configured in .env");
  }

  const resolvedPath = path.resolve(credentialsPath);

  console.log("FCM: Firebase credentials ENV:", credentialsPath);
  console.log("FCM: Resolved credentials path:", resolvedPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error("Firebase service account file not found: " + resolvedPath);
  }

  const stats = fs.statSync(resolvedPath);

  console.log("FCM: Credentials path exists:", true);
  console.log("FCM: Is file:", stats.isFile());
  console.log("FCM: Is directory:", stats.isDirectory());

  if (!stats.isFile()) {
    throw new Error(
      "Firebase credentials path points to a directory, not a JSON file: " +
        resolvedPath,
    );
  }

  let serviceAccount;

  try {
    const fileContent = fs.readFileSync(resolvedPath, "utf8");
    serviceAccount = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      "Unable to read or parse Firebase service account JSON: " + error.message,
    );
  }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.private_key ||
    !serviceAccount.client_email
  ) {
    throw new Error(
      "Firebase service account JSON is missing required credentials",
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  firebaseInitialized = true;

  console.log(
    "FCM: Firebase Admin initialized successfully. Project:",
    serviceAccount.project_id,
  );
}

// --------------------------------------------------
// DATABASE QUERY HELPER
// --------------------------------------------------

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error("Notification database not initialized"));
    }

    db.query(sql, params, (error, results) => {
      if (error) return reject(error);

      resolve(results);
    });
  });
}

// --------------------------------------------------
// SEND NOTIFICATION TO CHAT MEMBERS
// --------------------------------------------------

async function notifyChatMembers({
  chatId,
  senderId,
  senderName,
  messageType,
  messageText,
  popId,
}) {
  try {
    console.log("FCM: Preparing chat notification");
    console.log("FCM: Chat ID:", chatId);
    console.log("FCM: Sender ID:", senderId);

    // Initialize Firebase Admin.
    initializeFirebase();

    // Get all registered devices belonging to other chat members.
    // The sender is excluded.
    const recipients = await query(
      `SELECT DISTINCT fcm_token
       FROM user_devices
       WHERE user_id IN (
         SELECT user_id
         FROM chat_members
         WHERE chat_id = ?
           AND user_id != ?
       )
       AND fcm_token IS NOT NULL
       AND fcm_token != ''`,
      [chatId, senderId],
    );

    const tokens = recipients.map((row) => row.fcm_token).filter(Boolean);

    console.log("FCM: Recipient token count:", tokens.length);

    if (tokens.length === 0) {
      console.log("FCM: No registered recipients for chat", chatId);
      return;
    }

    // Prepare notification content.
    const isImage = messageType === "image";

    const body = isImage
      ? messageText || "📷 Sent a photo"
      : messageText || "You have a new message";

    const title = senderName || "New message";

    // Send notification to all recipient devices.
    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,

      notification: {
        title: title,
        body: body,
      },

      // Use non-reserved custom data keys.
      // All FCM data values must be strings.
      data: {
        notification_type: "chat_message",
        chat_id: String(chatId),
        pop_id: String(popId || ""),
        sender_id: String(senderId),
        chat_message_type: String(messageType || "text"),
        notification_title: String(title),
        notification_body: String(body),
      },

      android: {
        priority: "high",
        notification: {
          channelId: "popchaat_messages",
          sound: "default",
        },
      },
    });

    // Log delivery results.
    console.log(
      `FCM: ${response.successCount} sent, ${response.failureCount} failed`,
    );

    // Identify invalid device tokens.
    const invalidTokens = [];

    response.responses.forEach((result, index) => {
      if (result.success) {
        console.log("FCM: Notification accepted for recipient index:", index);

        return;
      }

      console.error(
        "FCM: Delivery failed for recipient index:",
        index,
        result.error?.code,
        result.error?.message,
      );

      if (
        result.error?.code === "messaging/registration-token-not-registered" ||
        result.error?.code === "messaging/invalid-registration-token"
      ) {
        invalidTokens.push(tokens[index]);
      }
    });

    // Remove invalid tokens from database.
    for (const token of invalidTokens) {
      await query("DELETE FROM user_devices WHERE fcm_token = ?", [token]);

      console.log("FCM: Removed invalid device token");
    }
  } catch (error) {
    console.error("FCM notification error:", error);
  }
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  setDatabase,
  notifyChatMembers,
};
