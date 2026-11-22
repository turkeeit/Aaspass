const jwt = require("jsonwebtoken");

let db;
let io = null;

// --------------------------------------------------
// DATABASE HELPERS
// --------------------------------------------------

exports.setDatabase = (connection) => {
  db = connection;
};

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error("Database is not initialized."));
    }

    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });
};

const getUserId = (req) => {
  return req.user?.user_id || req.user?.id || null;
};

const chatRoom = (chatId) => `chat_${chatId}`;
const userRoom = (userId) => `user_${userId}`;

const sendAck = (callback, data) => {
  if (typeof callback === "function") {
    callback(data);
  }
};

// --------------------------------------------------
// MESSAGE RECEIPTS
// --------------------------------------------------

async function createMessageReceipts(messageId, chatId, senderId) {
  await query(
    `INSERT IGNORE INTO chat_message_receipts
       (message_id, user_id, created_at)
     SELECT ?, user_id, NOW()
     FROM chat_members
     WHERE chat_id = ?
       AND user_id <> ?`,
    [messageId, chatId, senderId],
  );
}

async function getMessageStatus(messageId) {
  const rows = await query(
    `SELECT
       m.id AS message_id,
       m.chat_id,
       m.user_id AS sender_id,
       COUNT(r.id) AS recipient_count,
       SUM(CASE WHEN r.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered_count,
       SUM(CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
     FROM chat_messages m
     LEFT JOIN chat_message_receipts r ON r.message_id = m.id
     WHERE m.id = ?
     GROUP BY m.id`,
    [messageId],
  );

  if (!rows.length) return null;

  const row = rows[0];

  const recipients = Number(row.recipient_count || 0);
  const delivered = Number(row.delivered_count || 0);
  const read = Number(row.read_count || 0);

  let status = "sent";

  if (recipients > 0 && read === recipients) {
    status = "read";
  } else if (recipients > 0 && delivered === recipients) {
    status = "delivered";
  }

  return {
    message_id: row.message_id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    recipient_count: recipients,
    delivered_count: delivered,
    read_count: read,
    status,
  };
}

async function emitMessageStatus(messageId) {
  if (!io) return;

  const status = await getMessageStatus(messageId);

  if (status) {
    io.to(userRoom(status.sender_id)).emit("message_status_updated", status);
  }
}

async function markMessagesDelivered(chatId, userId) {
  await query(
    `UPDATE chat_message_receipts r
     INNER JOIN chat_messages m ON m.id = r.message_id
     SET r.delivered_at = COALESCE(r.delivered_at, NOW())
     WHERE m.chat_id = ?
       AND m.user_id <> ?
       AND r.user_id = ?
       AND r.delivered_at IS NULL`,
    [chatId, userId, userId],
  );

  const messages = await query(
    `SELECT m.id
     FROM chat_messages m
     INNER JOIN chat_message_receipts r ON r.message_id = m.id
     WHERE m.chat_id = ?
       AND m.user_id <> ?
       AND r.user_id = ?`,
    [chatId, userId, userId],
  );

  for (const message of messages) {
    await emitMessageStatus(message.id);
  }
}

async function markMessagesRead(chatId, userId) {
  await query(
    `UPDATE chat_message_receipts r
     INNER JOIN chat_messages m ON m.id = r.message_id
     SET
       r.delivered_at = COALESCE(r.delivered_at, NOW()),
       r.read_at = COALESCE(r.read_at, NOW())
     WHERE m.chat_id = ?
       AND m.user_id <> ?
       AND r.user_id = ?
       AND r.read_at IS NULL`,
    [chatId, userId, userId],
  );

  const messages = await query(
    `SELECT m.id
     FROM chat_messages m
     INNER JOIN chat_message_receipts r ON r.message_id = m.id
     WHERE m.chat_id = ?
       AND m.user_id <> ?
       AND r.user_id = ?`,
    [chatId, userId, userId],
  );

  for (const message of messages) {
    await emitMessageStatus(message.id);
  }
}

// --------------------------------------------------
// CHAT MEMBERSHIP
// --------------------------------------------------

async function isChatMember(chatId, userId) {
  const rows = await query(
    `SELECT id
     FROM chat_members
     WHERE chat_id = ?
       AND user_id = ?
     LIMIT 1`,
    [chatId, userId],
  );

  return rows.length > 0;
}

// --------------------------------------------------
// SAVE TEXT MESSAGE
// --------------------------------------------------

