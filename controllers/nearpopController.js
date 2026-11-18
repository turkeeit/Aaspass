let db;

exports.setDatabase = (connection) => {
  db = connection;
};

const query = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params || [], (error, results) => {
      if (error) {
        return reject(error);
      }
      resolve(results);
    });
  });
};

const getUserId = (req) => {
  return req.user?.user_id || req.user?.id || null;
};

const isValidCoordinates = (latitude, longitude) => {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
};

// --------------------------------------------------
// CREATE POP
// POST /api/pops
// Creates POP + chat room + creator membership
// --------------------------------------------------

exports.createPop = async (req, res) => {
  let connection = null;
  let ownsConnection = false;
  let transactionStarted = false;

  const runQuery = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      connection.query(sql, params, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  };

  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const category = String(req.body.category || "General").trim();

    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const durationMinutes = Number(req.body.durationMinutes);

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Title is required.",
      });
    }

    if (title.length > 150) {
      return res.status(400).json({
        success: false,
        message: "Title cannot exceed 150 characters.",
      });
    }

    if (category.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Category cannot exceed 50 characters.",
      });
    }

    if (!isValidCoordinates(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    const allowedDurations = [2, 10, 60, 1440];

    if (!allowedDurations.includes(durationMinutes)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid POP duration. Allowed durations are 2, 10, 60 and 1440 minutes.",
      });
    }

    if (!db) {
      throw new Error(
        "Database has not been initialized. Call setDatabase(db) first.",
      );
    }

    // Supports mysql.createPool() and mysql.createConnection().
    if (typeof db.getConnection === "function") {
      connection = await new Promise((resolve, reject) => {
        db.getConnection((error, conn) => {
          if (error) return reject(error);
          resolve(conn);
        });
      });

      ownsConnection = true;
    } else {
      connection = db;
    }

    await new Promise((resolve, reject) => {
      connection.beginTransaction((error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    transactionStarted = true;

    // 1. Create POP.
    const popResult = await runQuery(
      `INSERT INTO pops
       (
         user_id,
         title,
         description,
         category,
         latitude,
         longitude,
         expires_at,
         status
       )
       VALUES (
         ?, ?, ?, ?, ?, ?,
         DATE_ADD(NOW(), INTERVAL ? MINUTE),
         'ACTIVE'
       )`,
      [
        userId,
        title,
        description,
        category,
        latitude,
        longitude,
        durationMinutes,
      ],
    );

    const popId = popResult.insertId;

    // 2. Create one chat room for this POP.
    const roomResult = await runQuery(
      `INSERT INTO chat_rooms (pop_id, created_at)
       VALUES (?, NOW())`,
      [popId],
    );

    const chatId = roomResult.insertId;

    // 3. Add POP creator as the first chat member.
    await runQuery(
      `INSERT INTO chat_members (chat_id, user_id, joined_at)
       VALUES (?, ?, NOW())`,
      [chatId, userId],
    );

    await new Promise((resolve, reject) => {
      connection.commit((error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "POP and chat room created successfully.",
      data: {
        pop_id: popId,
        chat_id: chatId,
        user_id: userId,
        title,
        description,
        category,
        latitude,
        longitude,
        durationMinutes,
        status: "ACTIVE",
      },
    });
  } catch (error) {
    if (transactionStarted && connection) {
      await new Promise((resolve) => {
        connection.rollback(() => resolve());
      });
    }

    console.error("createPop error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create POP.",
      error: error.message,
    });
  } finally {
    if (ownsConnection && connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// GET NEARBY POPS
// GET /api/pops/nearby
// radius = 5, 10, 20, 50, 100, 500 or all
// --------------------------------------------------

exports.getNearbyPops = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);

    const radiusInput = String(req.query.radius || "5").toLowerCase();
    const showAll = radiusInput === "all";
    const radius = showAll ? null : Number(radiusInput);

    console.log(
      "Fetching nearby POPs for user_id:",
      userId,
      "with radius:",
      radiusInput,
    );

    if (!isValidCoordinates(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    if (!showAll && (!Number.isFinite(radius) || radius <= 0)) {
      return res.status(400).json({
        success: false,
        message: "Invalid search radius.",
      });
    }

    const distanceSql = `
      (
        6371 * ACOS(
          LEAST(
            1,
            GREATEST(
              -1,
              COS(RADIANS(?)) *
              COS(RADIANS(p.latitude)) *
              COS(RADIANS(p.longitude) - RADIANS(?)) +
              SIN(RADIANS(?)) *
              SIN(RADIANS(p.latitude))
            )
          )
        )
      )
    `;

    let sql = `
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.description,
        p.category,
        p.latitude,
        p.longitude,
        p.expires_at,
        p.status,
        p.created_at,
        u.name AS user_name,
        u.profile_picture,
        ${distanceSql} AS distance,
        cr.id AS chat_id,

        (
          SELECT COUNT(*)
          FROM chat_members cm
          WHERE cm.chat_id = cr.id
        ) AS member_count,

        EXISTS (
          SELECT 1
          FROM chat_members cm2
          WHERE cm2.chat_id = cr.id
            AND cm2.user_id = ?
        ) AS user_joined

      FROM pops p

      INNER JOIN nearpop_users u
        ON u.id = p.user_id

      LEFT JOIN chat_rooms cr
        ON cr.pop_id = p.id

      WHERE p.status = 'ACTIVE'
        AND p.expires_at > NOW()
        AND p.user_id != ?
    `;

    const params = [latitude, longitude, latitude, userId, userId];

    if (!showAll) {
      sql += ` AND ${distanceSql} <= ?`;

      params.push(latitude, longitude, latitude, radius);
    }

    sql += ` ORDER BY distance ASC, p.created_at DESC`;

    const pops = await query(sql, params);

    const formattedPops = pops.map((pop) => ({
      id: pop.id,
      user_id: pop.user_id,
      title: pop.title,
      description: pop.description,
      category: pop.category,
      latitude: pop.latitude,
      longitude: pop.longitude,
      expires_at: pop.expires_at,
      status: pop.status,
      created_at: pop.created_at,
      user_name: pop.user_name,
      profile_picture: pop.profile_picture,
      distance: Number(pop.distance || 0),
      chat_id: pop.chat_id,
      member_count: Number(pop.member_count || 0),
      user_joined: Boolean(pop.user_joined),
      is_mine: false,
    }));

    return res.json({
      success: true,
      message: "Nearby users' POPs loaded successfully.",
      data: {
        radius: showAll ? "all" : radius,
        count: formattedPops.length,
        pops: formattedPops,
      },
    });
  } catch (error) {
    console.error("getNearbyPops error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load nearby POPs.",
    });
  }
};

// --------------------------------------------------
// GET MY POPS
// GET /api/pops/my
// --------------------------------------------------

exports.getMyPops = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const pops = await query(
      `SELECT
         p.id,
         p.user_id,
         p.title,
         p.description,
         p.category,
         p.latitude,
         p.longitude,
         p.expires_at,
         p.status,
         p.created_at,
         u.name AS user_name,
         u.profile_picture,
         cr.id AS chat_id,

         (
           SELECT COUNT(*)
           FROM chat_members cm
           WHERE cm.chat_id = cr.id
         ) AS member_count,

         EXISTS (
           SELECT 1
           FROM chat_members cm2
           WHERE cm2.chat_id = cr.id
             AND cm2.user_id = ?
         ) AS user_joined

       FROM pops p

       INNER JOIN nearpop_users u
         ON u.id = p.user_id

       LEFT JOIN chat_rooms cr
         ON cr.pop_id = p.id

       WHERE p.user_id = ?

       ORDER BY p.created_at DESC`,
      [userId, userId],
    );

    const formattedPops = pops.map((pop) => ({
      id: pop.id,
      user_id: pop.user_id,
      title: pop.title,
      description: pop.description,
      category: pop.category,
      latitude: pop.latitude,
      longitude: pop.longitude,
      expires_at: pop.expires_at,
      status: pop.status,
      created_at: pop.created_at,
      user_name: pop.user_name,
      profile_picture: pop.profile_picture,
      distance: 0,
      chat_id: pop.chat_id,
      member_count: Number(pop.member_count || 0),
      user_joined: Boolean(pop.user_joined),
      is_mine: true,
    }));

    return res.json({
      success: true,
      message: "My POPs loaded successfully.",
      data: {
        count: formattedPops.length,
        pops: formattedPops,
      },
    });
  } catch (error) {
    console.error("getMyPops error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load your POPs.",
    });
  }
};

// --------------------------------------------------
// GET POP DETAILS
// GET /api/pops/:id
// --------------------------------------------------

exports.getPopDetails = async (req, res) => {
  try {
    const userId = getUserId(req);
    const popId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!Number.isInteger(popId) || popId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid POP ID.",
      });
    }

    const rows = await query(
      `SELECT
         p.*,
         u.name AS user_name,
         u.email,
         u.profile_picture
       FROM pops p
       INNER JOIN nearpop_users u ON u.id = p.user_id
       WHERE p.id = ?
       LIMIT 1`,
      [popId],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "POP not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        pop: rows[0],
      },
    });
  } catch (error) {
    console.error("getPopDetails error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to get POP details.",
    });
  }
};

