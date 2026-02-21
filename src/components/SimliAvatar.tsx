import React, { useEffect, useRef, useState } from 'react';
import { SimliClient, LogLevel } from 'simli-client';
import { Mic, Send, Loader2, Volume2, VolumeX } from 'lucide-react';

const SimliAvatar: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [inputText, setInputText] = useState('');
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [isSimliReady, setIsSimliReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClient = useRef<SimliClient | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    let client: SimliClient | null = null;
    let isMounted = true;

    const initSimli = async () => {
      if (!videoRef.current || !audioRef.current) return;

      try {
        // Fetch token and ICE servers from backend
        const [sessionRes, iceRes] = await Promise.all([
          fetch('/api/simli/session'),
          fetch('/api/simli/ice')
        ]);

        if (!sessionRes.ok) {
          const errorData = await sessionRes.json().catch(() => ({}));
          throw new Error(errorData.error || `Session fetch failed: ${sessionRes.statusText}`);
        }
        if (!iceRes.ok) {
          const errorData = await iceRes.json().catch(() => ({}));
          throw new Error(errorData.error || `ICE fetch failed: ${iceRes.statusText}`);
        }

        const sessionData = await sessionRes.json();
        const iceServersResponse = await iceRes.json();

        console.log('Simli Session Data:', sessionData);
        console.log('Simli ICE Servers Response:', iceServersResponse);

        if (!sessionData.session_token) {
          throw new Error('Invalid session data: missing session_token');
        }

        if (!isMounted) return;

        // Use ICE servers from backend if available, otherwise fallback to Google STUN
        // Simli API returns an array of RTCIceServer objects
        let effectiveIceServers = iceServersResponse;
        if (!Array.isArray(effectiveIceServers) || effectiveIceServers.length === 0) {
          console.warn('No ICE servers from backend, using fallback STUN');
          effectiveIceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
        }

        console.log('Creating SimliClient with token:', sessionData.session_token);
        console.log('Using ICE Servers:', effectiveIceServers);
        
        // Use p2p transport with proper ICE servers (likely including TURN)
        client = new SimliClient(
          sessionData.session_token,
          videoRef.current,
          audioRef.current,
          effectiveIceServers,
          0, // LogLevel.DEBUG
          "p2p", // transport_mode
          "websockets", // signaling
          "wss://api.simli.ai", // SimliWSURL
          3000 // audioBufferSize
        );

        simliClient.current = client;

        // Start the client
        console.log('Starting SimliClient...');
        await client.start();
        console.log('SimliClient started');
        if (isMounted) setIsSimliReady(true);

      } catch (err: any) {
        console.error('Simli initialization error:', err);
        if (isMounted) {
          let errorMessage = err.message || err;
          if (typeof errorMessage === 'string' && errorMessage.includes('CONNECTION TIMED OUT')) {
            errorMessage = 'Connection timed out. Please check your network or firewall settings. (P2P)';
          }
          setError(`Simli Init Error: ${errorMessage}`);
        }
      }
    };

    initSimli();

    return () => {
      isMounted = false;
      if (client) {
        client.stop(); // Use stop() instead of close()
      }
    };
  }, []); // Run once on mount

  // ... (rest of the code)

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white">
      {/* ... (header) ... */}
      
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Avatar Section */}
        <div className="flex-1 relative bg-black flex items-center justify-center">
          {/* ... (video/audio) ... */}

          {!isSimliReady && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
              <div className="text-center p-6 max-w-md">
                <h2 className="text-xl font-bold mb-2">Initializing Avatar...</h2>
                <p className="text-gray-300 mb-4">
                  Connecting to Simli services. Please wait.
                </p>
                <div className="text-xs text-gray-500 font-mono mt-4 text-left bg-gray-900 p-2 rounded overflow-auto max-h-32">
                   <p>Check console for detailed logs.</p>
                </div>
              </div>
            </div>
          )}
          
          {error && (
             <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
               <div className="text-center p-6 max-w-lg">
                 <h2 className="text-xl font-bold mb-2 text-red-500">Initialization Failed</h2>
                 <p className="text-gray-300 mb-4">{error}</p>
                 <button 
                   onClick={() => window.location.reload()}
                   className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
                 >
                   Retry
                 </button>
               </div>
             </div>
          )}
        </div>

        {/* ... (chat section) ... */}


  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;

    const userMessage = inputText;
    setInputText('');
    setChatHistory((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);
    setError(null);

    try {
      // 1. Send message to backend to get text and audio from Gemini
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response from Gemini');
      }

      const data = await response.json();
      const { text, audio } = data;

      // 2. Add assistant response to chat
      setChatHistory((prev) => [...prev, { role: 'assistant', content: text }]);

      // 3. Send audio to Simli
      if (simliClient.current && audio) {
        // Convert base64 to Uint8Array
        const binaryString = window.atob(audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Decode audio data
        const audioContext = getAudioContext();
        const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
        
        // Get PCM data (Float32Array)
        const pcmData = audioBuffer.getChannelData(0);
        
        // Convert Float32 to Int16
        const pcmInt16 = new Int16Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
          const s = Math.max(-1, Math.min(1, pcmData[i]));
          pcmInt16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        simliClient.current.sendAudioData(pcmInt16);
      }
    } catch (err: any) {
      console.error('Error:', err);
      setError(err.message || 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      audioRef.current.muted = !audioRef.current.muted;
      setIsMuted(audioRef.current.muted);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="p-4 border-b border-gray-800 flex justify-between items-center">
        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          Simli AI Avatar
        </h1>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isSimliReady ? 'bg-green-500' : 'bg-yellow-500'}`} />
          <span className="text-sm text-gray-400">{isSimliReady ? 'Ready' : 'Initializing...'}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Avatar Section */}
        <div className="flex-1 relative bg-black flex items-center justify-center">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover"
          />
          <audio ref={audioRef} autoPlay />
          
          {/* Controls Overlay */}
          <div className="absolute bottom-4 right-4 flex gap-2">
            <button 
              onClick={toggleMute}
              className="p-2 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
            >
              {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
          </div>

          {!isSimliReady && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
              <div className="text-center p-6 max-w-md">
                <h2 className="text-xl font-bold mb-2">Initializing Avatar...</h2>
                <p className="text-gray-300 mb-4">
                  Connecting to Simli services. Please wait.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Chat Section */}
        <div className="w-full md:w-96 flex flex-col border-l border-gray-800 bg-gray-900">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatHistory.length === 0 && (
              <div className="text-center text-gray-500 mt-10">
                <p>Start a conversation with the avatar.</p>
              </div>
            )}
            {chatHistory.map((msg, idx) => (
              <div 
                key={idx} 
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div 
                  className={`max-w-[80%] p-3 rounded-lg ${
                    msg.role === 'user' 
                      ? 'bg-blue-600 text-white rounded-br-none' 
                      : 'bg-gray-800 text-gray-200 rounded-bl-none'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 p-3 rounded-lg rounded-bl-none flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm text-gray-400">Thinking...</span>
                </div>
              </div>
            )}
            {error && (
              <div className="p-3 bg-red-900/50 border border-red-800 rounded text-red-200 text-sm">
                {error}
              </div>
            )}
          </div>

          <div className="p-4 border-t border-gray-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder="Type a message..."
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500 transition-colors"
                disabled={isLoading || !isSimliReady}
              />
              <button
                onClick={handleSendMessage}
                disabled={isLoading || !inputText.trim() || !isSimliReady}
                className="p-2 bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={20} />
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default SimliAvatar;
