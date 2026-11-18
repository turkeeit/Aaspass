const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

let db;

exports.setDatabase = (connection) => {
  db = connection;
};

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) {
        return reject(error);
      }

      resolve(results);
    });
  });
};

// ==========================================
// GOOGLE CLIENT
// ==========================================

const getGoogleClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is missing in .env");
  }

  return new OAuth2Client(clientId);
};

// ==========================================
// GOOGLE LOGIN
// POST /api/auth/google
// ==========================================

exports.googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google ID token is required",
      });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is missing in .env");
    }

    if (!db) {
      throw new Error("Database connection is not initialized");
    }

    const webClientId = process.env.GOOGLE_CLIENT_ID;

    if (!webClientId) {
      throw new Error("GOOGLE_CLIENT_ID is missing in .env");
    }

    // Diagnostic information only.
    // jwt.decode does NOT verify the token.
    const decodedToken = jwt.decode(idToken);

    console.log("========== GOOGLE LOGIN DEBUG ==========");
    console.log("Configured Web Client ID:", webClientId);
    console.log("Token audience:", decodedToken?.aud);
    console.log("Token issuer:", decodedToken?.iss);
    console.log("Token email:", decodedToken?.email);
    console.log("=========================================");

    // ==========================================
    // VERIFY GOOGLE ID TOKEN
    // ==========================================

    let payload;

    try {
      const googleClient = getGoogleClient();

      const ticket = await googleClient.verifyIdToken({
        idToken: idToken,
        audience: webClientId,
      });

      payload = ticket.getPayload();
    } catch (error) {
      console.error("GOOGLE TOKEN VERIFICATION FAILED:");
      console.error(error.message);

      return res.status(401).json({
        success: false,
        message: "Google ID token verification failed",
        error: error.message,
      });
    }

    if (!payload || !payload.sub || !payload.email) {
      return res.status(401).json({
        success: false,
        message: "Invalid Google account",
      });
    }

    if (payload.email_verified !== true) {
      return res.status(401).json({
        success: false,
        message: "Google email is not verified",
      });
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase();
    const name = payload.name || "";
    const profilePicture = payload.picture || null;

    // ==========================================
    // FIND EXISTING USER
    // ==========================================

    let users = await query(
      `SELECT id, google_id, email, name, profile_picture
       FROM nearpop_users
       WHERE google_id = ?`,
      [googleId],
    );

    let user;

    if (users.length > 0) {
      user = users[0];

      await query(
        `UPDATE nearpop_users
         SET email = ?, name = ?, profile_picture = ?
         WHERE id = ?`,
        [email, name, profilePicture, user.id],
      );

      user.email = email;
      user.name = name;
      user.profile_picture = profilePicture;
    } else {
      // Check existing email

      const emailUsers = await query(
        `SELECT id, google_id, email
         FROM nearpop_users
         WHERE email = ?`,
        [email],
      );

      if (emailUsers.length > 0) {
        return res.status(409).json({
          success: false,
          message: "This email is already registered with another account.",
        });
      }

      // ==========================================
      // CREATE NEW USER
      // ==========================================

      const result = await query(
        `INSERT INTO nearpop_users
         (google_id, email, name, profile_picture)
         VALUES (?, ?, ?, ?)`,
        [googleId, email, name, profilePicture],
      );

      user = {
        id: result.insertId,
        google_id: googleId,
        email: email,
        name: name,
        profile_picture: profilePicture,
      };
    }

    // ==========================================
    // GENERATE NEARPOP JWT
    // ==========================================

    const token = jwt.sign(
      {
        user_id: user.id,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "365d",
      },
    );

    console.log("NearPop Google login successful:", email);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        token: token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          profile_picture: user.profile_picture,
        },
      },
    });
  } catch (error) {
    console.error("NEARPOP LOGIN SERVER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error during login",
    });
  }
};

// ==========================================
// GET CURRENT USER
// GET /api/auth/me
// ==========================================

exports.getCurrentUser = async (req, res) => {
  console.log("Fetching current user profile for user_id:", req.user.user_id);
  try {
    const users = await query(
      `SELECT id, email, name, profile_picture
       FROM nearpop_users
       WHERE id = ?`,
      [req.user.user_id],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: users[0],
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch profile",
    });
  }
};
