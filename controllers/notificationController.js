let db;

function setDatabase(database) {
  db = database;
}

function query(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });
}

function getUserId(req) {
  return req.user?.user_id || req.user?.id;
}

async function registerToken(req, res) {
  try {
    const userId = getUserId(req);
    const { fcm_token, device_type } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!fcm_token || typeof fcm_token !== "string") {
      return res.status(400).json({
        success: false,
        message: "FCM token is required",
      });
    }

    await query(
      `INSERT INTO user_devices
                (user_id, fcm_token, device_type)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                device_type = VALUES(device_type),
                updated_at = CURRENT_TIMESTAMP`,
      [userId, fcm_token, device_type || "android"],
    );

    return res.json({
      success: true,
      message: "Notification token registered",
    });
  } catch (error) {
    console.error("Register FCM token error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to register notification token",
    });
  }
}

async function removeToken(req, res) {
  try {
    const userId = getUserId(req);
    const { fcm_token } = req.body;

    if (!userId || !fcm_token) {
      return res.status(400).json({
        success: false,
        message: "User and FCM token are required",
      });
    }

    await query(
      "DELETE FROM user_devices WHERE user_id = ? AND fcm_token = ?",
      [userId, fcm_token],
    );

    return res.json({
      success: true,
      message: "Notification token removed",
    });
  } catch (error) {
    console.error("Remove FCM token error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to remove notification token",
    });
  }
}

module.exports = {
  setDatabase,
  registerToken,
  removeToken,
};
