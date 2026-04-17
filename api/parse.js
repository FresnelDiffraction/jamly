module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.AI_API_KEY || "";
  const model = process.env.AI_MODEL || "gpt-5.4-mini";

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
        summary: {
          type: "string",
          description: "Use one short Chinese sentence to summarize availability."
        },
        availableSlots: {
          type: "array",
          items: {
            type: "string",
            pattern: "^[0-6]-(1[0-9]|2[0-2])$"
          }
        }
      },
      required: ["summary", "availableSlots"]
    },
    strict: true
  };

  const systemPrompt = [
    "You are a Chinese band rehearsal availability parser.",
    "Convert the user's natural-language availability into one-hour availability slots.",
    "Week range is Monday to Sunday.",
    "Use Monday=0 through Sunday=6, hour 10-22 only.",
    "The rehearsal room is open from 10:00 to 23:00, so ignore any time outside that range.",
    "If the user says the whole week is available, return all open hours in the week.",
    "Understand ranges such as 周一到周五, 星期一至星期五, and 周末.",
    "If the user only mentions unavailable times, infer that all other open hours are available.",
    "If the user says 其他时候都可以 or similar, subtract the unavailable slots from the full week.",
    "Treat phrases like 约了朋友吃饭, 加班, 上班, 有课, 开会 as unavailable unless the user explicitly says they are available.",
    "If wording is ambiguous, make a conservative reasonable guess.",
    "Example: 周五晚上不可以其他时候都可以 => all open hours except Friday evening.",
    "Example: 周五晚上约了朋友吃饭然后周一到周五的早上都不行 => full week open except Friday evening and weekday mornings.",
    "Return only JSON matching the schema."
  ].join(" ");

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
    const availableSlots = sanitizeSlots(parsed.availableSlots || []);

    res.status(200).json({
      summary: parsed.summary,
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
