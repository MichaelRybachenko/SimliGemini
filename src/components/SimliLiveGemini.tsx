import React, { useEffect, useRef, useState, useCallback } from "react";
import { LogLevel, SimliClient } from "simli-client";

import { GoogleGenAI } from "@google/genai";
import { tr } from "motion/react-client";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("VITE_GEMINI_API_KEY environment variable not set.");
}

const VITE_PROJECT_ID = import.meta.env.VITE_PROJECT_ID;
const VITE_LOCATION = import.meta.env.VITE_LOCATION;
const VITE_MODEL_ID = import.meta.env.VITE_MODEL_ID;

if (!VITE_MODEL_ID) {
  throw new Error("VITE_MODEL_ID environment variable not set.");
}

const ai = new GoogleGenAI({ apiKey });

const SimliLiveGemini: React.FC = () => {
  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<SimliClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const isInitializing = useRef(false); // Ref to prevent double-initialization in Strict Mode
  const audioBufferRef = useRef<Int16Array | null>(null); // Buffer for accumlating audio samples
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const isResuming = useRef(false);
  const latestSessionHandle = useRef<string | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // --- State ---
  const [isSimliReady, setIsSimliReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInteracted, setHasInteracted] = useState(false); // Controls initialization
  const [chatHistory, setChatHistory] = useState<
    {
      role: "user" | "assistant";
      content: string;
      id?: string;
      image?: string;
      isImageLoading?: boolean;
    }[]
  >([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showTranscript, setShowTranscript] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(0);

  // --- Constants ---
  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  const SIMLI_API_KEY = import.meta.env.VITE_SIMLI_API_KEY;
  const SIMLI_FACE_ID = import.meta.env.VITE_SIMLI_FACE_ID;

  /**
   * Calls the backend to generate an embedding for the potential new album
   * and checks for similarities against existing albums.
   * Logic: 0.8+ is "Repetitive theme" (REJECT), < 0.4 is "Unique creative gap" (ACCEPT).
   */
  const similaritiesCheck = useCallback(
    async (
      title: string,
      genre: string,
      description: string,
      tracklist: string,
    ) => {
      try {
        console.log(`Checking similarities for concept: ${title}`);

        // Call backend API
        const response = await fetch(
          "https://radio69.ai/api/albums/similarities-check",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title,
              genre,
              description: `${description}\n${tracklist}`,
            }),
          },
        );

        if (!response.ok) {
          throw new Error(`API error: ${response.statusText}`);
        }

        const data = await response.json();

        console.log(`Similarity check result for "${title}":`, data);

        return data;
      } catch (err) {
        console.error("Failed to check similarities:", err);
        return { status: "ERROR", reason: "Service unavailable", score: 0 };
      }
    },
    [],
  );

  const generateImage = async (fullConceptText) => {
    // 1. Clean the prompt: Remove emojis, special characters, and newlines
    const cleanPrompt = fullConceptText
      .replace(/[^\w\s,./:!?'"()-]/gi, "") // Remove emojis but allow standard punctuation
      .replace(/\s+/g, " ") // Consolidate multiple spaces/newlines
      .split("Tracklist")[0] // Cut off the tracklist metadata
      .substring(0, 500) // Increase character limit
      .trim();

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-pro-image-preview",
        contents: [
          {
            parts: [{ text: cleanPrompt }],
          },
        ],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: "1:1",
            imageSize: "1K",
          },
        },
      });

      // Check if we have candidates and parts
      const candidate = response.candidates?.[0];
      // Find the inlineData part which contains the image
      const imagePart = candidate?.content?.parts?.find(
        (part) =>
          part.inlineData && part.inlineData.mimeType.startsWith("image/"),
      );

      if (!imagePart || !imagePart.inlineData) {
        console.log(
          "Gemini response missing image data:",
          JSON.stringify(response, null, 2),
        );
        throw new Error("No image generated by Gemini.");
      }

      const mimeType = imagePart.inlineData.mimeType;
      const base64Data = imagePart.inlineData.data;

      // Return the base64 Data URI
      return `data:${mimeType};base64,${base64Data}`;
    } catch (error) {
      console.error("Gemini image generation failed:", error);
      throw error;
    }
  };

  // --- Helpers ---
  const handleDownload = (content: string, index: number) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-history-${index}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const base64ToUint8Array = (base64: string) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const arrayBufferToBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;

    // Efficiently build the binary string
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return window.btoa(binary);
  };

  // Downsample form 24000 (Gemini) to 16000 (Simli)
  const downsampleTo16k = (audioData: Int16Array) => {
    const ratio = 1.5;
    const newLength = Math.round(audioData.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const center = Math.floor(i * ratio);
      // Weighted anti-aliasing filter
      if (center > 0 && center < audioData.length - 1) {
        result[i] =
          audioData[center - 1] * 0.25 +
          audioData[center] * 0.5 +
          audioData[center + 1] * 0.25;
      } else {
        result[i] = audioData[center];
      }
    }
    return result;
  };

  // --- Initialization ---
  const initialize = async () => {
    // Prevent double-initialization (e.g. React Strict Mode)
    if (isInitializing.current || !videoRef.current || !audioRef.current)
      return;
    isInitializing.current = true;

    setError("");

    try {
      console.log("Initializing Simli...");

      // 1. Get Simli Token (Client-side directly to Simli API)
      const simliConfig = {
        faceId: SIMLI_FACE_ID,
        handleSilence: true,
        maxSessionLength: 3600,
        maxIdleTime: 600,
      };

      const tokenResp = await fetch("https://api.simli.ai/compose/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-simli-api-key": SIMLI_API_KEY,
        },
        body: JSON.stringify(simliConfig),
      });
      if (!tokenResp.ok) throw new Error("Failed to get Simli token");
      const tokenData = await tokenResp.json();

      // 2. Get ICE Servers
      const iceResp = await fetch("https://api.simli.ai/compose/ice", {
        method: "GET",
        headers: { "x-simli-api-key": SIMLI_API_KEY }, // Warning: exposing API Key
      });
      const iceServers = iceResp.ok
        ? await iceResp.json()
        : [{ urls: ["stun:stun.l.google.com:19302"] }];

      // 3. Initialize Simli Client
      simliClientRef.current = new SimliClient(
        tokenData.session_token,
        videoRef.current,
        audioRef.current,
        iceServers,
        LogLevel.ERROR,
        "p2p",
        "websockets",
        "wss://api.simli.ai",
        3000,
      );

      simliClientRef.current.on("speaking", () => {
        console.log("SPEAKING...");
        setIsSpeaking(true);
      });
      simliClientRef.current.on("silent", () => {
        console.log("SILENT...");
        setIsSpeaking(false);
      });
      simliClientRef.current.on("stop", () =>
        console.log("SimliClient disconnected"),
      );

      await simliClientRef.current.start();
      console.log("Simli Client Started");
      setIsSimliReady(true);

      // 4. Connect to Gemini Live
      connectToGemini();
    } catch (e: any) {
      console.error(e);
      setError("Init Error: " + e.message);
    }
  };

  const connectToGemini = (resumeHandle: string | null = null) => {
    const encodedKey = GEMINI_API_KEY; // Should be valid
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodedKey}`;

    // Create WebSocket with correct protocol version if needed, or just default
    const ws = new WebSocket(url);

    // If not doing a seamless resumption, set as main socket immediately
    if (!isResuming.current) {
      wsRef.current = ws;
    }

    ws.onopen = () => {
      const currentSessionId = resumeHandle;

      console.log(
        `Gemini WebSocket Connected. Resuming? ${!!resumeHandle}. Session ID: ${currentSessionId || "None"}`,
      );

      // Initial Setup Message
      // Note: Gemini Live API often requires a specific 'setup' payload as the VERY FIRST message.
      const setupMsg = {
        setup: {
          //model: `projects/${}/locations/${VITE_LOCATION}/models/${VITE_MODEL_ID}`,
          model: VITE_MODEL_ID,
          //...(resumeHandle
          //  ? { sessionResumption: { handle: resumeHandle } }
          //  : {}),
          sessionResumption: { handle: resumeHandle },
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
          },
          //proactivity: { proactiveAudio: true },
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Laomedeia" },
              },
            },
          },
          input_audio_transcription: {},
          output_audio_transcription: {},
          system_instruction: {
            parts: [
              {
                text: `