async function saveChatMessage(chatId, userId, message) {
  const cleanMessage = String(message || "").trim();

  if (!cleanMessage) {
    throw new Error("Message cannot be empty.");
  }

  if (cleanMessage.length > 2000) {
    throw new Error("Message is too long.");
  }

  const member = await isChatMember(chatId, userId);

  if (!member) {
    const error = new Error("You are not a member of this chat.");
    error.statusCode = 403;
    throw error;
  }

  const result = await query(
    `INSERT INTO chat_messages
       (chat_id, user_id, message, message_type, created_at)
     VALUES (?, ?, ?, 'text', NOW())`,
    [chatId, userId, cleanMessage],
  );

  const messageId = result.insertId;

  await createMessageReceipts(messageId, chatId, userId);

  const rows = await query(
    `SELECT
       m.id,
       m.chat_id,
       m.user_id,
       m.message,
       m.message_type,
       m.media_url,
       m.created_at,
       u.name AS sender_name
     FROM chat_messages m
     LEFT JOIN nearpop_users u ON u.id = m.user_id
     WHERE m.id = ?
     LIMIT 1`,
    [messageId],
  );

  return rows[0];
}

// --------------------------------------------------
// SOCKET.IO SETUP
// --------------------------------------------------

exports.setSocketServer = (socketServer) => {
  io = socketServer;

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Authentication token required."));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (!decoded.user_id) {
        return next(new Error("Invalid authentication token."));
      }

      socket.user = decoded;
      next();
    } catch (error) {
      next(new Error("Invalid or expired token."));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user.user_id;

    console.log("Socket connected:", userId, socket.id);

    socket.join(userRoom(userId));

    // JOIN CHAT
    socket.on("join_chat", async (payload, callback) => {
      try {
        const chatId = Number(payload?.chat_id);

        if (!Number.isInteger(chatId) || chatId <= 0) {
          return sendAck(callback, {
            success: false,
            message: "Invalid chat ID.",
          });
        }

        const member = await isChatMember(chatId, userId);

        if (!member) {
          return sendAck(callback, {
            success: false,
            message: "You are not a member of this chat.",
          });
        }

        socket.join(chatRoom(chatId));

        await markMessagesDelivered(chatId, userId);

        sendAck(callback, {
          success: true,
          message: "Joined chat room.",
          chat_id: chatId,
        });
      } catch (error) {
        console.error("join_chat socket error:", error);

        sendAck(callback, {
          success: false,
          message: "Unable to join chat.",
        });
      }
    });

    // SEND TEXT MESSAGE
    socket.on("send_message", async (payload, callback) => {
      try {
        const chatId = Number(payload?.chat_id);

        if (!Number.isInteger(chatId) || chatId <= 0) {
          return sendAck(callback, {
            success: false,
            message: "Invalid chat ID.",
          });
        }

        const savedMessage = await saveChatMessage(
          chatId,
          userId,
          payload?.message,
        );

        io.to(chatRoom(chatId)).emit("receive_message", {
          ...savedMessage,
          is_me: false,
          status: "sent",
        });

        sendAck(callback, {
          success: true,
          message: "Message sent.",
          data: {
            ...savedMessage,
            is_me: true,
            status: "sent",
          },
        });
      } catch (error) {
        console.error("send_message socket error:", error);

        sendAck(callback, {
          success: false,
          message: error.message || "Unable to send message.",
        });
      }
    });

    // MARK CHAT AS READ
    socket.on("mark_read", async (payload, callback) => {
      try {
        const chatId = Number(payload?.chat_id);

        if (!Number.isInteger(chatId) || chatId <= 0) {
          return sendAck(callback, {
            success: false,
            message: "Invalid chat ID.",
          });
        }

        const member = await isChatMember(chatId, userId);

        if (!member) {
          return sendAck(callback, {
            success: false,
            message: "You are not a member of this chat.",
          });
        }

        await markMessagesRead(chatId, userId);

        sendAck(callback, {
          success: true,
          message: "Messages marked as read.",
        });
      } catch (error) {
        console.error("mark_read socket error:", error);

        sendAck(callback, {
          success: false,
          message: "Unable to mark messages as read.",
        });
      }
    });

    // TYPING INDICATOR
    socket.on("typing", async (payload) => {
      try {
        const chatId = Number(payload?.chat_id);

        if (!Number.isInteger(chatId) || chatId <= 0) return;

        const member = await isChatMember(chatId, userId);

        if (!member) return;

        socket.to(chatRoom(chatId)).emit("user_typing", {
          chat_id: chatId,
          user_id: userId,
          is_typing: Boolean(payload?.is_typing),
        });
      } catch (error) {
        console.error("typing socket error:", error);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", userId, socket.id);
    });
  });

  console.log("Socket.IO initialized successfully.");
};

