import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SimliClient } from 'simli-client';

const SimliLiveGemini: React.FC = () => {
  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<SimliClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // --- State ---
  const [isSimliReady, setIsSimliReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInteracted, setHasInteracted] = useState(false); // Controls initialization
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

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
    let binary = '';
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
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
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
    if (!videoRef.current || !audioRef.current) return;
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
             headers: { "x-simli-api-key": SIMLI_API_KEY } // Warning: exposing API Key
        });
        const iceServers = iceResp.ok ? await iceResp.json() : [{ urls: ["stun:stun.l.google.com:19302"] }];

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
            3000
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
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodedKey}`;
    
    // Create WebSocket with correct protocol version if needed, or just default
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
        console.log("Gemini WebSocket Connected");
        
        // Initial Setup Message
        // Note: Gemini Live API often requires a specific 'setup' payload as the VERY FIRST message.
        const setupMsg = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                generation_config: {
                    response_modalities: ["AUDIO", "TEXT"],
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } }
                    }
                }
            }
        };
        ws.send(JSON.stringify(setupMsg));
        
        // ONLY Start Audio Recording AFTER we are sure the connection is stable? 
        // Or maybe wait for a server handshake? 
        // For now, let's keep it here, but maybe add a small delay or check.
        startAudioRecording();
    };

    ws.onmessage = async (event) => {
        // Blob for audio? No, it sends text frames usually unless configured otherwise.
        if (event.data instanceof Blob) {
            // Handle binary if needed, but Gemini usually sends JSON with base64
            console.log("Received Blob from Gemini");
        } else {
            try {
                const response = JSON.parse(event.data);
                if (response.error) {
                  // Log error details from Gemini
                  console.error("Gemini Error:", response);
                  setError("Gemini Error: " + response.error.message);
                  return;
                }
                
                if (response.serverContent?.modelTurn?.parts) {
                    for (const part of response.serverContent.modelTurn.parts) {
                        if (part.text) {
                            // Text Response
                            const newText = part.text;
                            setChatHistory(prev => {
                                const lastMsg = prev[prev.length - 1];
                                if (lastMsg && lastMsg.role === 'assistant') {
                                    // Append to last message if it's assistant (streaming)
                                    // Note: This naive approach might merge distinct turns, but for live it's usually ok.
                                    return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + newText }];
                                }
                                return [...prev, { role: 'assistant', content: newText }];
                            });
                        }
                        if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                            // Audio Response
                            const pcm24k = base64ToUint8Array(part.inlineData.data);
                            // Convert Uint8 (bytes) to Int16
                            const int16Path_24k = new Int16Array(pcm24k.buffer);
                            // Downsample to 16k for Simli
                            const int16Path_16k = downsampleTo16k(int16Path_24k);
                            
                            // Send to Simli
                            if (simliClientRef.current) {
                                simliClientRef.current.sendAudioData(new Uint8Array(int16Path_16k.buffer));
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error parsing Gemini message", e);
            }
        }
    };

    ws.onerror = (e) => {
        console.error("Gemini WebSocket Error", e);
        setError("Gemini Connection Error");
    };

    ws.onclose = () => {
        console.log("Gemini WebSocket Closed");
    };
  };

  const startAudioRecording = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
        streamRef.current = stream;
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
        
        const source = audioContextRef.current.createMediaStreamSource(stream);
        sourceRef.current = source;
        
        // Worklet would be better, but script processor is easier for single file
        const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            
            // Convert Float32 to Int16 PCM (Little Endian usually expected, or just raw bytes)
            // Gemini expects "audio/pcm;rate=16000" which is usually 16-bit LE.
            const int16Data = float32ToInt16(inputData);
            const buffer = int16Data.buffer;
            
            // Note: Sending too frequently can overwhelm the connection or cause small stuttering?
            // 4096 samples at 16k is ~256ms. This is fine.
            const base64Audio = arrayBufferToBase64(buffer);

            const msg = {
                realtime_input: {
                    media_chunks: [
                        {
                            mime_type: "audio/pcm;rate=16000",
                            data: base64Audio
                        }
                    ]
                }
            };
            wsRef.current.send(JSON.stringify(msg));
        };

        source.connect(processor);
        processor.connect(audioContextRef.current.destination); // Needed for Chrome to fire events, but mute it?
        
        // Workaround: Connect to a GainNode with gain 0, then to destination.
        const gainNode = audioContextRef.current.createGain();
        gainNode.gain.value = 0;
        processor.connect(gainNode);
        gainNode.connect(audioContextRef.current.destination);

    } catch (e) {
        console.error("Mic Error", e);
    }
  };

  useEffect(() => {
    if (hasInteracted) {
        initialize();
    }
    return () => {
        if (wsRef.current) wsRef.current.close();
        if (simliClientRef.current) simliClientRef.current.stop();
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') audioContextRef.current.close();
    };
  }, [hasInteracted]);

  return (
    <div className="flex bg-black items-center justify-center p-4 min-h-screen flex-col gap-4">
      {/* Container 512x512 */}
      <div className="relative w-[512px] h-[512px] bg-black overflow-hidden flex items-center justify-center border border-gray-800 rounded-lg shadow-xl">
        
        {/* Helper message if not started */}
        {!hasInteracted ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 text-white flex-col gap-4">
            <h2 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">Simli + Gemini Live</h2>
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
                {error ? <span className="text-red-400">{error}</span> : "Connecting to Simli & Gemini..."}
            </div>
        )}
      </div>

      {/* Chat History / Transcripts */}
        <div className="w-[512px] h-48 bg-gray-900 rounded-lg p-4 overflow-y-auto text-sm text-gray-300 border border-gray-800 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
            {chatHistory.length === 0 && <p className="text-gray-500 italic text-center text-xs mt-16">Conversation will appear here...</p>}
            {chatHistory.map((msg, idx) => (
                <div key={idx} className={`mb-2 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                    <span className={`inline-block px-3 py-2 rounded-lg max-w-[80%] ${
                        msg.role === 'user' 
                        ? 'bg-blue-900/50 text-blue-100 border border-blue-800' 
                        : 'bg-gray-800/80 text-gray-200 border border-gray-700'
                    }`}>
                        {msg.content}
                    </span>
                </div>
            ))}
        </div>
    </div>
  );
};

export default SimliLiveGemini;