Role: Alisa, Creative Producer for 'Radio AI'. Expert in high-concept, innovative musical album brainstorming.
Objective: Generate unique album concepts that provide a cohesive "soul" for AI generation.

If you need some thinking to do, say "Hmm..." or "Let me think..." to indicate you're working on it.
This is especially important if you're doing market research or compiling a list of tracks, which can take a moment.

Workflow:
Context Check: Call get_recent_concepts immediately. Use these to ensure the new idea is a "Repertoire Gap" (unique) rather than a "Crowded Space."
Market Research: Use Google Search to find trending music themes or industry news to incorporate fresh insights.
Concept Ideation: Brainstorm a title and high-concept fusion.
Validation: Call similarities_check for your candidate idea.
If REJECT: Pivot to a new direction. Repeat up to 5 times.
If ACCEPT or ERROR: Proceed to finalization.

Finalization: Print the concept using the print_album_concept function and speak your response to the user.

Concept Requirements:
Narrative: A specific story or scenario (e.g., 1980s retro ski race).
Atmosphere: Sensory keywords (e.g., "misty and ethereal").
Instrumentation: Specific tools (e.g., "lutes," "analog drum machines").
Vocals: Style description (e.g., "whispered," "operatic," or Instrumental).
Tracklist: Generate 5-20 tracks following a narrative arc.
Format: - Track 1,2,3,...: "Title" - [Description] - [Style Tags]. [new line]