// --------------------------------------------------
// GET ALL CHATS
// --------------------------------------------------

exports.getMyChats = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const chats = await query(
      `SELECT
          cr.id AS chat_id,
          cr.pop_id,
          cr.created_at AS chat_created_at,
          p.title,
          p.description,
          p.category,
          p.status,
          p.expires_at,
          p.user_id AS pop_owner_id,

          CASE
            WHEN p.user_id = ? THEN 'MY_POP'
            ELSE 'REPLIED_POP'
          END AS chat_type,

          (
            SELECT COUNT(*)
            FROM chat_members cm2
            WHERE cm2.chat_id = cr.id
          ) AS member_count,

          (
            SELECT cm3.joined_at
            FROM chat_members cm3
            WHERE cm3.chat_id = cr.id
              AND cm3.user_id = ?
            LIMIT 1
          ) AS joined_at,

          (
            SELECT cm4.message
            FROM chat_messages cm4
            WHERE cm4.chat_id = cr.id
            ORDER BY cm4.created_at DESC, cm4.id DESC
            LIMIT 1
          ) AS last_message,

          (
            SELECT cm5.created_at
            FROM chat_messages cm5
            WHERE cm5.chat_id = cr.id
            ORDER BY cm5.created_at DESC, cm5.id DESC
            LIMIT 1
          ) AS last_message_at

       FROM chat_rooms cr
       INNER JOIN pops p ON p.id = cr.pop_id

       WHERE
          p.user_id = ?
          OR EXISTS (
            SELECT 1
            FROM chat_members cm
            WHERE cm.chat_id = cr.id
              AND cm.user_id = ?
              AND EXISTS (
                SELECT 1
                FROM chat_messages reply
                WHERE reply.chat_id = cr.id
                  AND reply.user_id = ?
              )
          )

       ORDER BY
          COALESCE(
            (
              SELECT MAX(cm6.created_at)
              FROM chat_messages cm6
              WHERE cm6.chat_id = cr.id
            ),
            cr.created_at
          ) DESC`,
      [userId, userId, userId, userId, userId],
    );

    return res.json({
      success: true,
      data: {
        count: chats.length,
        chats,
      },
    });
  } catch (error) {
    console.error("getMyChats error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load your chats.",
    });
  }
};

// --------------------------------------------------
// JOIN POP CHAT
// --------------------------------------------------

exports.joinPopChat = async (req, res) => {
  try {
    const userId = getUserId(req);
    const popId = req.params.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    const pops = await query(
      `SELECT id, user_id, status, expires_at
       FROM pops
       WHERE id = ?
       LIMIT 1`,
      [popId],
    );

    if (!pops.length) {
      return res.status(404).json({
        success: false,
        message: "POP not found",
      });
    }

    const pop = pops[0];

    if (pop.status !== "ACTIVE" || new Date(pop.expires_at) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "This POP is no longer active",
      });
    }

    let rooms = await query(
      `SELECT id
       FROM chat_rooms
       WHERE pop_id = ?
       LIMIT 1`,
      [popId],
    );

    let chatId;

    if (rooms.length > 0) {
      chatId = rooms[0].id;
    } else {
      const result = await query(
        `INSERT INTO chat_rooms (pop_id, created_at)
         VALUES (?, NOW())`,
        [popId],
      );

      chatId = result.insertId;
    }

    const members = await query(
      `SELECT id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?
       LIMIT 1`,
      [chatId, userId],
    );

    if (!members.length) {
      await query(
        `INSERT INTO chat_members (chat_id, user_id, joined_at)
         VALUES (?, ?, NOW())`,
        [chatId, userId],
      );
    }

    const ownerMembers = await query(
      `SELECT id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?
       LIMIT 1`,
      [chatId, pop.user_id],
    );

    if (!ownerMembers.length) {
      await query(
        `INSERT INTO chat_members (chat_id, user_id, joined_at)
         VALUES (?, ?, NOW())`,
        [chatId, pop.user_id],
      );
    }

    return res.status(200).json({
      success: true,
      message: "Joined POP chat successfully",
      data: {
        chat_id: chatId,
        pop_id: Number(popId),
        user_id: userId,
      },
    });
  } catch (error) {
    console.error("joinPopChat error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to join POP chat",
      error: error.message,
    });
  }
};

// --------------------------------------------------
// GET CHAT MESSAGES
// --------------------------------------------------

