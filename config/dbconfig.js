const mysql = require("mysql");
require("dotenv").config();

const connection = mysql.createConnection({
  host: process.env.db_host,
  user: process.env.db_user,
  password: process.env.db_password,
  database: process.env.db_name,
  port: process.env.db_port,

  // Important: support 4-byte Unicode characters (emojis)
  charset: "utf8mb4",
});

connection.connect((err) => {
  if (err) {
    console.log("Error in connecting to database:", err);
    return;
  }

  console.log("Connected to MySQL with utf8mb4 support");
});

module.exports = connection;
