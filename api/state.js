const fs = require("fs/promises");
const path = require("path");

const STATE_KEY = process.env.JAMLY_STATE_KEY || "jamly:shared-state";
const STATE_FILE = process.env.JAMLY_STATE_FILE || path.join(process.cwd(), ".jamly-state.json");

module.exports = async function handler(req, res) {
  const backend = getStorageBackend();

  try {
    if (req.method === "GET") {
      const current = await getState(backend);
      if (!current) {
        res.status(404).send("Shared state not initialized");
        return;
      }

      res.status(200).json(current);
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const body = req.body || {};
    const action = String(body.action || "").trim();
    const current = (await getState(backend)) || createEmptyState();
    let next = current;

    if (action === "setSubmission") {
      const member = String(body.member || "").trim();
      if (!member) {
        res.status(400).send("Missing member");
        return;
      }

      next = normalizeState({
        ...current,
        submissions: {
          ...current.submissions,
          [member]: body.submission || null
        },
        messages: [...current.messages, body.userMessage, body.botMessage]
      });
    } else if (action === "addTodo") {
      if (!body.todo) {
        res.status(400).send("Missing todo");
        return;
      }

      next = normalizeState({
        ...current,
        todos: [...current.todos, body.todo]
      });
    } else if (action === "clearMember") {
      const member = String(body.member || "").trim();
      if (!member) {
        res.status(400).send("Missing member");
        return;
      }

      const submissions = { ...current.submissions };
      delete submissions[member];

      next = normalizeState({
        ...current,
        submissions,
        messages: current.messages.filter((message) => message?.member !== member)
      });
    } else if (action === "reset") {
      next = createEmptyState();
    } else if (action === "replaceState") {
      next = normalizeState(body.state || createEmptyState());
    } else {
      res.status(400).send("Unknown action");
      return;
    }

    next.updatedAt = Date.now();
    await setState(backend, next);
    res.status(200).json(next);
  } catch (error) {
    res.status(500).send(error.message || "Shared state request failed");
  }
};

function getStorageBackend() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  if (url && token) {
    return {
      kind: "kv",
      url: url.replace(/\/+$/, ""),
      token
    };
  }

  return {
    kind: "file",
    file: STATE_FILE
  };
}

async function getState(backend) {
  if (backend.kind === "kv") {
    const response = await fetch(`${backend.url}/get/${encodeURIComponent(STATE_KEY)}`, {
      headers: {
        Authorization: `Bearer ${backend.token}`
      }
    });

    if (!response.ok) {
      throw new Error(await response.text() || "KV get failed");
    }

    const data = await response.json();
    if (!data.result) {
      return null;
    }

    return normalizeState(JSON.parse(data.result));
  }

  try {
    const content = await fs.readFile(backend.file, "utf8");
    return normalizeState(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function setState(backend, state) {
  if (backend.kind === "kv") {
    const encoded = encodeURIComponent(JSON.stringify(state));
    const response = await fetch(`${backend.url}/set/${encodeURIComponent(STATE_KEY)}/${encoded}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${backend.token}`
      }
    });

    if (!response.ok) {
      throw new Error(await response.text() || "KV set failed");
    }
    return null;
  }

  await fs.mkdir(path.dirname(backend.file), { recursive: true });
  await fs.writeFile(backend.file, JSON.stringify(state), "utf8");
}

function createEmptyState() {
  return {
    messages: [],
    submissions: {},
    todos: [],
    updatedAt: 0
  };
}

function normalizeState(raw) {
  const base = createEmptyState();
  return {
    messages: Array.isArray(raw?.messages) ? raw.messages.filter(Boolean) : base.messages,
    submissions: raw?.submissions && typeof raw.submissions === "object" ? raw.submissions : base.submissions,
    todos: Array.isArray(raw?.todos) ? raw.todos.filter(Boolean) : base.todos,
    updatedAt: Number(raw?.updatedAt || 0)
  };
}
