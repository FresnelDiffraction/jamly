const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"];
const OPEN_HOURS = Array.from({ length: 13 }, (_, index) => index + 10);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.AI_API_KEY || "";
  const model = process.env.AI_MODEL || "gpt-5.4";

  if (!baseUrl || !apiKey) {
    res.status(500).send("Missing AI_BASE_URL or AI_API_KEY");
    return;
  }

  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).send("Missing text");
    return;
  }

  const currentDraft = normalizeDraft(req.body?.currentDraft || createEmptyDraft());
  const recentMessages = Array.isArray(req.body?.recentMessages)
    ? req.body.recentMessages.slice(-6).map((item) => ({
      role: item?.role === "bot" ? "bot" : "user",
      text: String(item?.text || "")
    }))
    : [];

  const schema = {
    name: "jamly_stateful_parse",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          enum: ["overwrite", "patch", "confirm", "clarify"]
        },
        normalized_text: {
          type: "string"
        },
        mode: {
          type: "string",
          enum: ["unknown", "whole_week_with_exceptions", "explicit_slots_only"]
        },
        available: buildDayMapSchema(),
        unavailable: buildDayMapSchema(),
        uncertain: buildDayMapSchema(),
        needs_confirmation: {
          type: "boolean"
        },
        clarification_question: {
          type: "string"
        }
      },
      required: [
        "intent",
        "normalized_text",
        "mode",
        "available",
        "unavailable",
        "uncertain",
        "needs_confirmation",
        "clarification_question"
      ]
    },
    strict: true
  };

  const systemPrompt = `
You are Jamly's Chinese band rehearsal availability parser.
Your job is to update ONE member's weekly draft state, not to parse a message in isolation.

The rehearsal room only accepts hours 10:00-23:00. Output hours 10-22 as one-hour slot starts.

You will receive:
1. current_draft: the member's current weekly draft state
2. recent_messages: recent conversation snippets for this member
3. new_message: the latest user message

Return the FULL NEXT DRAFT after applying the new message to the current draft.

State semantics:
- mode = "whole_week_with_exceptions":
  default assumption is the member is available for the whole week, then remove unavailable blocks and mark uncertain blocks separately.
- mode = "explicit_slots_only":
  only the hours listed in available are definitely available.
- mode = "unknown":
  you still cannot safely infer the member's full default rule.

Important behavior:
- Distinguish intent:
  - overwrite: the user restated the schedule from scratch
  - patch: the user is supplementing or correcting the existing draft
  - confirm: the user confirms the previous understanding
  - clarify: the user answers a narrow clarification question
- Phrases like "其他时间都可以", "没说的时间都可以", "除此之外都可以", "别的时候都行" usually mean mode should become "whole_week_with_exceptions".
- Mentions of events or commitments (上课, 开会, 看live, 吃饭, 有事, 小组会, 大组会, 排练, 医生, 加班, 约了朋友) mean that period is NOT available unless the user explicitly says otherwise.
- Words like "可能", "看情况", "大概", "也许", "不确定", "随时可能" should usually become UNCERTAIN, not definitely unavailable.
- "周五晚上" defaults to hours 18-22.
- "下午2点到4点" means 14 and 15. "晚上7点到10点" means 19, 20, 21.
- Never expand a local exclusion into a whole day.
- Never drop previously known constraints when the user is clearly patching the existing draft.
- If the user says "我没说的其他时间都可以", preserve earlier exceptions from current_draft and only update the default assumption.
- If the user is correcting a previous misunderstanding ("不是，我说的是..."), update only the corrected parts and preserve unrelated previously known parts.

Clarification policy:
- Do NOT say "I didn't understand" if most of the message is understandable.
- If only one key thing is missing, preserve everything else and ask one narrow clarification question.
- Set needs_confirmation=true only when there is a real unresolved ambiguity.

Output requirements:
- Return only JSON matching the schema.
- available/unavailable/uncertain must represent the FULL NEXT DRAFT after applying the new message.
`.trim();

  const userPayload = JSON.stringify({
    current_draft: currentDraft,
    recent_messages: recentMessages,
    new_message: text
  });

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPayload }]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            ...schema
          }
        }
      })
    });

    if (!response.ok) {
      const message = await response.text();
      res.status(response.status).send(message || "AI parse request failed");
      return;
    }

    const data = await response.json();
    const content = extractResponseText(data);
    const parsed = JSON.parse(content);
    const draft = normalizeDraft({
      mode: parsed.mode,
      normalizedText: parsed.normalized_text,
      available: parsed.available,
      unavailable: parsed.unavailable,
      uncertain: parsed.uncertain,
      lastIntent: parsed.intent,
      needsConfirmation: Boolean(parsed.needs_confirmation),
      clarificationQuestion: String(parsed.clarification_question || "")
    });

    const availableSlots = computeAvailableSlots(draft);
    const uncertainSlots = dayMapToSlots(draft.uncertain);

    res.status(200).json({
      intent: draft.lastIntent,
      draft,
      availableSlots,
      uncertainSlots,
      summary: buildSummaryFromSlots(availableSlots),
      uncertainSummary: buildSummaryFromSlots(uncertainSlots),
      needsConfirmation: draft.needsConfirmation,
      clarificationQuestion: draft.clarificationQuestion
    });
  } catch (error) {
    res.status(500).send(error.message || "AI parse failed");
  }
};