exports.getChatMessages = async (req, res) => {
  try {
    const userId = getUserId(req);
    const chatId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid chat ID.",
      });
    }

    const member = await isChatMember(chatId, userId);

    if (!member) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this chat",
      });
    }

    const messages = await query(
      `SELECT
         m.id,
         m.chat_id,
         m.user_id,
         m.message,
         m.message_type,
         m.media_url,
         m.created_at,
         u.name AS sender_name,

         CASE WHEN m.user_id = ? THEN 1 ELSE 0 END AS is_me,

         CASE
           WHEN m.user_id <> ? THEN NULL
           WHEN COUNT(r.id) = 0 THEN 'sent'
           WHEN SUM(CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END) = COUNT(r.id)
             THEN 'read'
           WHEN SUM(CASE WHEN r.delivered_at IS NOT NULL THEN 1 ELSE 0 END) = COUNT(r.id)
             THEN 'delivered'
           ELSE 'sent'
         END AS status,

         COUNT(r.id) AS recipient_count,

         COALESCE(SUM(
           CASE WHEN r.delivered_at IS NOT NULL THEN 1 ELSE 0 END
         ), 0) AS delivered_count,

         COALESCE(SUM(
           CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END
         ), 0) AS read_count

       FROM chat_messages m
       LEFT JOIN nearpop_users u ON u.id = m.user_id
       LEFT JOIN chat_message_receipts r ON r.message_id = m.id

       WHERE m.chat_id = ?

       GROUP BY
         m.id,
         m.chat_id,
         m.user_id,
         m.message,
         m.message_type,
         m.media_url,
         m.created_at,
         u.name

       ORDER BY m.created_at ASC, m.id ASC`,
      [userId, userId, chatId],
    );

    await markMessagesRead(chatId, userId);

    return res.status(200).json({
      success: true,
      data: {
        messages,
      },
    });
  } catch (error) {
    console.error("getChatMessages error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load messages",
      error: error.message,
    });
  }
};

// --------------------------------------------------
// SEND TEXT MESSAGE THROUGH REST
// --------------------------------------------------

exports.sendChatMessage = async (req, res) => {
  try {
    const userId = getUserId(req);
    const chatId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid chat ID.",
      });
    }

    const savedMessage = await saveChatMessage(
      chatId,
      userId,
      req.body.message,
    );

    if (io) {
      io.to(chatRoom(chatId)).emit("receive_message", {
        ...savedMessage,
        is_me: false,
        status: "sent",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Message sent",
      data: {
        ...savedMessage,
        is_me: true,
        status: "sent",
      },
    });
  } catch (error) {
    console.error("sendChatMessage error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to send message",
    });
  }
};

// --------------------------------------------------
// SEND IMAGE MESSAGE
// POST /api/chats/:id/images
// --------------------------------------------------

exports.sendChatImage = async (req, res) => {
  try {
    const userId = getUserId(req);
    const chatId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid chat ID.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please select an image.",
      });
    }

    const member = await isChatMember(chatId, userId);

    if (!member) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this chat.",
      });
    }

    const caption = String(req.body.caption || "").trim();

    if (caption.length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Caption is too long.",
      });
    }

    const mediaUrl = `/uploads/chat-images/${req.file.filename}`;
    const messageText = caption || "Image";

    const result = await query(
      `INSERT INTO chat_messages
         (chat_id, user_id, message, message_type, media_url, created_at)
       VALUES (?, ?, ?, 'image', ?, NOW())`,
      [chatId, userId, messageText, mediaUrl],
    );

    const messageId = result.insertId;

    await createMessageReceipts(messageId, chatId, userId);

    const rows = await query(
      `SELECT
         m.id,
         m.chat_id,
         m.user_id,
         m.message,
         m.message_type,
         m.media_url,
         m.created_at,
         u.name AS sender_name
       FROM chat_messages m
       LEFT JOIN nearpop_users u ON u.id = m.user_id
       WHERE m.id = ?
       LIMIT 1`,
      [messageId],
    );

    const savedMessage = rows[0];

    const outgoing = {
      ...savedMessage,
      is_me: false,
      status: "sent",
    };

    if (io) {
      io.to(chatRoom(chatId)).emit("receive_message", outgoing);
    }

    return res.status(201).json({
      success: true,
      message: "Image sent successfully.",
      data: {
        ...savedMessage,
        is_me: true,
        status: "sent",
      },
    });
  } catch (error) {
    console.error("sendChatImage error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to send image.",
    });
  }
};
