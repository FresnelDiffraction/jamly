const fs = require("fs/promises");
const path = require("path");

const TABS_ROOT = path.join(process.cwd(), "tabs");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const song = String(req.query?.song || "").trim();
    if (!song) {
      const songs = await listSongs();
      res.status(200).json({ songs });
      return;
    }

    const files = await listSongFiles(song);
    res.status(200).json({ song, files });
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).send("Not Found");
      return;
    }
    res.status(500).send(error.message || "Tabs request failed");
  }
};

async function listSongs() {
  const entries = await fs.readdir(TABS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      slug: encodeURIComponent(entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

async function listSongFiles(song) {
  const songPath = resolveSongPath(song);
  const entries = await fs.readdir(songPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      href: `/tabs/${encodeURIComponent(decodeURIComponent(song))}/${encodeURIComponent(entry.name)}`
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function resolveSongPath(song) {
  const decodedSong = decodeURIComponent(song);
  const rootPath = path.resolve(TABS_ROOT);
  const songPath = path.resolve(rootPath, decodedSong);
  if (!songPath.startsWith(rootPath)) {
    const error = new Error("Invalid song path");
    error.code = "EINVAL";
    throw error;
  }
  return songPath;
}
