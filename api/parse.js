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
    name: "jamly_rule_parse",
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
        unavailable_rules: buildRulesSchema(),
        uncertain_rules: buildRulesSchema(),
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
        "unavailable_rules",
        "uncertain_rules",
        "needs_confirmation",
        "clarification_question"
      ]
    },
    strict: true
  };

  const systemPrompt = `
You are Jamly's Chinese rehearsal-time parser.
You do NOT output final hour slots directly.
You output a rule-based draft, then the app will deterministically expand those rules into one-hour blocks.

Hard product rule:
- Any time the user does NOT mention is AVAILABLE by default.
- Therefore the draft only needs two rule lists:
  1. unavailable_rules
  2. uncertain_rules

You receive:
1. current_draft: this member's current weekly draft state
2. recent_messages: the latest few messages for this member
3. new_message: the latest user message

Your task:
- Understand the latest message in context
- Decide whether it is overwrite / patch / confirm / clarify
- Return the FULL NEXT DRAFT rule lists after applying the latest message

Interpretation guidance:
- "其他时候都可以", "没说的时间都可以", "除此之外都可以", "别的时候都行" all reinforce the product default: unspecified time is available.
- Mentions of events or obligations (上课, 开会, 看live, 吃饭, 有事, 小组会, 大组会, 排练, 医生, 加班, 约了朋友) mean that period is unavailable unless clearly marked otherwise.
- "可能", "看情况", "也许", "不确定", "随时可能" should become uncertain_rules, not unavailable_rules.
- Preserve existing unrelated rules when the user is obviously patching or correcting.
- If the user says "不是，我说的是..." or similar, correct only the relevant earlier part.
- Do not say you failed to understand if most of the message is clear.
- Ask only one narrow clarification question when there is a real unresolved ambiguity.

Rule format requirements:
- Each rule has:
  - days: array of weekday strings "0" to "6" where Monday="0"
  - start: "HH:MM"
  - end: "HH:MM"
  - reason: short Chinese text
- Use exact clock times when the user gives them, including half hours such as 11:30.
- Expand day ranges like "周一到周五" into every affected day.
- "周五晚上" usually means 18:00-23:00.
- "下午2点到4点" means 14:00-16:00.
- "晚上7点到10点" means 19:00-22:00.
- Never convert a local exception into a whole-day exception.
- Never output availability rules. Unspecified time is already available.

Examples:
- "周一到周五10:00到11:30都不行，其他时候可以"
  => unavailable_rules with 5 separate affected days or one rule containing days ["0","1","2","3","4"], start "10:00", end "11:30"
- "周四下午随时可能有小组会"
  => uncertain rule for Thursday afternoon
- "我没说的其他时间都可以，我不是说周二晚上18:00之后不可以吗"
  => preserve earlier Tuesday evening unavailable rule, do not delete it

Return only JSON matching the schema.
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
      normalizedText: parsed.normalized_text,
      unavailableRules: parsed.unavailable_rules,
      uncertainRules: parsed.uncertain_rules,
      lastIntent: parsed.intent,
      needsConfirmation: Boolean(parsed.needs_confirmation),
      clarificationQuestion: String(parsed.clarification_question || "")
    });

    const unavailableSlots = expandRulesToSlots(draft.unavailableRules);
    const uncertainSlots = subtractSlots(
      expandRulesToSlots(draft.uncertainRules),
      unavailableSlots
    );
    const availableSlots = subtractSlots(buildAllWeekSlots(), [...unavailableSlots, ...uncertainSlots]);

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

function buildRulesSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: {
          type: "array",
          items: {
            type: "string",
            enum: DAY_KEYS
          }
        },
        start: {
          type: "string"
        },
        end: {
          type: "string"
        },
        reason: {
          type: "string"
        }
      },
      required: ["days", "start", "end", "reason"]
    }
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

function createEmptyDraft() {
  return {
    normalizedText: "",
    unavailableRules: [],
    uncertainRules: [],
    lastIntent: "overwrite",
    needsConfirmation: false,
    clarificationQuestion: ""
  };
}

function normalizeDraft(raw) {
  const base = createEmptyDraft();
  return {
    normalizedText: String(raw?.normalizedText || raw?.normalized_text || ""),
    unavailableRules: normalizeRules(raw?.unavailableRules || raw?.unavailable_rules || raw?.unavailable),
    uncertainRules: normalizeRules(raw?.uncertainRules || raw?.uncertain_rules || raw?.uncertain),
    lastIntent: ["overwrite", "patch", "confirm", "clarify"].includes(raw?.lastIntent || raw?.intent)
      ? (raw.lastIntent || raw.intent)
      : base.lastIntent,
    needsConfirmation: Boolean(raw?.needsConfirmation ?? raw?.needs_confirmation),
    clarificationQuestion: String(raw?.clarificationQuestion || raw?.clarification_question || "")
  };
}

function normalizeRules(input) {
  if (Array.isArray(input)) {
    return input
      .map((rule) => normalizeRule(rule))
      .filter(Boolean);
  }

  if (input && typeof input === "object") {
    return legacyDayMapToRules(input);
  }

  return [];
}

function normalizeRule(rule) {
  const days = Array.isArray(rule?.days)
    ? Array.from(new Set(rule.days.map((day) => String(day)).filter((day) => DAY_KEYS.includes(day)))).sort()
    : [];
  const start = normalizeTime(rule?.start);
  const end = normalizeTime(rule?.end);

  if (!days.length || !start || !end || toMinutes(end) <= toMinutes(start)) {
    return null;
  }

  return {
    days,
    start,
    end,
    reason: String(rule?.reason || "")
  };
}

function legacyDayMapToRules(dayMap) {
  const rules = [];
  DAY_KEYS.forEach((day) => {
    const hours = sanitizeHours(dayMap?.[day]);
    if (!hours.length) {
      return;
    }

    let start = hours[0];
    let previous = hours[0];
    for (let index = 1; index < hours.length; index += 1) {
      const hour = hours[index];
      if (hour === previous + 1) {
        previous = hour;
        continue;
      }

      rules.push({
        days: [day],
        start: formatHour(start),
        end: formatHour(previous + 1),
        reason: ""
      });
      start = hour;
      previous = hour;
    }

    rules.push({
      days: [day],
      start: formatHour(start),
      end: formatHour(previous + 1),
      reason: ""
    });
  });
  return rules;
}

function sanitizeHours(hours) {
  return Array.from(new Set((hours || []).filter((hour) => Number.isInteger(hour) && hour >= 10 && hour <= 22))).sort((a, b) => a - b);
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "";
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return "";
  }

  const clampedMinutes = Math.max(10 * 60, Math.min(23 * 60, hour * 60 + minute));
  const normalizedHour = Math.floor(clampedMinutes / 60);
  const normalizedMinute = clampedMinutes % 60;
  return `${String(normalizedHour).padStart(2, "0")}:${String(normalizedMinute).padStart(2, "0")}`;
}

function toMinutes(time) {
  const match = String(time || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return NaN;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function expandRulesToSlots(rules) {
  const slots = new Set();

  rules.forEach((rule) => {
    const startMinutes = toMinutes(rule.start);
    const endMinutes = toMinutes(rule.end);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      return;
    }

    rule.days.forEach((day) => {
      OPEN_HOURS.forEach((hour) => {
        const slotStart = hour * 60;
        const slotEnd = (hour + 1) * 60;
        if (startMinutes < slotEnd && endMinutes > slotStart) {
          slots.add(`${day}-${hour}`);
        }
      });
    });
  });

  return sanitizeSlots(Array.from(slots));
}

function buildAllWeekSlots() {
  const slots = [];
  for (let day = 0; day <= 6; day += 1) {
    OPEN_HOURS.forEach((hour) => {
      slots.push(`${day}-${hour}`);
    });
  }
  return slots;
}

function subtractSlots(base, excluded) {
  const excludedSet = new Set(excluded);
  return sanitizeSlots(base.filter((slot) => !excludedSet.has(slot)));
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
  return `${formatHour(start)}~${formatHour(end + 1)}`;
}
