const path = require("path");
const dotenv = require("dotenv");

// --------------------------------------------------
// LOAD ENVIRONMENT VARIABLES
// --------------------------------------------------

const envPath = path.join(__dirname, ".env");

const envResult = dotenv.config({
  path: envPath,
  override: true,
});

console.log("ENV file:", envPath);

if (envResult.error) {
  console.error("ENV loading error:", envResult.error.message);
} else {
  console.log("ENV file loaded successfully.");
}

console.log(
  "Firebase credentials ENV:",
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "NOT CONFIGURED",
);

// --------------------------------------------------
// IMPORT DEPENDENCIES
// --------------------------------------------------

const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const db = require("./config/dbconfig");

// Controllers
const authController = require("./controllers/authController");
const nearpopController = require("./controllers/nearpopController");
const chatController = require("./controllers/chatController");
const notificationController = require("./controllers/notificationController");

// Middleware
const verifyToken = require("./middleware/authMiddleware");

// Notification service
const notificationService = require("./notificationService");

// --------------------------------------------------
// APP INITIALIZATION
// --------------------------------------------------

const app = express();
const server = http.createServer(app);

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

authController.setDatabase(db);
nearpopController.setDatabase(db);
chatController.setDatabase(db);
notificationController.setDatabase(db);
notificationService.setDatabase(db);

// --------------------------------------------------
// AUTOMATIC POP EXPIRY JOB
// --------------------------------------------------

const POP_EXPIRY_INTERVAL = 30 * 1000;

function expireOldPops() {
  const sql = `
    UPDATE pops
    SET status = 'EXPIRED'
    WHERE status = 'ACTIVE'
      AND expires_at <= NOW()
  `;

  db.query(sql, [], (error, result) => {
    if (error) {
      console.error("POP expiry job error:", error);
      return;
    }

    if (result.affectedRows > 0) {
      console.log(
        "[" + new Date().toISOString() + "] Expired POPs:",
        result.affectedRows,
      );
    }
  });
}

// --------------------------------------------------
// IMAGE UPLOAD DIRECTORIES
// --------------------------------------------------

const uploadsRootDirectory = path.join(__dirname, "uploads");

const chatUploadDirectory = path.join(uploadsRootDirectory, "chat-images");

const popUploadDirectory = path.join(uploadsRootDirectory, "pop-images");

fs.mkdirSync(chatUploadDirectory, { recursive: true });
fs.mkdirSync(popUploadDirectory, { recursive: true });

console.log("Upload directories initialized.");

// --------------------------------------------------
// SUPPORTED IMAGE FORMATS
// --------------------------------------------------

const allowedMimeTypes = [
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
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

// --------------------------------------------------
// IMAGE FILE FILTER
// --------------------------------------------------

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

  // Accept if either the MIME type or extension is recognized.
  if (validMimeType || validExtension) {
    return callback(null, true);
  }

  console.error("REJECTED IMAGE:", {
    originalname: file.originalname,
    mimetype: file.mimetype,
    extension: extension,
  });

  return callback(
    new Error(
      "Unsupported image format. Supported formats: JPG, JPEG, PNG, WEBP, GIF, HEIC and HEIF.",
    ),
  );
};

// --------------------------------------------------
// IMAGE FILENAME GENERATOR
// --------------------------------------------------

const createImageFilename = (file) => {
  let extension = path.extname(file.originalname || "").toLowerCase();

  if (!extension) {
    const mimeExtensions = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/pjpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/heic": ".heic",
      "image/heif": ".heif",
      "image/heic-sequence": ".heic",
      "image/heif-sequence": ".heif",
    };

    extension = mimeExtensions[(file.mimetype || "").toLowerCase()] || ".jpg";
  }

  return Date.now() + "-" + crypto.randomBytes(8).toString("hex") + extension;
};

// --------------------------------------------------
// CHAT IMAGE STORAGE
// --------------------------------------------------

const chatStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, chatUploadDirectory);
  },

  filename: (req, file, callback) => {
    callback(null, createImageFilename(file));
  },
});

// --------------------------------------------------
// POP IMAGE STORAGE
// --------------------------------------------------

const popStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, popUploadDirectory);
  },

  filename: (req, file, callback) => {
    callback(null, createImageFilename(file));
  },
});

// --------------------------------------------------
// CHAT IMAGE UPLOAD MIDDLEWARE
// --------------------------------------------------

