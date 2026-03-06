class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const float32Data = input[0];
      const int16Data = new Int16Array(float32Data.length);
      
      for (let i = 0; i < float32Data.length; i++) {
        // 1. Precise Clipping: Ensure values stay between -1 and 1
        let s = Math.max(-1, Math.min(1, float32Data[i]));
        
        // 2. Consistent Scaling: 32767 is the standard for 16-bit PCM
        // Removing dither for now to ensure Alisa gets the "purest" signal
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      // Post the buffer. In the main thread, we will ensure Little-Endian.
      this.port.postMessage(int16Data.buffer);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);