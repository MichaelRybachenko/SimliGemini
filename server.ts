import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize Gemini
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // Simli Helpers
  async function generateSimliSessionToken(apiKey: string, faceId: string) {
    const url = "https://api.simli.ai/compose/token";
    const body = {
      faceId: faceId,
      handleSilence: true,
      maxSessionLength: 3600,
      maxIdleTime: 600,
      // Removed model: "fasttalk" to rely on default or avoid potential issues
    };
    console.log("Requesting Simli Token with body:", body);
    
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "x-simli-api-key": apiKey
      },
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("Simli Token Error Response:", text);
      throw new Error(`Simli Token Error: ${text}`);
    }
    const data = await response.json();
    console.log("Simli Token Response:", data);
    return data;
  }

  async function generateIceServers(apiKey: string) {
    const url = "https://api.simli.ai/compose/ice";
    const response = await fetch(url, {
      headers: { "x-simli-api-key": apiKey },
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Simli ICE Error: ${response.status}`);
    }
    return await response.json();
  }

  // API Routes
  app.get("/api/simli/session", async (req, res) => {
    try {
      const apiKey = process.env.SIMLI_API_KEY || process.env.VITE_SIMLI_API_KEY;
      const faceId = process.env.SIMLI_FACE_ID || process.env.VITE_SIMLI_FACE_ID;
      
      if (!apiKey || !faceId) {
        console.error("Missing Simli configuration:", { 
          hasApiKey: !!apiKey, 
          hasFaceId: !!faceId 
        });
        return res.status(500).json({ 
          error: `Simli API Key or Face ID not configured. (API Key: ${!!apiKey}, Face ID: ${!!faceId})` 
        });
      }

      const tokenData = await generateSimliSessionToken(apiKey, faceId);
      res.json(tokenData);
    } catch (error: any) {
      console.error("Error generating Simli token:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/simli/ice", async (req, res) => {
    try {
      const apiKey = process.env.SIMLI_API_KEY || process.env.VITE_SIMLI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "Simli API Key not configured" });
      }
      const iceServers = await generateIceServers(apiKey);
      res.json(iceServers);
    } catch (error: any) {
      console.error("Error generating Simli ICE servers:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      // 1. Generate text response
      const model = "gemini-2.5-flash-preview-tts";
      
      // We want both text and audio.
      // However, the TTS model is specialized. 
      // Let's first get the text response using a standard model if we want complex reasoning,
      // but 2.5-flash-preview-tts might handle both.
      // Actually, the docs say: "Transform text input into single-speaker or multi-speaker audio."
      // It doesn't say it generates the text response itself from a prompt.
      // So we need two steps:
      // Step A: Generate text response using gemini-2.5-flash
      // Step B: Generate audio using gemini-2.5-flash-preview-tts
      
      // Step A: Text Generation
      const chatModel = "gemini-2.5-flash";
      const chatResponse = await ai.models.generateContent({
        model: chatModel,
        contents: message,
      });
      
      const textResponse = chatResponse.text;
      if (!textResponse) {
        throw new Error("No text response from Gemini");
      }

      // Step B: Audio Generation (TTS)
      const ttsResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: textResponse }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const audioData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!audioData) {
        throw new Error("No audio response from Gemini TTS");
      }

      res.json({
        text: textResponse,
        audio: audioData, // Base64 string
      });

    } catch (error: any) {
      console.error("Error in /api/chat:", error);
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