const upload = multer({
  storage: chatStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

// --------------------------------------------------
// POP IMAGE UPLOAD MIDDLEWARE
// --------------------------------------------------

const popUpload = multer({
  storage: popStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 3,
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

chatController.setSocketServer(io);

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

// Serve uploaded chat and POP images.
app.use("/uploads", express.static(uploadsRootDirectory));

// --------------------------------------------------
// AUTH ROUTES
// --------------------------------------------------

app.post("/api/auth/google", authController.googleLogin);

app.get("/api/auth/me", verifyToken, authController.getCurrentUser);

// --------------------------------------------------
// POP ROUTES
// --------------------------------------------------

// Create POP with maximum 3 optional images.
app.post(
  "/api/pops",
  verifyToken,
  popUpload.array("images", 3),
  nearpopController.createPop,
);

// Nearby POPs.
app.get("/api/pops/nearby", verifyToken, nearpopController.getNearbyPops);

// My POPs.
app.get("/api/pops/my", verifyToken, nearpopController.getMyPops);

// POP details.
app.get("/api/pops/:id", verifyToken, nearpopController.getPopDetails);

// Join POP chat.
app.post("/api/pops/:id/join", verifyToken, chatController.joinPopChat);

// Close POP.
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
// NOTIFICATION ROUTES
// --------------------------------------------------

app.post(
  "/api/notifications/register-token",
  verifyToken,
  notificationController.registerToken,
);

app.post(
  "/api/notifications/remove-token",
  verifyToken,
  notificationController.removeToken,
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
    message: "POPCHAAT API is running.",

    socket: "enabled",
    image_upload: "enabled",
    notifications: "enabled",
    pop_expiry: "enabled",

    pop_expiry_interval: "30 seconds",

    image_upload_configuration: {
      chat_images: {
        directory: "uploads/chat-images",
        field_name: "image",
        maximum_files: 1,
        maximum_size: "10 MB",
      },

      pop_images: {
        directory: "uploads/pop-images",
        field_name: "images",
        maximum_files: 3,
        maximum_size: "10 MB per image",
      },
    },

    supported_image_formats: [
      "JPG",
      "JPEG",
      "PNG",
      "WEBP",
      "GIF",
      "HEIC",
      "HEIF",
    ],
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

app.use(async (error, req, res, next) => {
  console.error("Server error:", error);

  // Remove uploaded files if upload or later middleware fails.
  const filesToDelete = [];

  if (req.file && req.file.path) {
    filesToDelete.push(req.file.path);
  }

  if (Array.isArray(req.files)) {
    req.files.forEach((file) => {
      if (file && file.path) {
        filesToDelete.push(file.path);
      }
    });
  }

  await Promise.all(
    filesToDelete.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") {
          console.error("Unable to remove uploaded file:", unlinkError);
        }
      }
    }),
  );

  // Multer errors.
  if (error instanceof multer.MulterError) {
    let message = error.message;

    if (error.code === "LIMIT_FILE_SIZE") {
      message = "Image size cannot exceed 10 MB per image.";
    } else if (error.code === "LIMIT_FILE_COUNT") {
      message = "You can upload a maximum of 3 POP images.";
    } else if (error.code === "LIMIT_UNEXPECTED_FILE") {
      message = "Unexpected image field. Use images for POP uploads.";
    }

    return res.status(400).json({
      success: false,
      message: message,
    });
  }

  // Unsupported image format.
  if (error.message && error.message.startsWith("Unsupported image")) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 6000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("POPCHAAT API running on port " + PORT);
  console.log("Socket.IO server running.");

  console.log("Chat image uploads enabled.");
  console.log("Chat image directory:", chatUploadDirectory);

  console.log("POP image uploads enabled.");
  console.log("POP image directory:", popUploadDirectory);

  console.log("Maximum POP images: 3");
  console.log("Maximum image size: 10 MB per image");

  console.log("Supported image formats:", allowedExtensions.join(", "));

  console.log("Notification routes enabled.");

  // Expire existing POPs immediately.
  expireOldPops();

  // Check for expired POPs every 30 seconds.
  setInterval(expireOldPops, POP_EXPIRY_INTERVAL);

  console.log("Automatic POP expiry job enabled.");
  console.log("POP expiry check interval: 30 seconds.");
});