function buildDayMapSchema() {
  const properties = {};
  DAY_KEYS.forEach((day) => {
    properties[day] = {
      type: "array",
      items: {
        type: "integer",
        minimum: 10,
        maximum: 22
      }
    };
  });

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: DAY_KEYS
  };
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  (data.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (content.text) {
        chunks.push(content.text);
      }
    });
  });

  if (!chunks.length) {
    throw new Error("No response text returned");
  }

  return chunks.join("\n").trim();
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

function dayMapToSlots(dayMap) {
  const slots = [];

  DAY_KEYS.forEach((day) => {
    sanitizeHours(dayMap?.[day]).forEach((hour) => {
      slots.push(`${day}-${hour}`);
    });
  });

  return sanitizeSlots(slots);
}

function computeAvailableSlots(draft) {
  const available = new Set();
  const unavailable = new Set(dayMapToSlots(draft.unavailable));
  const uncertain = new Set(dayMapToSlots(draft.uncertain));

  if (draft.mode === "whole_week_with_exceptions") {
    for (let day = 0; day <= 6; day += 1) {
      OPEN_HOURS.forEach((hour) => {
        const slot = `${day}-${hour}`;
        if (!unavailable.has(slot) && !uncertain.has(slot)) {
          available.add(slot);
        }
      });
    }
  } else {
    dayMapToSlots(draft.available).forEach((slot) => {
      if (!unavailable.has(slot) && !uncertain.has(slot)) {
        available.add(slot);
      }
    });
  }

  return sanitizeSlots(Array.from(available));
}

function buildSummaryFromSlots(slots) {
  if (!slots.length) {
    return "";
  }

  const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const grouped = new Map();

  slots.forEach((slot) => {
    const [day, hour] = slot.split("-").map(Number);
    if (!grouped.has(day)) {
      grouped.set(day, []);
    }
    grouped.get(day).push(hour);
  });

  return Array.from(grouped.entries()).map(([day, hours]) => {
    const sorted = sanitizeHours(hours);
    const ranges = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let index = 1; index < sorted.length; index += 1) {
      const hour = sorted[index];
      if (hour === end + 1) {
        end = hour;
      } else {
        ranges.push(formatRange(start, end));
        start = hour;
        end = hour;
      }
    }

    ranges.push(formatRange(start, end));
    return `${dayNames[day]} ${ranges.join(",")}`;
  }).join("；");
}

function formatRange(start, end) {
  return `${padHour(start)}~${padHour(end + 1)}`;
}

function padHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}
