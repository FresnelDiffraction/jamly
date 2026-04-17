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
        normalized_text: {
          type: "string"
        },
        base_mode: {
          type: "string",
          enum: ["full_week", "mentioned_only"]
        },
        availability: {
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
        }
      },
      required: ["normalized_text", "base_mode", "availability"]
    },
    strict: true
  };

  const systemPrompt = `
你是一个中文乐队排练时间解析器。
你的任务不是随便猜，而是先理解句意，再输出最终可用时间。

## 目标
把用户一句非常口语、非常随意、甚至可能带语音转写错误的话，解析成：
1. normalized_text：你理解后的标准中文表达
2. base_mode：
   - "full_week"：用户表达的是“默认整周都可以，只排除少数不行时间”
   - "mentioned_only"：用户只明确说了某些可用时间，没有表达“其他时间也可以”
3. availability：最终可用小时块，Monday="0" 到 Sunday="6"

## 硬规则
- 排练房开放时间只有每天 10:00-23:00，所以只允许输出 10-22 这些起始小时。
- “一个具体的不行时间段”只能排除那一段，绝不能因此排除一整天。
- 如果用户说“其他时间都可以 / 其他时候都可以 / 其余时间OK / 除了X都可以”，base_mode 必须是 "full_week"。
- 如果用户提到活动、约会、上课、加班、吃饭、有事、开会、看医生、健身、攀岩等，默认它代表那个时间段“不可以”。
- 如果一句话同时有“整体都可以”和“局部不行”，你必须先建立整周可用，再减去这些局部不行。

## 中文时间语义
- “下午2点到5点” = 14,15,16 不可用
- “晚上7点到10点” = 19,20,21 不可用
- “早上10点到12点” = 10,11 不可用
- “中午12点到2点” = 12,13
- “晚上8点后” = 20,21,22
- “周五晚上” 默认指 18,19,20,21,22
- “周末” = 周六和周日
- “周一到周五” = 每一天分别处理，不能混成一个整体时间块

## 处理顺序
1. 先把口语恢复成正常句意，写入 normalized_text。
2. 判断 base_mode。
3. 把每个子句拆开，分别识别日期、时间范围、可用/不可用。
4. 先建立 base，再逐条加减时间块。
5. 最后做一次自检：
   - 有没有把局部不行误扩成整天不行？
   - 有没有把“不行”误当成“可以”？
   - 有没有把“周X到周Y”错误混到别的天？

## 关键例子
- “周一下午2点到5点有课，其他时间都可以”
  => full_week；只排除周一 14,15,16
- “周二晚上7点到10点有课，其他时间都可以”
  => full_week；只排除周二 19,20,21
- “周五晚上约了朋友吃饭，其他时间都可以”
  => full_week；只排除周五 18,19,20,21,22
- “周六下午2点到4点不行，其他时间都可以”
  => full_week；只排除周六 14,15
- “周一下午2点到4点有课周二晚上7点到10点有课周三早上10点到12点有课然后其他时间都是可以的”
  => full_week；三段局部排除分别作用在三天上

## 输出要求
- 只返回 JSON，不要解释，不要 markdown。
- availability 必须是最终可用时间，不是不可用时间。
- 如果句子有少量口误或语音转写错误，按最合理的日常表达理解，但不要发散猜测。
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
    const availableSlots = dayMapToSlots(parsed.availability);

    res.status(200).json({
      normalizedText: parsed.normalized_text,
      baseMode: parsed.base_mode,
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
