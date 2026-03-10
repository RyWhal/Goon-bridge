/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        vibe: {
          bg: "#0a0a0f",
          surface: "#12121a",
          border: "#1e1e2e",
          dim: "#6b7280",
          text: "#e5e7eb",
          accent: "#8b5cf6",
          yea: "#22c55e",
          nay: "#ef4444",
          cosmic: "#f59e0b",
          money: "#a855f7",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"],
      },
    },
  },
  plugins: [],
};
