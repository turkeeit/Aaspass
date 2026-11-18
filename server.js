require("dotenv").config();

const express = require("express");
const cors = require("cors");

const db = require("./config/dbconfig");

const authController = require("./controllers/authController");
const nearpopController = require("./controllers/nearpopController");
const chatController = require("./controllers/chatController");

const verifyToken = require("./middleware/authMiddleware");

const app = express();

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// DATABASE CONNECTION
// --------------------------------------------------

authController.setDatabase(db);
nearpopController.setDatabase(db);
chatController.setDatabase(db);

// --------------------------------------------------
// AUTH ROUTES
// --------------------------------------------------

app.post("/api/auth/google", authController.googleLogin);

app.get("/api/auth/me", verifyToken, authController.getCurrentUser);

// --------------------------------------------------
// POP ROUTES
// --------------------------------------------------

app.post("/api/pops", verifyToken, nearpopController.createPop);

app.get("/api/pops/nearby", verifyToken, nearpopController.getNearbyPops);

app.get("/api/pops/my", verifyToken, nearpopController.getMyPops);

app.get("/api/pops/:id", verifyToken, nearpopController.getPopDetails);

// Join POP and create/retrieve chat room.
app.post("/api/pops/:id/join", verifyToken, chatController.joinPopChat);

app.post("/api/pops/:id/close", verifyToken, nearpopController.closePop);

// --------------------------------------------------
// CHAT ROUTES
// --------------------------------------------------

// Get all chats for logged-in user (User 1 or User 2).
app.get("/api/chats", verifyToken, chatController.getMyChats);

// Get messages for a chat.
app.get("/api/chats/:id/messages", verifyToken, chatController.getChatMessages);

// Send a message.
app.post(
  "/api/chats/:id/messages",
  verifyToken,
  chatController.sendChatMessage,
);

// --------------------------------------------------
// PROFILE ROUTE
// --------------------------------------------------

app.get("/api/users/profile", verifyToken, nearpopController.getProfile);

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "NearPop API is running.",
  });
});

// --------------------------------------------------
// 404 HANDLER
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 6000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("NearPop API running on port " + PORT);
});
