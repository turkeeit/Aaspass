const fs = require("fs");
const path = require("path");

let db;

exports.setDatabase = (connection) => {
  db = connection;
};

// --------------------------------------------------
// DATABASE QUERY
// --------------------------------------------------

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
// IMAGE HELPERS
// --------------------------------------------------

const MAX_POP_IMAGES = 3;

const getUploadedFiles = (req) => {
  return Array.isArray(req.files) ? req.files : [];
};

const cleanupUploadedFiles = async (files) => {
  if (!files || !files.length) return;

  await Promise.all(
    files.map((file) => {
      if (!file || !file.path) return Promise.resolve();

      return fs.promises.unlink(file.path).catch((error) => {
        if (error.code !== "ENOENT") {
          console.error("Unable to delete uploaded image:", error);
        }
      });
    }),
  );
};

// Uses PUBLIC_BASE_URL when configured.
// Otherwise uses the current request host.
const getImageUrl = (req, filename) => {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL;

  const baseUrl = configuredBaseUrl
    ? configuredBaseUrl.replace(/\/+$/, "")
    : `${req.protocol}://${req.get("host")}`;

  return `${baseUrl}/uploads/pop-images/${encodeURIComponent(filename)}`;
};

// Fetch images for multiple POPs in one query.
const attachImagesToPops = async (pops) => {
  if (!pops || !pops.length) return pops;

  const popIds = pops.map((pop) => pop.id);
  const placeholders = popIds.map(() => "?").join(",");

  const images = await query(
    `SELECT id, pop_id, image_url, created_at
     FROM pop_attachments
     WHERE pop_id IN (${placeholders})
     ORDER BY id ASC`,
    popIds,
  );

  const imageMap = {};

  images.forEach((image) => {
    const key = String(image.pop_id);

    if (!imageMap[key]) {
      imageMap[key] = [];
    }

    imageMap[key].push({
      id: image.id,
      url: image.image_url,
      image_url: image.image_url,
      created_at: image.created_at,
    });
  });

  return pops.map((pop) => ({
    ...pop,
    attachments: imageMap[String(pop.id)] || [],
  }));
};

// --------------------------------------------------
// EXPIRE POPS
// --------------------------------------------------

const expirePops = async () => {
  return query(
    `UPDATE pops
     SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND expires_at <= NOW()`,
    [],
  );
};

// --------------------------------------------------
// CREATE POP
// POST /api/pops
// Supports up to 3 optional images.
// --------------------------------------------------

