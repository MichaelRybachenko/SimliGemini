/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      keyframes: {
        'ai-glow': {
          '0%, 100%': { 
            'box-shadow': '0 0 20px 2px rgba(59, 130, 246, 0.5)', 
            'border-color': 'rgba(59, 130, 246, 0.5)' 
          },
          '50%': { 
            'box-shadow': '0 0 40px 10px rgba(139, 92, 246, 0.8)', 
            'border-color': 'rgba(139, 92, 246, 0.8)' 
          },
        },
      },
      animation: {
        'ai-pulse': 'ai-glow 2s ease-in-out infinite',
      },
      fontFamily: {
        mono: ['"Space Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
