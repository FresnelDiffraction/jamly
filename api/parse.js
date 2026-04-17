module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.AI_API_KEY || "";
  const model = "gpt-5.4";

  if (!baseUrl || !apiKey) {
    res.status(500).send("Missing AI_BASE_URL or AI_API_KEY");
    return;
  }

  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).send("Missing text");
    return;
  }

  const schema = {
    name: "availability_parse",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        "0": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "1": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "2": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "3": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "4": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "5": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        },
        "6": {
          type: "array",
          items: {
            type: "integer",
            minimum: 10,
            maximum: 22
          }
        }
      },
      required: ["0", "1", "2", "3", "4", "5", "6"]
    },
    strict: true
  };

  const systemPrompt = `
You are a Chinese band rehearsal availability parser.
Goal: Convert natural language into a structured availability JSON.

## 1. Time Definitions
- Opening Hours: 10:00 - 23:00 daily.
- Standard Blocks: Morning(10-12), Noon(12-14), Afternoon(14-18), Evening(18-23).
- Full Day/随时: 10:00-23:00.

## 2. Universal Activity Generalization (NEW)
Apply the following heuristic to handle any irregular user input:
- CATEGORY A (Explicit Availability): Phrases like "有空", "可以", "随时", "没问题", "OK".
- CATEGORY B (Activity Occupancy): Any mention of specific actions, hobbies, or events (e.g., 健身, 攀岩, 遛狗, 看医生, 搬家, 练琴, 甚至 "有事").
- LOGIC: Treat ALL Category B mentions as UNAVAILABLE (Exclusion) for that period, UNLESS the user explicitly attaches a Category A suffix to it (e.g., "攀岩完有空" means available AFTER the activity).

## 3. Logical Execution Protocol (Step-by-Step)
You MUST process the input in this mental order:

1. Establish Base:
   - If the user implies broad availability (e.g., "除了...", "其他时间...", "这周都可以"), set Base = Mon-Sun 10:00-23:00.
   - Otherwise, set Base = Only the specific times mentioned as "Available".

2. Extract Exclusions (The "Occupancy" Filter):
   - Scan for any specific activities (hobbies, chores, work, social) or negative markers ("不行", "没空").
   - Map these to specific hours based on the time descriptors (e.g., "周六下午去攀岩" -> Sat 14:00-18:00 is UNAVAILABLE).
   - If the user gives an exact clock range such as "两点到四点有课", "下午2点到4点开会", exclude ONLY that range, not the whole morning/afternoon/day.
   - If the user says an activity happens at one specific period inside a day, keep the rest of that day available when the base scope already includes that day.

3. Compute Intersection:
   - Result = Base Scope - Exclusion Scope.
   - If a user provides a range (e.g., "周一到周五"), and then mentions an exclusion ("周三要健身"), ensure Wednesday is modified while others remain full.
   - Never remove an entire day unless the user clearly says the whole day is unavailable.

## 4. Complex Semantic Handling
- The "Flip" Logic: "X以前不行" = Available from X to 23:00; "X以后不行" = Available from 10:00 to X.
- The "Except" Logic: "除了[时间/活动], 都可以" -> Base is 100%, then subtract the [时间/活动].
- Range Logic: "周二到周日晚上六点后" refers to the evening block for EACH day in that range.
- Clock Logic: "周一两点到四点有课" means Monday 14:00-16:00 unavailable; if the sentence also implies broad availability, Monday hours outside 14:00-16:00 remain available.
- Chinese colloquial time logic: "下午两点到四点" = 14-16, "晚上八点后" = 20-23, "中午十二点到两点" = 12-14.

## 5. Examples
- "我这周都可以，周一两点到四点有课" -> Base is full week; exclude only Monday 14:00 and 15:00.
- "我周五约了朋友吃饭就不晚上不行然后周一一两点到四点有课也不行" -> Base is full week; exclude Friday evening and Monday 14:00-16:00 only.
- "周二到周日晚上六点后都可以，周一晚上八点后可以，周四周五的下午不行" -> Tue-Sun include 18-23, Monday include 20-23, then remove Thu/Fri 14-18 if present in base.

## 6. Output
Return ONLY a valid JSON object.
- Keys must be "0" through "6" where Monday="0" and Sunday="6".
- Values must be arrays of integer start hours between 10 and 22.
- Do not return prose, markdown, or extra keys.
`.trim();

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
            content: [{ type: "input_text", text }]
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
    const availableSlots = dayMapToSlots(parsed);

    res.status(200).json({
      summary: buildSummaryFromSlots(availableSlots),
      availableSlots
    });
  } catch (error) {
    res.status(500).send(error.message || "AI parse failed");
  }
};

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

function sanitizeSlots(slots) {
  return Array.from(new Set((slots || []).filter((slot) => {
    const [day, hour] = String(slot).split("-").map(Number);
    return Number.isInteger(day) && Number.isInteger(hour) && day >= 0 && day <= 6 && hour >= 10 && hour <= 22;
  }))).sort((a, b) => {
    const [dayA, hourA] = a.split("-").map(Number);
    const [dayB, hourB] = b.split("-").map(Number);
    return (dayA - dayB) || (hourA - hourB);
  });
}

function dayMapToSlots(dayMap) {
  const slots = [];

  for (let day = 0; day <= 6; day += 1) {
    const hours = Array.isArray(dayMap?.[String(day)]) ? dayMap[String(day)] : [];
    hours.forEach((hour) => {
      if (Number.isInteger(hour) && hour >= 10 && hour <= 22) {
        slots.push(`${day}-${hour}`);
      }
    });
  }

  return sanitizeSlots(slots);
}

function buildSummaryFromSlots(slots) {
  if (!slots.length) {
    return "暂时没有识别到明确可用时间。";
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
    const sorted = Array.from(new Set(hours)).sort((a, b) => a - b);
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
