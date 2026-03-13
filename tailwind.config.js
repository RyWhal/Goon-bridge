/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        vibe: {
          bg: "rgb(var(--vibe-bg) / <alpha-value>)",
          surface: "rgb(var(--vibe-surface) / <alpha-value>)",
          border: "rgb(var(--vibe-border) / <alpha-value>)",
          dim: "rgb(var(--vibe-dim) / <alpha-value>)",
          text: "rgb(var(--vibe-text) / <alpha-value>)",
          accent: "rgb(var(--vibe-accent) / <alpha-value>)",
          yea: "rgb(var(--vibe-yea) / <alpha-value>)",
          nay: "rgb(var(--vibe-nay) / <alpha-value>)",
          cosmic: "rgb(var(--vibe-cosmic) / <alpha-value>)",
          money: "rgb(var(--vibe-money) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"],
      },
    },
  },
  plugins: [],
};
