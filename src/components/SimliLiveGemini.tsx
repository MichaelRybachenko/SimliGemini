import React, { useEffect, useRef, useState, useCallback } from "react";
import { SimliClient } from "simli-client";

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

  // --- Helpers ---
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

  // Convert Float32 (web audio) to Int16 (PCM)
  const float32ToInt16 = (float32: Float32Array) => {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  };

  // Downsample form 24000 (Gemini) to 16000 (Simli)
  const downsampleTo16k = (audioData: Int16Array) => {
    // Simple decimation or linear interpolation. 24k -> 16k is 3:2 ratio.
    // For every 3 input samples, need 2 output samples.
    const ratio = 24000 / 16000;
    const newLength = Math.round(audioData.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const index = i * ratio;
      const low = Math.floor(index);
      const high = Math.ceil(index);
      const weight = index - low;

      if (high < audioData.length) {
        result[i] = audioData[low] * (1 - weight) + audioData[high] * weight;
      } else {
        result[i] = audioData[low];
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
        0, // Debug
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
                text:
                  "You are a helpful AI assistant for a project called Radio AI. " +
                  "Always use your voice to respond. If you need current facts, " +
                  "use the Google Search tool before answering.",
              },
            ],
          },
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Aoede" },
              },
            },
          },
          tools: [{ google_search: {} }],
        },
      };

      ws.send(JSON.stringify(setupMsg));

      const welcome = {
        client_content: {
          turns: [
            {
              role: "user",
              parts: [{ text: "Hello! Check the news for me." }],
            },
          ],
          turn_complete: true,
        },
      };

      ws.send(JSON.stringify(welcome));

      console.log("Sent setup message");
      startAudioRecording(); // Start recording immediately
    };

    ws.onmessage = async (event: MessageEvent) => {
      let rawData = "";

      // 1. Convert Blob or ArrayBuffer to string
      if (event.data instanceof Blob) {
        rawData = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(event.data);
      } else {
        rawData = event.data;
      }

      try {
        const response = JSON.parse(rawData);

        if (response.error) {
          console.error("Gemini Error:", response.error);
          setError("Gemini Error: " + response.error.message);
          return;
        }

        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.text) {
              // Text Response
              const newText = part.text;
              setChatHistory((prev) => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === "assistant") {
                  return [
                    ...prev.slice(0, -1),
                    { ...lastMsg, content: lastMsg.content + newText },
                  ];
                }
                return [...prev, { role: "assistant", content: newText }];
              });
            }
            if (
              part.inlineData &&
              part.inlineData.mimeType.startsWith("audio/pcm")
            ) {
              // Audio Response
              const pcm24k = base64ToUint8Array(part.inlineData.data);

              // Gemini sends 24kHz, Simli needs 16kHz
              const int16Path_24k = new Int16Array(
                pcm24k.buffer,
                pcm24k.byteOffset,
                pcm24k.byteLength / 2,
              );

              // Downsample to 16k for Simli
              const int16Path_16k = downsampleTo16k(int16Path_24k);

              // Convert back to Uint8Array for the Simli Client
              if (simliClientRef.current) {
                const audioBuffer = new Uint8Array(
                  int16Path_16k.buffer,
                  int16Path_16k.byteOffset,
                  int16Path_16k.byteLength,
                );
                simliClientRef.current.sendAudioData(audioBuffer);
              }
            }
          }
        }
      } catch (e) {
        console.error("Error parsing Gemini message", e);
      }
    };

    ws.onerror = (e) => {
      console.error("Gemini WebSocket Error", e);
      setError("Gemini Connection Error");
    };

    ws.onclose = (event) => {
      console.log("Gemini WebSocket Closed", event.code, event.reason);
      setError(`Gemini Connection Closed: ${event.code} ${event.reason}`);
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
      if (wsRef.current) wsRef.current.close();
      if (simliClientRef.current) simliClientRef.current.stop();
      if (streamRef.current)
        streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioContextRef.current && audioContextRef.current.state !== "closed")
        audioContextRef.current.close();
    };
  }, [hasInteracted]);

  // Handle Output Volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isAudioMuted ? 0 : volume;
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
    <div className="flex bg-black items-center justify-center p-4 min-h-screen text-white font-sans">
      <div className="flex flex-col gap-6 max-w-2xl w-full items-center justify-center">
        
        {/* Avatar Container - Flexible width between 180px and 512px, square aspect ratio */}
        <div className="relative w-full aspect-square min-w-[180px] max-w-[512px] bg-black overflow-hidden flex items-center justify-center border border-gray-800 rounded-lg shadow-xl group">
          {/* Helper message if not started */}
          {!hasInteracted ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 text-white flex-col gap-4">
              <h2 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                Simli + Gemini Live
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
          <audio ref={audioRef} autoPlay className="hidden" />

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
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                )}
            </button>

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
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            </button>

            {/* Right: Volume Control */}
            <div className="flex items-center gap-2 bg-gray-800/80 backdrop-blur-sm rounded-full p-2 pr-4 shadow-lg group/vol">
                 <button
                    onClick={() => setIsAudioMuted(!isAudioMuted)}
                    className="p-1 hover:text-blue-400 transition-colors"
                    title={isAudioMuted ? "Unmute Audio" : "Mute Audio"}
                >
                    {isAudioMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
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
            <div className="flex flex-col gap-2 w-full max-w-[512px] animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="flex-1 bg-gray-900 rounded-lg p-4 h-64 overflow-y-auto text-sm text-gray-300 border border-gray-800 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent flex flex-col gap-3 shadow-inner">
                {chatHistory.length === 0 && (
                <p className="text-gray-500 italic text-center text-xs mt-24">
                    Conversation will appear here...
                </p>
                )}
                {chatHistory.map((msg, idx) => (
                <div
                    key={idx}
                    className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                >
                    <div
                    className={`px-4 py-3 rounded-2xl max-w-[90%] text-sm ${
                        msg.role === "user"
                        ? "bg-blue-600 text-white rounded-br-none"
                        : "bg-gray-700 text-gray-100 rounded-bl-none"
                    }`}
                    >
                    {msg.content}
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
