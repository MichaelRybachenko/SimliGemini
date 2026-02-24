class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const float32Data = input[0];
      const int16Data = new Int16Array(float32Data.length);
      
      for (let i = 0; i < float32Data.length; i++) {
        // High-fidelity clipping and conversion
        let s = float32Data[i];
        s = Math.max(-1, Math.min(1, s));
        
        // Add a tiny bit of noise (dither) to smooth out the conversion
        const dither = (Math.random() * 2 - 1) / 32768;
        s += dither;
        
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16Data.buffer);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);