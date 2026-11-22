require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const db = require("./config/dbconfig");

const authController = require("./controllers/authController");
const nearpopController = require("./controllers/nearpopController");
const chatController = require("./controllers/chatController");

const verifyToken = require("./middleware/authMiddleware");

const app = express();
const server = http.createServer(app);

// --------------------------------------------------
// IMAGE UPLOAD CONFIGURATION
// --------------------------------------------------

const uploadDirectory = path.join(__dirname, "uploads", "chat-images");

fs.mkdirSync(uploadDirectory, { recursive: true });

const allowedMimeTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

const allowedExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
];

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, uploadDirectory);
  },

  filename: (req, file, callback) => {
    let extension = path.extname(file.originalname).toLowerCase();

    // Use MIME type if the original filename has no extension.
    if (!extension) {
      const mimeExtensions = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/heic": ".heic",
        "image/heif": ".heif",
      };

      extension = mimeExtensions[file.mimetype.toLowerCase()] || ".jpg";
    }

    const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

    callback(null, filename);
  },
});

const fileFilter = (req, file, callback) => {
  const mimeType = (file.mimetype || "").toLowerCase();
  const extension = path.extname(file.originalname || "").toLowerCase();

  console.log("IMAGE UPLOAD REQUEST:", {
    originalname: file.originalname,
    mimetype: file.mimetype,
    extension: extension,
  });

  const validMimeType = allowedMimeTypes.includes(mimeType);
  const validExtension = allowedExtensions.includes(extension);

  // Accept if either MIME type or extension identifies a supported image.
  if (validMimeType || validExtension) {
    return callback(null, true);
  }

  return callback(
    new Error(
      "Unsupported image format. Received MIME: " +
        mimeType +
        ", extension: " +
        (extension || "none"),
    ),
  );
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,

  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// --------------------------------------------------
// SOCKET.IO
// --------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(cors());

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  }),
);

// Serve uploaded images.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --------------------------------------------------
// DATABASE CONNECTION
// --------------------------------------------------

authController.setDatabase(db);

nearpopController.setDatabase(db);

chatController.setDatabase(db);

chatController.setSocketServer(io);

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

app.post("/api/pops/:id/join", verifyToken, chatController.joinPopChat);

app.post("/api/pops/:id/close", verifyToken, nearpopController.closePop);

// --------------------------------------------------
// CHAT ROUTES
// --------------------------------------------------

app.get("/api/chats", verifyToken, chatController.getMyChats);

app.get("/api/chats/:id/messages", verifyToken, chatController.getChatMessages);

app.post(
  "/api/chats/:id/messages",
  verifyToken,
  chatController.sendChatMessage,
);

// Upload an image to a chat.
app.post(
  "/api/chats/:id/images",
  verifyToken,
  upload.single("image"),
  chatController.sendChatImage,
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
    socket: "enabled",
    image_upload: "enabled",
    supported_image_formats: [
      "JPG",
      "JPEG",
      "PNG",
      "WEBP",
      "GIF",
      "HEIC",
      "HEIF",
    ],
    maximum_image_size: "10 MB",
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

  // Remove uploaded file if a later middleware/controller fails.
  if (req.file && req.file.path && fs.existsSync(req.file.path)) {
    fs.unlink(req.file.path, (unlinkError) => {
      if (unlinkError) {
        console.error("Unable to remove uploaded file:", unlinkError);
      }
    });
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Image size cannot exceed 10 MB."
          : error.message,
    });
  }

  if (error.message && error.message.startsWith("Only JPG")) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 6000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("NearPop API running on port " + PORT);
  console.log("Socket.IO server running.");
  console.log("Chat image uploads enabled.");
});