// --------------------------------------------------
// CLOSE POP
// POST /api/pops/:id/close
// --------------------------------------------------

exports.closePop = async (req, res) => {
  try {
    const userId = getUserId(req);
    const popId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!Number.isInteger(popId) || popId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid POP ID.",
      });
    }

    const result = await query(
      `UPDATE pops
       SET status = 'CLOSED'
       WHERE id = ?
         AND user_id = ?
         AND status = 'ACTIVE'`,
      [popId, userId],
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Active POP not found or you do not own it.",
      });
    }

    return res.json({
      success: true,
      message: "POP closed successfully.",
    });
  } catch (error) {
    console.error("closePop error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to close POP.",
    });
  }
};

// --------------------------------------------------
// GET MY PROFILE
// GET /api/users/profile
// --------------------------------------------------

exports.getProfile = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const users = await query(
      `SELECT
         id,
         name,
         email,
         profile_picture,
         created_at
       FROM nearpop_users
       WHERE id = ?
       LIMIT 1`,
      [userId],
    );

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        user: users[0],
      },
    });
  } catch (error) {
    console.error("getProfile error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load profile.",
    });
  }
};

// --------------------------------------------------
// GET MY CHATS
// GET /api/chats
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

         (
           SELECT COUNT(*)
           FROM chat_members cm2
           WHERE cm2.chat_id = cr.id
         ) AS member_count

       FROM chat_members cm

       INNER JOIN chat_rooms cr
         ON cr.id = cm.chat_id

       INNER JOIN pops p
         ON p.id = cr.pop_id

       WHERE cm.user_id = ?

       ORDER BY cr.created_at DESC`,
      [userId],
    );

    return res.json({
      success: true,
      data: {
        chats: chats,
      },
    });
  } catch (error) {
    console.error("getMyChats error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load chats.",
    });
  }
};

// --------------------------------------------------
// EXPLICIT MODULE EXPORTS
// Keep this at the very bottom.
// --------------------------------------------------

module.exports = {
  setDatabase: exports.setDatabase,
  createPop: exports.createPop,
  getNearbyPops: exports.getNearbyPops,
  getMyPops: exports.getMyPops,
  getPopDetails: exports.getPopDetails,
  closePop: exports.closePop,
  getProfile: exports.getProfile,
  getMyChats: exports.getMyChats,
};
