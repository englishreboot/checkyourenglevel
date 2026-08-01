// Netlify serverless function.
// 1) Transcribes the recorded audio using OpenAI Whisper (handles accents/speed far better than browser speech recognition).
// 2) Sends the transcript to Claude for a strict CEFR grammar check.
// Needs two environment variables set in Netlify: OPENAI_API_KEY and ANTHROPIC_API_KEY.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey) return { statusCode: 500, body: JSON.stringify({ error: "OPENAI_API_KEY is not set in Netlify environment variables" }) };
  if (!anthropicKey) return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables" }) };

  let audio, mimeType;
  try {
    ({ audio, mimeType } = JSON.parse(event.body));
    if (!audio) throw new Error("missing audio");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  try {
    // ---- 1. Transcribe with Whisper ----
    const audioBuffer = Buffer.from(audio, "base64");
    const ext = mimeType && mimeType.includes("mp4") ? "m4a" : "webm";

    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType || "audio/webm" }), `speech.${ext}`);
    form.append("model", "whisper-1");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body: form
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "Whisper transcription failed", details: errText }) };
    }
    const whisperData = await whisperRes.json();
    const transcript = (whisperData.text || "").trim();

    if (!transcript) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: "", level: "A0", note: "No speech detected in the recording.", corrections: [] })
      };
    }

    // ---- 2. Grade the transcript with Claude ----
    const prompt = `You are a meticulous, strict English examiner assessing a placement-test spoken transcript (produced by speech-to-text — it may contain minor transcription typos or missing punctuation; ignore those and filler words like "um", and focus on real grammar/vocabulary issues). Analyze the text below very carefully, sentence by sentence.

Check EVERY sentence for: subject-verb agreement, verb tense, articles (a/an/the), prepositions, plurals, word order, and word choice (collocations). Do not stop after finding one or two mistakes — find ALL of them, including small ones.

Return ONLY a raw JSON object, no markdown, no code fences, no extra text, in this exact shape:
{"level":"B1","note":"one short, warm, encouraging sentence in English, max 18 words","corrections":[{"mistake":"exact wrong phrase copied verbatim from the transcript","fix":"corrected phrase","why":"very short reason in English"}]}

"mistake" must be copied EXACTLY as it appears in the transcript below (same words, same spelling) so it can be located automatically — do not paraphrase it.

Rate CEFR level: A0, A1, A2, B1, B2, C1, or C2 (use A0 only for a few isolated words with almost no grammar; use C2 only if the language is essentially error-free and sophisticated). List up to 10 mistakes if there are that many.

Transcript:
"""${transcript}"""`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find(b => b.type === "text");

    let parsed = { level: "B1", note: "Good effort!", corrections: [] };
    if (textBlock) {
      let cleaned = textBlock.text.replace(/```json|```/g, "").trim();
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        level: parsed.level,
        note: parsed.note,
        corrections: Array.isArray(parsed.corrections) ? parsed.corrections : []
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