exports.createPop = async (req, res) => {
  let connection = null;
  let ownsConnection = false;
  let transactionStarted = false;
  let creationSucceeded = false;

  const uploadedFiles = getUploadedFiles(req);

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
        message: "Unauthorized.",
      });
    }

    if (uploadedFiles.length > MAX_POP_IMAGES) {
      return res.status(400).json({
        success: false,
        message: "You can upload a maximum of 3 images per POP.",
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
      throw new Error("Database has not been initialized.");
    }

    // Get a dedicated connection for the transaction.
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

    // --------------------------------------------------
    // INSERT POP
    // --------------------------------------------------

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

    // --------------------------------------------------
    // CREATE CHAT ROOM
    // --------------------------------------------------

    const roomResult = await runQuery(
      `INSERT INTO chat_rooms (pop_id, created_at)
       VALUES (?, NOW())`,
      [popId],
    );

    const chatId = roomResult.insertId;

    // --------------------------------------------------
    // ADD POP OWNER TO CHAT
    // --------------------------------------------------

    await runQuery(
      `INSERT INTO chat_members (chat_id, user_id, joined_at)
       VALUES (?, ?, NOW())`,
      [chatId, userId],
    );

    // --------------------------------------------------
    // SAVE POP IMAGES
    // --------------------------------------------------

    const savedAttachments = [];

    for (const file of uploadedFiles) {
      const imageUrl = getImageUrl(req, file.filename);

      await runQuery(
        `INSERT INTO pop_attachments
         (pop_id, image_url)
         VALUES (?, ?)`,
        [popId, imageUrl],
      );

      savedAttachments.push({
        url: imageUrl,
        image_url: imageUrl,
      });
    }

    // --------------------------------------------------
    // COMMIT TRANSACTION
    // --------------------------------------------------

    await new Promise((resolve, reject) => {
      connection.commit((error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    transactionStarted = false;
    creationSucceeded = true;

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
        attachments: savedAttachments,
      },
    });
  } catch (error) {
    if (transactionStarted && connection) {
      await new Promise((resolve) => {
        connection.rollback(() => resolve());
      });

      transactionStarted = false;
    }

    console.error("createPop error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create POP.",
      error: error.message,
    });
  } finally {
    // Remove uploaded images if the POP transaction failed.
    if (!creationSucceeded) {
      await cleanupUploadedFiles(uploadedFiles);
    }

    if (ownsConnection && connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// GET NEARBY POPS
// GET /api/pops/nearby
// --------------------------------------------------

exports.getNearbyPops = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    await expirePops();

    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);

    const radiusInput = String(req.query.radius || "auto").toLowerCase();

    const isAuto = radiusInput === "auto";
    const showAll = radiusInput === "all";

    const requestedRadius = isAuto || showAll ? null : Number(radiusInput);

    const allowedRadii = [5, 10, 20, 50, 100, 500];

    const POP_LIMIT = 20;
    const AUTO_TARGET = 20;

    if (!isValidCoordinates(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    if (!isAuto && !showAll && !allowedRadii.includes(requestedRadius)) {
      return res.status(400).json({
        success: false,
        message: "Invalid search radius.",
      });
    }

    console.log("Fetching POPs:", userId, "Mode:", radiusInput);

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

    const countWithinRadius = async (radius) => {
      const countResult = await query(
        `SELECT COUNT(*) AS total
         FROM pops p
         INNER JOIN nearpop_users u
           ON u.id = p.user_id
         WHERE p.status = 'ACTIVE'
           AND p.expires_at > NOW()
           AND p.user_id != ?
           AND ${distanceSql} <= ?`,
        [userId, latitude, longitude, latitude, radius],
      );

      return Number(countResult[0]?.total || 0);
    };

    let selectedRadius = requestedRadius;
    let availableCount = 0;

    // --------------------------------------------------
    // AUTOMATIC SEARCH
    // --------------------------------------------------

    if (isAuto) {
      const searchRadii = [5, 10, 20, 50, 100, 500];

      selectedRadius = 500;

      for (const radius of searchRadii) {
        const total = await countWithinRadius(radius);

        console.log("Auto radius:", radius, "KM | eligible POPs:", total);

        if (total >= AUTO_TARGET) {
          selectedRadius = radius;
          availableCount = total;
          break;
        }

        if (radius === 500) {
          selectedRadius = 500;
          availableCount = total;
        }
      }
    }

    // --------------------------------------------------
    // ALL POPS
    // --------------------------------------------------
    else if (showAll) {
      const countResult = await query(
        `SELECT COUNT(*) AS total
         FROM pops p
         INNER JOIN nearpop_users u
           ON u.id = p.user_id
         WHERE p.status = 'ACTIVE'
           AND p.expires_at > NOW()
           AND p.user_id != ?`,
        [userId],
      );

      availableCount = Number(countResult[0]?.total || 0);
    }

    // --------------------------------------------------
    // MANUAL RADIUS SEARCH
    // --------------------------------------------------
    else {
      availableCount = await countWithinRadius(selectedRadius);
    }

    // --------------------------------------------------
    // FETCH POPS
    // --------------------------------------------------

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

      params.push(latitude, longitude, latitude, selectedRadius);
    }

    sql += `
      ORDER BY distance ASC, p.created_at DESC
      LIMIT ?
    `;

    params.push(POP_LIMIT);

    const pops = await query(sql, params);

    // Fetch images for all returned POPs in one query.
    const popsWithImages = await attachImagesToPops(pops);

    // --------------------------------------------------
    // FORMAT RESPONSE
    // --------------------------------------------------

    const formattedPops = popsWithImages.map((pop) => ({
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

      attachments: pop.attachments,
    }));

    return res.json({
      success: true,
      message: "Nearby POPs loaded successfully.",

      data: {
        mode: isAuto ? "auto" : showAll ? "all" : "manual",

        radius: showAll ? "all" : selectedRadius,

        count: formattedPops.length,

        available_count: availableCount,

        target_count: AUTO_TARGET,

        limit: POP_LIMIT,

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
// --------------------------------------------------

exports.getMyPops = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    await expirePops();

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
       INNER JOIN nearpop_users u ON u.id = p.user_id
       LEFT JOIN chat_rooms cr ON cr.pop_id = p.id
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC`,
      [userId, userId],
    );

    const popsWithImages = await attachImagesToPops(pops);

    const formattedPops = popsWithImages.map((pop) => ({
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
      attachments: pop.attachments,
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
// --------------------------------------------------

exports.getPopDetails = async (req, res) => {
  try {
    const userId = getUserId(req);
    const popId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    if (!Number.isInteger(popId) || popId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid POP ID.",
      });
    }

    await expirePops();

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

    const attachmentRows = await query(
      `SELECT id, pop_id, image_url, created_at
       FROM pop_attachments
       WHERE pop_id = ?
       ORDER BY id ASC`,
      [popId],
    );

    const attachments = attachmentRows.map((image) => ({
      id: image.id,
      url: image.image_url,
      image_url: image.image_url,
      created_at: image.created_at,
    }));

    return res.json({
      success: true,
      data: {
        pop: {
          ...rows[0],
          attachments,
        },
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
// --------------------------------------------------

exports.closePop = async (req, res) => {
  try {
    const userId = getUserId(req);
    const popId = Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    if (!Number.isInteger(popId) || popId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid POP ID.",
      });
    }

    await expirePops();

    const result = await query(
      `UPDATE pops
       SET status = 'CLOSED'
       WHERE id = ?
         AND user_id = ?
         AND status = 'ACTIVE'
         AND expires_at > NOW()`,
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
// --------------------------------------------------

exports.getProfile = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
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
// --------------------------------------------------

exports.getMyChats = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    await expirePops();

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
           WHEN p.status = 'ACTIVE'
             AND p.expires_at > NOW()
           THEN 0
           ELSE 1
         END AS read_only,

         (
           SELECT COUNT(*)
           FROM chat_members cm2
           WHERE cm2.chat_id = cr.id
         ) AS member_count

       FROM chat_members cm
       INNER JOIN chat_rooms cr ON cr.id = cm.chat_id
       INNER JOIN pops p ON p.id = cr.pop_id
       WHERE cm.user_id = ?
       ORDER BY cr.created_at DESC`,
      [userId],
    );

    const chatsWithImages = await attachImagesToPops(
      chats.map((chat) => ({
        ...chat,
        id: chat.pop_id,
      })),
    );

    const formattedChats = chatsWithImages.map((chat) => {
      const { id, ...chatData } = chat;

      return chatData;
    });

    return res.json({
      success: true,
      data: {
        chats: formattedChats,
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
