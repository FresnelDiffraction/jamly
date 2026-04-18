const fs = require("fs/promises");
const path = require("path");

const STATE_KEY = process.env.JAMLY_STATE_KEY || "jamly:shared-state";
const STATE_FILE = process.env.JAMLY_STATE_FILE || path.join(process.cwd(), ".jamly-state.json");
const MEMBERS = ["cold", "david", "圈", "星", "小安", "afai"];
const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"];

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
          [member]: normalizeSubmission(body.submission)
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
      throw new Error((await response.text()) || "KV get failed");
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
      throw new Error((await response.text()) || "KV set failed");
    }
    return;
  }

  await fs.mkdir(path.dirname(backend.file), { recursive: true });
  await fs.writeFile(backend.file, JSON.stringify(state), "utf8");
}

function createEmptyDayMap() {
  return DAY_KEYS.reduce((acc, day) => {
    acc[day] = [];
    return acc;
  }, {});
}

function sanitizeHours(hours) {
  return Array.from(new Set((hours || []).filter((hour) => Number.isInteger(hour) && hour >= 10 && hour <= 22))).sort((a, b) => a - b);
}

function normalizeDayMap(dayMap) {
  const next = createEmptyDayMap();
  DAY_KEYS.forEach((day) => {
    next[day] = sanitizeHours(dayMap?.[day]);
  });
  return next;
}

function createEmptyDraft() {
  return {
    mode: "unknown",
    normalizedText: "",
    available: createEmptyDayMap(),
    unavailable: createEmptyDayMap(),
    uncertain: createEmptyDayMap(),
    lastIntent: "overwrite",
    needsConfirmation: false,
    clarificationQuestion: ""
  };
}

function createWeekKey(date = new Date()) {
  const current = new Date(date);
  const weekday = current.getDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() + diff);
  return current.toISOString().slice(0, 10);
}

function createEmptyState() {
  return {
    weekKey: createWeekKey(),
    messages: [],
    submissions: {},
    todos: [],
    updatedAt: 0
  };
}

function normalizeDraft(raw) {
  const base = createEmptyDraft();
  return {
    mode: ["unknown", "whole_week_with_exceptions", "explicit_slots_only"].includes(raw?.mode) ? raw.mode : base.mode,
    normalizedText: String(raw?.normalizedText || raw?.normalized_text || ""),
    available: normalizeDayMap(raw?.available),
    unavailable: normalizeDayMap(raw?.unavailable),
    uncertain: normalizeDayMap(raw?.uncertain),
    lastIntent: ["overwrite", "patch", "confirm", "clarify"].includes(raw?.lastIntent || raw?.intent)
      ? (raw.lastIntent || raw.intent)
      : base.lastIntent,
    needsConfirmation: Boolean(raw?.needsConfirmation ?? raw?.needs_confirmation),
    clarificationQuestion: String(raw?.clarificationQuestion || raw?.clarification_question || "")
  };
}

function sanitizeSlots(slots) {
  return Array.from(new Set((slots || []).filter((slot) => {
    const [day, hour] = String(slot).split("-").map(Number);
    return Number.isInteger(day) && Number.isInteger(hour) && day >= 0 && day <= 6 && hour >= 10 && hour <= 22;
  }))).sort((left, right) => {
    const [leftDay, leftHour] = left.split("-").map(Number);
    const [rightDay, rightHour] = right.split("-").map(Number);
    return (leftDay - rightDay) || (leftHour - rightHour);
  });
}

function normalizeSubmission(submission) {
  if (!submission) {
    return null;
  }

  const availableSlots = sanitizeSlots(submission?.parsed?.availableSlots || []);
  const uncertainSlots = sanitizeSlots(submission?.parsed?.uncertainSlots || []);

  return {
    rawText: String(submission.rawText || ""),
    timestamp: String(submission.timestamp || ""),
    draft: normalizeDraft(submission.draft),
    parsed: {
      availableSlots,
      uncertainSlots,
      summary: String(submission?.parsed?.summary || ""),
      uncertainSummary: String(submission?.parsed?.uncertainSummary || ""),
      needsConfirmation: Boolean(submission?.parsed?.needsConfirmation),
      clarificationQuestion: String(submission?.parsed?.clarificationQuestion || "")
    }
  };
}

function normalizeState(raw) {
  const base = createEmptyState();
  return {
    weekKey: String(raw?.weekKey || base.weekKey),
    messages: Array.isArray(raw?.messages) ? raw.messages.filter(Boolean).map((message) => ({
      role: message?.role === "bot" ? "bot" : "user",
      member: MEMBERS.includes(message?.member) ? message.member : MEMBERS[0],
      text: String(message?.text || ""),
      timestamp: String(message?.timestamp || "")
    })) : [],
    submissions: MEMBERS.reduce((acc, member) => {
      const submission = normalizeSubmission(raw?.submissions?.[member]);
      if (submission) {
        acc[member] = submission;
      }
      return acc;
    }, {}),
    todos: Array.isArray(raw?.todos)
      ? raw.todos
        .filter(Boolean)
        .map((item) => ({
          id: String(item?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          time: String(item?.time || ""),
          text: String(item?.text || "")
        }))
        .filter((item) => item.time && item.text)
      : [],
    updatedAt: Number(raw?.updatedAt || 0)
  };
}
