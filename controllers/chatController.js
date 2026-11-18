let db;

exports.setDatabase = (connection) => {
  db = connection;
};

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });
};

const getUserId = (req) => {
  return req.user?.user_id || req.user?.id || null;
};

// --------------------------------------------------
// GET ALL CHATS FOR LOGGED-IN USER
// GET /api/chats
// --------------------------------------------------

exports.getMyChats = async (req, res) => {
  try {
    const userId = req.user?.user_id || req.user?.id;
    console.log("========== GET MY CHATS ==========");
    console.log("JWT USER:", req.user);
    console.log("RESOLVED USER ID:", userId);

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

       INNER JOIN pops p
          ON p.id = cr.pop_id

       WHERE
          p.user_id = ?
          OR EXISTS (
            SELECT 1
            FROM chat_members cm
            WHERE cm.chat_id = cr.id
              AND cm.user_id = ?
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
      [userId, userId, userId, userId],
    );

    console.log("CHATS RETURNED:", chats.length);
    console.log(
      "POP DETAILS:",
      chats.map((chat) => ({
        chat_id: chat.chat_id,
        pop_id: chat.pop_id,
        owner_id: chat.pop_owner_id,
        chat_type: chat.chat_type,
      })),
    );
    console.log("==================================");

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
// POST /api/pops/:id/join
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

    if (pops.length === 0) {
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

    if (members.length === 0) {
      await query(
        `INSERT INTO chat_members (chat_id, user_id, joined_at)
         VALUES (?, ?, NOW())`,
        [chatId, userId],
      );
    }

    // Also add the POP owner as a member, if not already present.
    const ownerMembers = await query(
      `SELECT id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?
       LIMIT 1`,
      [chatId, pop.user_id],
    );

    if (ownerMembers.length === 0) {
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
// GET /api/chats/:id/messages
// --------------------------------------------------

exports.getChatMessages = async (req, res) => {
  try {
    const userId = getUserId(req);
    const chatId = req.params.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    const membership = await query(
      `SELECT id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?
       LIMIT 1`,
      [chatId, userId],
    );

    if (membership.length === 0) {
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
         m.created_at,
         u.name AS sender_name,
         CASE WHEN m.user_id = ? THEN 1 ELSE 0 END AS is_me
       FROM chat_messages m
       LEFT JOIN nearpop_users u ON u.id = m.user_id
       WHERE m.chat_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
      [userId, chatId],
    );

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
// SEND CHAT MESSAGE
// POST /api/chats/:id/messages
// --------------------------------------------------

exports.sendChatMessage = async (req, res) => {
  try {
    const userId = getUserId(req);
    const chatId = req.params.id;
    const message = (req.body.message || "").trim();

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty",
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Message is too long",
      });
    }

    const membership = await query(
      `SELECT id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?
       LIMIT 1`,
      [chatId, userId],
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this chat",
      });
    }

    const result = await query(
      `INSERT INTO chat_messages
       (chat_id, user_id, message, created_at)
       VALUES (?, ?, ?, NOW())`,
      [chatId, userId, message],
    );

    return res.status(201).json({
      success: true,
      message: "Message sent",
      data: {
        id: result.insertId,
        chat_id: Number(chatId),
        user_id: userId,
        message,
        created_at: new Date(),
      },
    });
  } catch (error) {
    console.error("sendChatMessage error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to send message",
      error: error.message,
    });
  }
};