Note: Only read 1-2 'signature' tracks aloud; print the rest.

Art Prompt: A detailed visual prompt for AI image generation.

Constraints:
Be Bold: Favor unexpected genre fusions.
Function First: You MUST call print_album_concept(title, genre, description, tracklist, instrumental, art_prompt) to finalize.

Voice: Maintain a professional, creative, and witty persona.                
`,
              },
            ],
          },
          tools: [
            { google_search: {} },
            {
              functionDeclarations: [
                {
                  name: "print_album_concept",
                  description:
                    "Saves a finalized musical album concept to the database.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      title: {
                        type: "STRING",
                        description: "The title of the album",
                      },
                      genre: {
                        type: "STRING",
                        description: "The genre fusion",
                      },
                      description: {
                        type: "STRING",
                        description: "Detailed concept summary",
                      },
                      tracklist: {
                        type: "STRING",
                        description: "List of tracks in the album",
                      },
                      instrumental: {
                        type: "BOOLEAN",
                        description:
                          "Whether the album is instrumental or has vocals",
                      },
                      art_prompt: {
                        type: "STRING",
                        description: "Visual prompt for cover art",
                      },
                    },
                    required: [
                      "title",
                      "genre",
                      "description",
                      "tracklist",
                      "instrumental",
                      "art_prompt",
                    ],
                  },
                },
                {
                  name: "get_recent_concepts",
                  description:
                    "Retrieves the recent album concepts (Title, Genre, Description) from the local database.",
                  parameters: { type: "object", properties: {} },
                },
                {
                  name: "similarities_check",
                  description:
                    "Checks for similarities between album concepts to avoid duplication.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      title: {
                        type: "STRING",
                        description: "The title of the album",
                      },
                      genre: {
                        type: "STRING",
                        description: "The genre fusion",
                      },
                      description: {
                        type: "STRING",
                        description: "Detailed concept summary",
                      },
                      tracklist: {
                        type: "STRING",
                        description: "List of tracks in the album",
                      },
                    },
                    required: ["title", "genre", "description", "tracklist"],
                  },
                },
              ],
            },
          ],
        },
      };

      ws.send(JSON.stringify(setupMsg));

      if (resumeHandle) {
        console.log("Resuming session... skipping welcome message.");
        return;
      }

      // Sending the welcome message with a slight delay allows the server to process the setup message first.
      // This prevents race conditions where 'client_content' and 'realtime_input' (audio) arrive before the session is ready.
      setTimeout(() => {
        const welcome = {
          client_content: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: "Hello, Creative Producer! Welcome to the meeting! Give me a casual greeting and tell me you're ready to start brainstorming albums. Use Google Search if you need to know what's trending in music right now. Give me one brilliant idea for an album concept to start with.",
                  },
                ],
              },
            ],
            turn_complete: true,
          },
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(welcome));
          console.log("Sent Welcome Message");
        }

        // Start recording after sending the welcome message
        startAudioRecording();
      }, 500);
    };

    ws.onmessage = async (event: MessageEvent) => {
      const rawData = await event.data.text();
      const response = JSON.parse(rawData);

      // Seamless Resumption: Switch to new socket on first message
      if (ws !== wsRef.current && isResuming.current) {
        console.log(
          "New session established via resumption. Switching sockets.",
        );
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log("Closing old socket...");
          wsRef.current.close(1000, "Resumption Complete");
        }
        wsRef.current = ws;
        isResuming.current = false;
      }

      // Handle Setup Completion (if applicable) or Initial triggering
      // Note: Gemini API doesn't always send a specific "setup complete" message,
      // but waiting for the first message or just delaying can help.
      // However, to be robust, we'll just check if this is the first interaction.

      // ... existing message handling ...

      if (response.toolCall) {
        console.log("Producer is printing a concept...");
        const functionResponses: any[] = [];

        for (const fc of response.toolCall.functionCalls) {
          if (fc.name === "print_album_concept") {
            // 1. Capture the concept for your UI
            const concept = fc.args;

            console.log(
              `📀 NEW CONCEPT:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nTracklist:\n${concept.tracklist}\nAlbum art prompt:\n${concept.art_prompt}`,
            );

            const renderId = `msg-${Date.now()}`;

            setChatHistory((prev) => [
              ...prev,
              {
                id: renderId,
                role: "assistant",
                content: `📀 NEW CONCEPT:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nTracklist:\n${concept.tracklist}\nAlbum art prompt:\n${concept.art_prompt}`,
                isImageLoading: true,
              },
            ]);

            // 2. Prepare the success response for Gemini
            functionResponses.push({
              id: fc.id,
              name: fc.name,
              response: {
                result: concept,
              },
            });

            console.log(
              `Generating image: ${renderId} - Create album art for: ${concept.art_prompt}. ${concept.description}`,
            );

            // 3. Generate an image for the album art using the provided prompt.
            // First put a placeholder, with progress indicator, then update with actual image URL once generated.
            // The image generation must be done asynchronously, so not to block the Gemini response.
            generateImage(
              `Create album art for: ${concept.art_prompt}. ${concept.description}`,
            )
              .then((imageUrl) => {
                console.log(`Generating image: ${renderId}`);

                setChatHistory((prev) =>
                  prev.map((msg) => {
                    if (msg.id === renderId) {
                      return { ...msg, image: imageUrl, isImageLoading: false };
                    }
                    return msg;
                  }),
                );
              })
              .catch((err) => {
                console.error("Failed to generate concept image:", err);
                setChatHistory((prev) =>
                  prev.map((msg) => {
                    if (msg.id === renderId) {
                      return {
                        ...msg,
                        isImageLoading: false,
                        content: msg.content + "\n[Image Generation Failed]",
                      };
                    }
                    return msg;
                  }),
                );
              });
          } else if (fc.name === "get_recent_concepts") {
            console.log("Producer is requesting recent concepts...");

            // Real data https://radio69.ai/
            // | GET | `/api/user-concepts/recent` | Get Recent Concepts | Public | Query: `username`, `limit` |
            let simplifiedConcepts: any[] = [];

            try {
              const response = await fetch(
                "https://radio69.ai/api/user-concepts/recent?limit=10",
              );

              if (!response.ok) {
                throw new Error(`API error: ${response.statusText}`);
              }

              const data = await response.json();

              // Map API response to expected format
              simplifiedConcepts = Array.isArray(data)
                ? data.map((c: any) => ({
                    title: c.title || "Untitled",
                    description: c.description || "No description",
                  }))
                : [];

              console.log(
                `Fetched ${simplifiedConcepts.length} recent concepts from API`,
              );
            } catch (error) {
              console.error("Failed to fetch recent concepts:", error);
              simplifiedConcepts = [];
            }

            functionResponses.push({
              id: fc.id,
              name: fc.name,
              response: {
                result: simplifiedConcepts,
              },
            });

            console.log(
              `Sent ${simplifiedConcepts.length} recent concepts to Producer.`,
            );
          } else if (fc.name === "similarities_check") {
            // "title", "genre", "description", "tracklist"
            const concept = fc.args;

            console.log(
              `Producer requesting similarities check:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nTracklist:\n${concept.tracklist}`,
            );

            setChatHistory((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `Producer requesting similarities check:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nTracklist:\n${concept.tracklist}`,
              },
            ]);

            try {
              const similaritiesResult = await similaritiesCheck(
                concept.title,
                concept.genre,
                concept.description,
                concept.tracklist,
              );

              console.log(
                `Similarity Result: [${similaritiesResult?.status}]: ${similaritiesResult?.reason}, Score: ${similaritiesResult?.score}`,
              );

              setChatHistory((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `Similarity Result: [${similaritiesResult?.status}]: ${similaritiesResult?.reason}, Score: ${similaritiesResult?.score}`,
                },
              ]);

              functionResponses.push({
                id: fc.id,
                name: fc.name,
                response: {
                  result: similaritiesResult,
                },
              });
            } catch (err) {
              console.error("Error during similarities check:", err);

              setChatHistory((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: "Error during similarities check!",
                },
              ]);

              functionResponses.push({
                id: fc.id,
                name: fc.name,
                response: {
                  result: {
                    status: "ERROR",
                    reason: "Service unavailable",
                    score: 0,
                  },
                },
              });
            }
          }
        }

        // 3. Send ACK back to Gemini to keep the conversation flowing
        wsRef.current?.send(
          JSON.stringify({
            tool_response: { function_responses: functionResponses },
          }),
        );
      } else if (response.goAway) {
        const timeLeft = response.goAway.timeLeft;

        console.log(
          `Gemini signaled shutdown. Time left: ${timeLeft}, resumption Handle: ${latestSessionHandle.current}, isResuming: ${isResuming.current}`,
        );

        if (latestSessionHandle.current && !isResuming.current) {
          isResuming.current = true;
          // Trigger pre-emptive resumption
          console.log("Triggering pre-emptive session resumption in 3s...");
          setTimeout(() => {
            const handle = latestSessionHandle.current;
            if (handle) {
              console.log("Connecting with resumption handle:", handle);
              connectToGemini(handle);
            } else {
              console.warn("Resumption handle:", handle);
            }
          }, 3000);
        }
      } else if (response.sessionResumptionUpdate) {
        console.log(
          "Session Resumption Update:",
          response.sessionResumptionUpdate,
        );

        if (response.sessionResumptionUpdate.resumable) {
          latestSessionHandle.current =
            response.sessionResumptionUpdate.newHandle;
          console.log(
            "Updated session ID for resumption:",
            latestSessionHandle.current,
          );
        }
      } else if (response.serverContent) {
        if (response.serverContent.modelTurn?.parts) {
          // 1. Check for incoming audio chunks
          const audioPart = response.serverContent?.modelTurn?.parts?.find(
            (p) => p.inlineData?.mimeType.startsWith("audio/pcm"),
          );

          if (audioPart) {
            const pcm24kRaw = base64ToUint8Array(audioPart.inlineData.data);

            const int16_24k = new Int16Array(
              pcm24kRaw.buffer,
              pcm24kRaw.byteOffset,
              pcm24kRaw.byteLength / 2,
            );

            const int16_16k = downsampleTo16k(int16_24k);

            if (simliClientRef.current) {
              const audioBuffer = new Uint8Array(
                int16_16k.buffer,
                int16_16k.byteOffset,
                int16_16k.byteLength,
              );

              // console.log("Sending audio data with updated...");

              simliClientRef.current.sendAudioData(audioBuffer);
            }
          } else {
            console.log("Received serverContent:", response.serverContent);

            if (showThinking) {
              response.serverContent.modelTurn?.parts.forEach((part) => {
                if (part.text) {
                  setChatHistory((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content: part.text,
                    },
                  ]);
                } else if (part.codeExecutionResult) {
                  setChatHistory((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content: `${part.codeExecutionResult.outcome}: ${part.codeExecutionResult.output}`,
                    },
                  ]);
                }
              });
            }
          }
        } else {
          console.log("Received serverContent:", response.serverContent);

          // if the message was response.serverContent.outputTranscription, append it to the last message in the chat history instead of creating a new message
          // Only response.serverContent.outputTranscription messages should be appended, all other messages (like modelTurn) should create a new message in the chat history
          if (
            showThinking &&
            response.serverContent.outputTranscription?.text
          ) {
            setChatHistory((prev) => {
              const lastMsg = prev[prev.length - 1];
              // Don't append to messages that have an ID (Tool Cards) or specific Tool Logs
              const isToolMsg =
                lastMsg?.id ||
                lastMsg?.content.startsWith("Producer requesting") ||
                lastMsg?.content.startsWith("Similarity Result");

              if (lastMsg?.role === "assistant" && !isToolMsg) {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMsg,
                    content:
                      lastMsg.content +
                      " " +
                      response.serverContent.outputTranscription.text,
                  },
                ];
              }
              return [
                ...prev,
                {
                  role: "assistant",
                  content: response.serverContent.outputTranscription.text,
                },
              ];
            });
          } else if (response.serverContent.generationComplete) {
            setChatHistory((prev) => [
              ...prev,
              {
                role: "assistant",
                content: "Generation complete...",
              },
            ]);
          } else if (response.serverContent.turnComplete) {
            setChatHistory((prev) => [
              ...prev,
              {
                role: "assistant",
                content: "Turn complete...",
              },
            ]);
          }
        }
      } else {
        console.log("Received message:", response);
      }
    };

    ws.onerror = (e) => {
      console.error("Gemini WebSocket Error", e);
      setError("Gemini Connection Error");
    };

    ws.onclose = (event) => {
      console.log("Gemini WebSocket Closed", event.code, event.reason);

      // If this socket is not the active one, ignore the close event
      if (ws !== wsRef.current) {
        console.log("Inactive socket closed. Ignoring.");
        return;
      }

      if (event.code === 1008 || event.reason.includes("session not found")) {
        console.log("Session invalid. Clearing session and retrying...");
        connectToGemini();
        return;
      }

      // setError(`Gemini Connection Closed: ${event.code} ${event.reason}`);
      setIsSimliReady(false); // Update UI state
      if (simliClientRef.current) {
        simliClientRef.current.stop();
        simliClientRef.current = null;
      }
    };
  };

  const handleSendText = () => {
    if (!inputText.trim()) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError("Gemini is not connected. Please start interaction first.");
      return;
    }

    // Construct Text Message for Gemini
    const msg = {
      client_content: {
        turns: [
          {
            role: "user",
            parts: [{ text: inputText }],
          },
        ],
        turn_complete: true,
      },
    };

    wsRef.current.send(JSON.stringify(msg));

    // Update local chat history
    setChatHistory((prev) => [...prev, { role: "user", content: inputText }]);
    setInputText("");
  };

  const startAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      // Load the worklet from the public folder
      await audioContext.audioWorklet.addModule("/pcm-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor"); // Changed to match registered name
      processorRef.current = workletNode;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        
        setVolumeLevel(average); 
        
        if (streamRef.current) {
          requestAnimationFrame(updateMeter);
        }
      };
      updateMeter();

      workletNode.port.onmessage = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
          return;

        const pcmBuffer = event.data;
        const base64Audio = arrayBufferToBase64(pcmBuffer);

        const msg = {
          realtime_input: {
            media_chunks: [
              {
                mime_type: "audio/pcm;rate=16000",
                data: base64Audio,
              },
            ],
          },
        };

        wsRef.current.send(JSON.stringify(msg));
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination); // Required for some browsers to keep the clock running
    } catch (e) {
      console.error("Mic Error:", e);
    }
  };

  useEffect(() => {
    if (hasInteracted) {
      initialize();
    }
    return () => {
      console.log("Cleaning up Simli & Gemini...");
      isInitializing.current = false; // Allow re-initialization
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (simliClientRef.current) {
        simliClientRef.current.stop();
        simliClientRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (playbackContextRef.current) {
        playbackContextRef.current.close();
        playbackContextRef.current = null;
      }
    };
  }, [hasInteracted]);

  // Handle Output Volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = isAudioMuted;
      audioRef.current.volume = volume;
    }
  }, [volume, isAudioMuted]);

  // Handle Input Mute
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isMicMuted;
      });
    }
  }, [isMicMuted]);

  // Handle Chat Scroll on new content from Gemini
  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  };

  const handleScroll = () => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } =
        chatContainerRef.current;
      // 50px threshold to determine if user is at the bottom
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      isAtBottomRef.current = isAtBottom;
    }
  };

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [chatHistory]);

  return (
    <div className="flex bg-black items-center justify-center min-h-screen h-screen overflow-hidden text-white font-sans">
      <div className="flex flex-col gap-6 max-w-2xl w-full h-full p-4 items-center justify-center min-h-0">
        {/* Avatar Container - Flexible width between 180px and 512px, square aspect ratio */}
        <div
          className={`relative w-full aspect-square min-w-[180px] max-w-[512px] min-h-[180px] shrink bg-black overflow-hidden flex items-center justify-center border rounded-lg shadow-xl transition-all duration-700 ease-in-out group ${
            isSpeaking
              ? "animate-ai-pulse border-blue-400 scale-[1.02]"
              : "border-gray-800 scale-100"
          }`}
        >
          {/* Helper message if not started */}
          {!hasInteracted ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 text-white flex-col gap-4">
              <h2 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                Creative Producer is waiting!
              </h2>
              <button
                onClick={() => setHasInteracted(true)}
                className="px-6 py-2 bg-blue-600 rounded hover:bg-blue-700 transition font-semibold"
              >
                Start Interaction
              </button>
            </div>
          ) : null}

          {/* Video Element for Simli */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-cover transition-opacity duration-1000 ${
              isSimliReady ? "opacity-100" : "opacity-0"
            }`}
          />

          {/* Active Indicator Dot */}
          {isSpeaking && (
            <div className="absolute top-4 right-4 flex h-3 w-3 z-40">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </div>
          )}

          {/* Input Volume Meter Overlay */}
          <div className="absolute top-4 left-4 z-40 bg-black/50 p-2 rounded-lg backdrop-blur-sm">
            <div className="w-2 h-24 bg-gray-700 rounded-full overflow-hidden flex flex-col justify-end">
              <div 
                className="w-full bg-green-500 transition-all duration-75" 
                style={{ height: `${isMicMuted ? 0 : (volumeLevel / 255) * 100}%` }}
              />
            </div>
          </div>

          <audio ref={audioRef} autoPlay muted className="hidden" />

          {/* Status / Error Overlay */}
          {(error || (!isSimliReady && hasInteracted && !error)) && (
            <div className="absolute top-2 left-2 right-2 bg-black/50 text-white text-xs p-2 rounded z-30 pointer-events-none text-center backdrop-blur-sm">
              {error ? (
                <span className="text-red-400">{error}</span>
              ) : (
                "Connecting to Simli & Gemini..."
              )}
            </div>
          )}

          {/* Bottom Controls Overlay */}
          <div className="absolute bottom-4 left-4 right-4 flex justify-between items-center z-40 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            {/* Left: Mic Toggle */}
            <div className="flex items-center gap-4">
              <button
                onClick={() => setIsMicMuted(!isMicMuted)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  isMicMuted
                    ? "bg-red-600 hover:bg-red-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMicMuted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>
                )}
              </button>
              {/* End Conversation Button */}
              {hasInteracted && (
                <button
                  onClick={() => {
                    setHasInteracted(false);
                    setIsSimliReady(false);
                  }}
                  className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white transition-all shadow-lg"
                  title="End Conversation"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                    <line x1="12" y1="2" x2="12" y2="12"></line>
                  </svg>
                </button>
              )}
            </div>

            {/* Middle: Controls */}
            <div className="flex items-center gap-4">
              {/* Thinking Toggle */}
              <button
                onClick={() => setShowThinking(!showThinking)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  showThinking
                    ? "bg-purple-600 hover:bg-purple-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title="Toggle Thinking Output"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M4,18 C5.1045695,18 6,18.8954305 6,20 C6,21.1045695 5.1045695,22 4,22 C2.8954305,22 2,21.1045695 2,20 C2,18.8954305 2.8954305,18 4,18 Z M9.5,15 C10.8807119,15 12,16.1192881 12,17.5 C12,18.8807119 10.8807119,20 9.5,20 C8.11928813,20 7,18.8807119 7,17.5 C7,16.1192881 8.11928813,15 9.5,15 Z M12,2 C14.6592222,2 16.8838018,3.92259542 17.3302255,6.47059089 L17.4117647,6.47058824 C19.4909544,6.47058824 21.1764706,8.15610447 21.1764706,10.2352941 C21.1764706,12.3144838 19.4909544,14 17.4117647,14 L6.58823529,14 C4.50904565,14 2.82352941,12.3144838 2.82352941,10.2352941 C2.82352941,8.15610447 4.50904565,6.47058824 6.58825824,6.47058824 L6.66977451,6.47059089 C7.11619821,3.92259542 9.34077777,2 12,2 Z"></path>
                </svg>
              </button>

              {/* Transcript Toggle */}
              <button
                onClick={() => setShowTranscript(!showTranscript)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  showTranscript
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title="Toggle Transcript"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
              </button>
            </div>

            {/* Right: Volume Control */}
            <div className="flex items-center gap-2 bg-gray-800/80 backdrop-blur-sm rounded-full p-2 pr-4 shadow-lg group/vol">
              <button
                onClick={() => setIsAudioMuted(!isAudioMuted)}
                className="p-1 hover:text-blue-400 transition-colors"
                title={isAudioMuted ? "Unmute Audio" : "Mute Audio"}
              >
                {isAudioMuted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <line x1="23" y1="9" x2="17" y2="15"></line>
                    <line x1="17" y1="9" x2="23" y2="15"></line>
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  </svg>
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(e) => {
                  setVolume(parseFloat(e.target.value));
                  setIsAudioMuted(false);
                }}
                className="w-20 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer hover:bg-blue-500 accent-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Transcript Section (Bottom) */}
        {showTranscript && (
          <div className="flex flex-col gap-2 w-full max-w-[512px] flex-1 min-h-0 animate-in fade-in slide-in-from-top-4 duration-300">
            <div
              ref={chatContainerRef}
              onScroll={handleScroll}
              className="flex-1 bg-gray-900 rounded-lg p-4 overflow-y-auto text-sm text-gray-300 border border-gray-800 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent flex flex-col gap-3 shadow-inner min-h-0"
            >
              {chatHistory.length === 0 && (
                <p className="text-gray-500 italic text-center text-xs my-auto">
                  Conversation will appear here...
                </p>
              )}
              {chatHistory.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}
                >
                  <div
                    className={`px-4 py-3 rounded-2xl max-w-[90%] text-sm whitespace-pre-wrap relative group/msg ${
                      msg.role === "user"
                        ? "bg-blue-600 text-white rounded-br-none"
                        : "bg-gray-700 text-gray-100 rounded-bl-none pr-10"
                    }`}
                  >
                    {msg.content}
                    {msg.isImageLoading && (
                      <div className="mt-4 w-64 h-64 bg-gray-800 animate-pulse rounded-lg flex items-center justify-center border border-gray-600">
                        <span className="text-gray-400 text-xs">
                          Generating Cover Art...
                        </span>
                      </div>
                    )}
                    {msg.image && (
                      <div className="mt-4">
                        <img
                          src={msg.image}
                          alt="Generated Album Art"
                          className="w-64 h-64 object-cover rounded-lg shadow-md border border-gray-600"
                        />
                      </div>
                    )}
                    {msg.role === "assistant" && (
                      <button
                        onClick={() => handleDownload(msg.content, idx)}
                        className="absolute top-2 right-2 text-gray-400 hover:text-white opacity-0 group-hover/msg:opacity-100 transition-opacity p-1 bg-gray-700/50 rounded-full backdrop-blur-sm"
                        title="Download this message"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {/* Text Input Area */}
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSendText();
                  }
                }}
                placeholder="Type a message..."
                className="flex-1 bg-gray-800 text-white rounded p-2 text-sm border border-gray-700 outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={handleSendText}
                type="button"
                disabled={!inputText.trim()}
                className={`px-4 py-2 bg-blue-600 rounded text-sm font-bold hover:bg-blue-700 transition-colors ${!inputText.trim() ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SimliLiveGemini;
