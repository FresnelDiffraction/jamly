const express = require("express");
const multer = require("multer");
const path = require("path");

const parseHandler = require("./api/parse");
const stateHandler = require("./api/state");
const tabsHandler = require("./api/tabs");
const transcribeHandler = require("./api/transcribe");

const app = express();
const port = Number(process.env.PORT || 3000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.all("/api/parse", (req, res) => parseHandler(req, res));
app.all("/api/state", (req, res) => stateHandler(req, res));
app.get("/api/tabs", (req, res) => tabsHandler(req, res));
app.post("/api/tabs", upload.array("files", 50), (req, res) => tabsHandler(req, res));
app.delete("/api/tabs", (req, res) => tabsHandler(req, res));
app.all("/api/transcribe", (req, res) => transcribeHandler(req, res));

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Jamly listening on http://127.0.0.1:${port}`);
});
