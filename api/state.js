const STATE_KEY = process.env.JAMLY_STATE_KEY || "jamly:shared-state";

module.exports = async function handler(req, res) {
  const kv = getKvConfig();
  if (!kv) {
    res.status(503).send("Missing KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN");
    return;
  }

  try {
    if (req.method === "GET") {
      const current = await getState(kv);
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
    const current = (await getState(kv)) || createEmptyState();
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
    } else if (action === "reset") {
      next = createEmptyState();
    } else if (action === "replaceState") {
      next = normalizeState(body.state || createEmptyState());
    } else {
      res.status(400).send("Unknown action");
      return;
    }

    next.updatedAt = Date.now();
    await setState(kv, next);
    res.status(200).json(next);
  } catch (error) {
    res.status(500).send(error.message || "Shared state request failed");
  }
};

function getKvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  if (!url || !token) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token
  };
}

async function getState(kv) {
  const response = await fetch(`${kv.url}/get/${encodeURIComponent(STATE_KEY)}`, {
    headers: {
      Authorization: `Bearer ${kv.token}`
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

async function setState(kv, state) {
  const encoded = encodeURIComponent(JSON.stringify(state));
  const response = await fetch(`${kv.url}/set/${encodeURIComponent(STATE_KEY)}/${encoded}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`
    }
  });

  if (!response.ok) {
    throw new Error(await response.text() || "KV set failed");
  }
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
