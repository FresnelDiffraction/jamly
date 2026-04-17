module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.AI_API_KEY || "";
  const model = process.env.AI_TRANSCRIPTION_MODEL || process.env.AI_MODEL || "gpt-5.4-mini";

  if (!baseUrl || !apiKey) {
    res.status(500).send("Missing AI_BASE_URL or AI_API_KEY");
    return;
  }

  const audioBase64 = String(req.body?.audioBase64 || "");
  const mimeType = String(req.body?.mimeType || "audio/webm");
  if (!audioBase64) {
    res.status(400).send("Missing audioBase64");
    return;
  }

  try {
    const transcription = await transcribeWithFallback({
      baseUrl,
      apiKey,
      model,
      audioBase64,
      mimeType
    });

    res.status(200).json({ text: transcription });
  } catch (error) {
    res.status(500).send(error.message || "Transcription failed");
  }
};

async function transcribeWithFallback({ baseUrl, apiKey, model, audioBase64, mimeType }) {
  const directResult = await tryDirectTranscription({
    baseUrl,
    apiKey,
    model,
    audioBase64,
    mimeType
  });

  if (directResult.ok) {
    return directResult.text;
  }

  if (!shouldFallbackToResponses(directResult.status, directResult.message)) {
    throw new Error(directResult.message || "Transcription request failed");
  }

  return await transcribeViaResponses({
    baseUrl,
    apiKey,
    model,
    audioBase64,
    mimeType
  });
}

async function tryDirectTranscription({ baseUrl, apiKey, model, audioBase64, mimeType }) {
  const buffer = Buffer.from(audioBase64, "base64");
  const extension = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "webm";
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), `jamly-recording.${extension}`);
  formData.append("model", model);
  formData.append("language", "zh");
  formData.append("temperature", "0");

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const message = await response.text();
    return {
      ok: false,
      status: response.status,
      message: message || "Transcription request failed"
    };
  }

  const data = await response.json();
  return {
    ok: true,
    text: String(data.text || "").trim()
  };
}

async function transcribeViaResponses({ baseUrl, apiKey, model, audioBase64, mimeType }) {
  const format = inferAudioFormat(mimeType);
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
          content: [
            {
              type: "input_text",
              text: "Transcribe the user's audio into simplified Chinese text. Return only the transcript."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format
              }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Responses transcription failed");
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) {
    throw new Error("Responses transcription returned empty text");
  }

  return text;
}

function shouldFallbackToResponses(status, message) {
  if (status === 404 || status === 405 || status === 501) {
    return true;
  }

  const normalized = String(message || "").toLowerCase();
  return normalized.includes("page not found")
    || normalized.includes("not found")
    || normalized.includes("unsupported")
    || normalized.includes("unknown path");
}

function inferAudioFormat(mimeType) {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return "m4a";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }
  return "webm";
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

  return chunks.join("\n").trim();
}
