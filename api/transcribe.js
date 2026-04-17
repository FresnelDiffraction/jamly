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
      res.status(response.status).send(message || "Transcription request failed");
      return;
    }

    const data = await response.json();
    res.status(200).json({ text: String(data.text || "").trim() });
  } catch (error) {
    res.status(500).send(error.message || "Transcription failed");
  }
};
