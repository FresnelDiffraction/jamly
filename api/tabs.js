const fs = require("fs/promises");
const path = require("path");

const TABS_ROOT = path.join(process.cwd(), "tabs");
const META_FILE = path.join(TABS_ROOT, ".jamly-tabs-meta.json");

module.exports = async function handler(req, res) {
  try {
    await fs.mkdir(TABS_ROOT, { recursive: true });

    if (req.method === "GET") {
      const song = String(req.query?.song || "").trim();
      if (!song) {
        const songs = await listSongs();
        res.status(200).json({ songs });
        return;
      }

      const files = await listSongFiles(song);
      res.status(200).json({ song: decodeURIComponent(song), files });
      return;
    }

    if (req.method === "POST") {
      const action = String(req.body?.action || "").trim();

      if (action === "createSong") {
        const songName = String(req.body?.songName || "").trim();
        const uploader = String(req.body?.uploader || "").trim();
        if (!songName) {
          res.status(400).send("Missing songName");
          return;
        }

        const songPath = resolveSongPath(songName);
        await fs.mkdir(songPath, { recursive: true });
        const metadata = await readMeta();
        metadata.songs[songName] = metadata.songs[songName] || {
          createdBy: uploader || "未知成员",
          createdAt: new Date().toISOString(),
          files: {}
        };
        await writeMeta(metadata);
        res.status(200).json({ songs: await listSongs() });
        return;
      }

      if (action === "uploadFile") {
        const songName = String(req.body?.song || "").trim();
        const uploader = String(req.body?.uploader || "").trim();
        if (!songName || !req.file) {
          res.status(400).send("Missing song or file");
          return;
        }

        const songPath = resolveSongPath(songName);
        await fs.mkdir(songPath, { recursive: true });
        const safeName = sanitizeFileName(req.file.originalname);
        const targetPath = path.join(songPath, safeName);
        await fs.writeFile(targetPath, req.file.buffer);

        const metadata = await readMeta();
        metadata.songs[songName] = metadata.songs[songName] || {
          createdBy: uploader || "未知成员",
          createdAt: new Date().toISOString(),
          files: {}
        };
        metadata.songs[songName].files[safeName] = {
          uploadedBy: uploader || "未知成员",
          uploadedAt: new Date().toISOString()
        };
        await writeMeta(metadata);

        res.status(200).json({ song: songName, files: await listSongFiles(songName) });
        return;
      }

      res.status(400).send("Unknown tabs action");
      return;
    }

    if (req.method === "DELETE") {
      const song = String(req.query?.song || "").trim();
      const file = String(req.query?.file || "").trim();
      if (!song || !file) {
        res.status(400).send("Missing song or file");
        return;
      }

      const songPath = resolveSongPath(song);
      const fileName = decodeURIComponent(file);
      const filePath = path.resolve(songPath, fileName);
      if (!filePath.startsWith(songPath + path.sep) && filePath !== path.join(songPath, fileName)) {
        res.status(400).send("Invalid file path");
        return;
      }

      await fs.unlink(filePath);
      const metadata = await readMeta();
      const songName = decodeURIComponent(song);
      if (metadata.songs[songName]?.files) {
        delete metadata.songs[songName].files[fileName];
      }
      await writeMeta(metadata);

      res.status(200).json({ song: songName, files: await listSongFiles(songName) });
      return;
    }

    res.status(405).send("Method Not Allowed");
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).send("Not Found");
      return;
    }
    res.status(500).send(error.message || "Tabs request failed");
  }
};

async function listSongs() {
  const metadata = await readMeta();
  const entries = await fs.readdir(TABS_ROOT, { withFileTypes: true });
  const songs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const meta = metadata.songs[entry.name] || {};
      const songPath = resolveSongPath(entry.name);
      const fileEntries = await fs.readdir(songPath, { withFileTypes: true });
      return {
        name: entry.name,
        slug: encodeURIComponent(entry.name),
        createdBy: meta.createdBy || "",
        createdAt: meta.createdAt || "",
        fileCount: fileEntries.filter((file) => file.isFile()).length
      };
    }));

  return songs.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

async function listSongFiles(song) {
  const songName = decodeURIComponent(song);
  const songPath = resolveSongPath(songName);
  const metadata = await readMeta();
  const entries = await fs.readdir(songPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fileMeta = metadata.songs[songName]?.files?.[entry.name] || {};
      return {
        name: entry.name,
        href: `/tabs/${encodeURIComponent(songName)}/${encodeURIComponent(entry.name)}`,
        uploadedBy: fileMeta.uploadedBy || "",
        uploadedAt: fileMeta.uploadedAt || ""
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

async function readMeta() {
  try {
    const content = await fs.readFile(META_FILE, "utf8");
    const parsed = JSON.parse(content);
    return {
      songs: parsed?.songs && typeof parsed.songs === "object" ? parsed.songs : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { songs: {} };
    }
    throw error;
  }
}

async function writeMeta(metadata) {
  await fs.writeFile(META_FILE, JSON.stringify(metadata, null, 2), "utf8");
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

function sanitizeFileName(fileName) {
  return String(fileName || "file")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}
