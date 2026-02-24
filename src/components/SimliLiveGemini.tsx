import { col, tr } from "motion/react-client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { LogLevel, SimliClient } from "simli-client";

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

  // --- State ---
  const [isSimliReady, setIsSimliReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInteracted, setHasInteracted] = useState(false); // Controls initialization
  const [chatHistory, setChatHistory] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);

  // --- Constants ---
  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  const SIMLI_API_KEY = import.meta.env.VITE_SIMLI_API_KEY;
  const SIMLI_FACE_ID = import.meta.env.VITE_SIMLI_FACE_ID;
  const DUAL_PIPELINE = true; // Set to true for Gemini audio, false for Simli audio

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

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  // Adjust this value based on your testing (usually 150ms - 300ms)
  const LATENCY_COMPENSATION = 0.22; // 215ms delay

  const play24kAudio = (int16Data: Int16Array) => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
      // Initialize nextStartTime with a small buffer for the network
      nextStartTimeRef.current = playbackContextRef.current.currentTime + LATENCY_COMPENSATION;
    }

    const ctx = playbackContextRef.current;
    const float32 = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32[i] = int16Data[i] / 32768; // Convert PCM16 to Float32
    }

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule playback with the offset
    const startTime = Math.max(ctx.currentTime + LATENCY_COMPENSATION, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + buffer.duration;
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
      const client = new SimliClient(
        tokenData.session_token,
        videoRef.current,
        audioRef.current,
        iceServers,
        LogLevel.ERROR, // Debug
        "p2p",
        "websockets",
        "wss://api.simli.ai",
        3000,
      );

      simliClientRef.current = client;
      await client.start();
      console.log("Simli Client Started");
      setIsSimliReady(true);

      // 4. Connect to Gemini Live
      connectToGemini();
    } catch (e: any) {
      console.error(e);
      setError("Init Error: " + e.message);
    }
  };

  const connectToGemini = () => {
    const encodedKey = GEMINI_API_KEY; // Should be valid
    //const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodedKey}`;
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodedKey}`;

    // Create WebSocket with correct protocol version if needed, or just default
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Gemini WebSocket Connected");

      // Initial Setup Message
      // Note: Gemini Live API often requires a specific 'setup' payload as the VERY FIRST message.
      const setupMsg = {
        setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          system_instruction: {
            parts: [
              {
                text: `
You are the Lead Creative Producer for 'Radio AI'. Your name is Scarlet, and you are a world-renowned expert in crafting innovative musical album concepts.
Your goal is to brainstorm innovative, high-concept musical album ideas.
Think about album titles, tracklist themes, cover art descriptions, and specific genre-fusion (e.g., Cyber-Folk, Ambient-Industrial).
Always use your voice to respond. If the user asks for what's trending, use Google Search to find current music market news.
A good concept helps the Suno AI create a cohesive story through music.
A concept is more than just a genre; it is the "soul" of the album. It is a central theme, story, or mood that ties all the songs together.

The Narrative: Is it a story about a lost traveler? A 1980s retro-ski race?
The Atmosphere: Is it "misty and ethereal" or "high-octane and neon"?
Lyrical Themes: What should the songs talk about?
Musical Style: Mention specific instruments like "Lutes and harps" or "Analog drum machines".
Vocal Style: Should the vocals be "whispered and haunting" or "powerful and operatic"? Or is it an instrumental album with no vocals at all?
The album art: Detailed 'Visual Art Prompt' that I can use to generate the cover art.

Neon should be last thing on your mind when creating concepts. Be bold, original, and unexpected! Surprise me with your creativity.
Search for inspiration if you need to, but always put your unique Scarlet spin on it. I want concepts that feel fresh and exciting, not rehashes of old ideas.

Use search to find what shows are trending in the music industry and incorporate those insights into your concepts.

When generating an album, you must create a cohesive from 5 to 20-track list that follows the narrative arc. 
For each song, provide a creative title, a description of its place in the story, and specific Suno-style style tags (Genre/Mood/Instrumentation/Vocal Style).
Include a track list into the description of the album concept, making sure it fits the overall narrative and atmosphere.
Please, each track with a new line and a dash, like this:
- Track 1: "Title" - Description of the song's role in the album and style tags.

Whenever you finalize a musical album concept, you MUST call the 'print_album_concept' function.
Function 'print_album_concept' takes the following parameters:
- title: The album title
- genre: The specific genre fusion (e.g., "Cyber-Folk")
- description: A detailed summary of the album concept, including narrative, atmosphere, lyrical themes, and musical style.
- instrumental: A boolean indicating whether the album is instrumental or has vocals, and if so, what vocal style.
- art_prompt: A detailed visual art prompt for the album cover that captures the essence of the concept.
`,
              },
            ],
          },
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Laomedeia" },
              },
            },
            thinking_config: {
              // Use thinking_budget=0 to disable reasoning verbalization for 2.5 models
              thinking_budget: 0,
            },
          },
          input_audio_transcription: {},
          output_audio_transcription: {},
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
                    required: ["title", "genre", "description", "art_prompt"],
                  },
                },
              ],
            },
          ],
        },
      };

      ws.send(JSON.stringify(setupMsg));

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
              `📀 NEW CONCEPT:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nAlbum art prompt:\n${concept.art_prompt}`,
            );
            setChatHistory((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `📀 NEW CONCEPT:\n${concept.title} (${concept.genre})\nDescription:\n${concept.description}\nAlbum art prompt:\n${concept.art_prompt}`,
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
          }
        }

        // 3. Send ACK back to Gemini to keep the conversation flowing
        wsRef.current?.send(
          JSON.stringify({
            tool_response: { function_responses: functionResponses },
          }),
        );
      }

      // 1. Check for incoming audio chunks
      const audioPart = response.serverContent?.modelTurn?.parts?.find((p) =>
        p.inlineData?.mimeType.startsWith("audio/pcm"),
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
          simliClientRef.current.sendAudioData(audioBuffer);
        }

        if (DUAL_PIPELINE) {
          play24kAudio(int16_24k);
        }
      }
    };

    ws.onerror = (e) => {
      console.error("Gemini WebSocket Error", e);
      setError("Gemini Connection Error");
    };

    ws.onclose = (event) => {
      console.log("Gemini WebSocket Closed", event.code, event.reason);
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

      workletNode.port.onmessage = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
          return;

        const base64Audio = arrayBufferToBase64(event.data);
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
      if (DUAL_PIPELINE) {
        audioRef.current.muted = true;
        audioRef.current.volume = 0;
      } else {
        audioRef.current.muted = isAudioMuted;
        audioRef.current.volume = volume;
      }
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

  return (
    <div className="flex bg-black items-center justify-center min-h-screen h-screen overflow-hidden text-white font-sans">
      <div className="flex flex-col gap-6 max-w-2xl w-full h-full p-4 items-center justify-center min-h-0">
        {/* Avatar Container - Flexible width between 180px and 512px, square aspect ratio */}
        <div className="relative w-full aspect-square min-w-[180px] max-w-[512px] min-h-[180px] shrink bg-black overflow-hidden flex items-center justify-center border border-gray-800 rounded-lg shadow-xl group">
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
            className="w-full h-full object-cover"
          />
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

            {/* Middle: Transcript Toggle */}
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
            <div className="flex-1 bg-gray-900 rounded-lg p-4 overflow-y-auto text-sm text-gray-300 border border-gray-800 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent flex flex-col gap-3 shadow-inner min-h-0">
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
