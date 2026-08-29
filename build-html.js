const fs = require("fs");
const path = require("path");

const dir = __dirname;

async function loadBabel() {
  const res = await fetch("https://unpkg.com/@babel/standalone@7.26.9/babel.min.js");
  if (!res.ok) throw new Error("Failed to download Babel");
  const code = await res.text();
  const getBabel = new Function(`${code}; return Babel;`);
  return getBabel();
}

function readComponentSource() {
  const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  let jsx = fs.readFileSync(path.join(dir, "league-sportsbook.jsx"), "utf8");
  return jsx
    .replace(/^import React, \{[^}]+\} from "react";\r?\n/, "")
    .replace(/^import \{[\s\S]*?\} from "lucide-react";\r?\n\r?\n/, "")
    .replace('const BUILD_STAMP = "DEV";', `const BUILD_STAMP = "${buildStamp}";`)
    .replace("export default function LeagueSportsbook", "function LeagueSportsbook");
}

const iconShim = `const { useState, useMemo, useEffect, useCallback } = React;

function Icon({ children, size = 16, color = "currentColor", style }) {
  return React.createElement("svg", {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color,
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style,
  }, children);
}
const Check = (p) => React.createElement(Icon, p, React.createElement("polyline", { points: "20 6 9 17 4 12" }));
const X = (p) => React.createElement(Icon, p, React.createElement("path", { d: "M18 6 6 18" }), React.createElement("path", { d: "m6 6 12 12" }));
const Lock = (p) => React.createElement(Icon, p, React.createElement("rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }), React.createElement("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }));
const Trophy = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6" }),
  React.createElement("path", { d: "M18 9h1.5a2.5 2.5 0 0 0 0-5H18" }),
  React.createElement("path", { d: "M4 22h16" }),
  React.createElement("path", { d: "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22" }),
  React.createElement("path", { d: "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22" }),
  React.createElement("path", { d: "M18 2H6v7a6 6 0 0 0 12 0V2Z" })
);
const Plus = (p) => React.createElement(Icon, p, React.createElement("path", { d: "M5 12h14" }), React.createElement("path", { d: "M12 5v14" }));
const ChevronLeft = (p) => React.createElement(Icon, p, React.createElement("path", { d: "m15 18-6-6 6-6" }));
const ChevronRight = (p) => React.createElement(Icon, p, React.createElement("path", { d: "m9 18 6-6-6-6" }));
const Users = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }),
  React.createElement("circle", { cx: 9, cy: 7, r: 4 }),
  React.createElement("path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }),
  React.createElement("path", { d: "M16 3.13a4 4 0 0 1 0 7.75" })
);
const ScrollText = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M15 12h-5" }),
  React.createElement("path", { d: "M15 8h-5" }),
  React.createElement("path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }),
  React.createElement("path", { d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" })
);
const Zap = (p) => React.createElement(Icon, p, React.createElement("path", { d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" }));
const RefreshCw = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
  React.createElement("path", { d: "M21 3v5h-5" }),
  React.createElement("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
  React.createElement("path", { d: "M8 16H3v5" })
);
const Link2 = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M9 17H7A5 5 0 0 1 7 7h2" }),
  React.createElement("path", { d: "M15 7h2a5 5 0 1 1 0 10h-2" }),
  React.createElement("line", { x1: 8, x2: 16, y1: 12, y2: 12 })
);
const AlertTriangle = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }),
  React.createElement("path", { d: "M12 9v4" }),
  React.createElement("path", { d: "M12 17h.01" })
);
const CalendarDays = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M8 2v4" }),
  React.createElement("path", { d: "M16 2v4" }),
  React.createElement("rect", { width: 18, height: 18, x: 3, y: 4, rx: 2 }),
  React.createElement("path", { d: "M3 10h18" }),
  React.createElement("path", { d: "M8 14h.01" }),
  React.createElement("path", { d: "M12 14h.01" }),
  React.createElement("path", { d: "M16 14h.01" }),
  React.createElement("path", { d: "M8 18h.01" }),
  React.createElement("path", { d: "M12 18h.01" }),
  React.createElement("path", { d: "M16 18h.01" })
);
const TrendingUp = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "M16 7h6v6" }),
  React.createElement("path", { d: "m22 7-8.5 8.5-5-5L2 17" })
);
const Swords = (p) => React.createElement(Icon, p,
  React.createElement("path", { d: "m14.5 17.5 3 3" }),
  React.createElement("path", { d: "m11 13-6 6" }),
  React.createElement("path", { d: "m21 3-2.5 2.5" }),
  React.createElement("path", { d: "M3 21 8 16" }),
  React.createElement("path", { d: "m14 4 6 6" }),
  React.createElement("path", { d: "m9.5 6.5 2 2" })
);

`;

async function main() {
  console.log("Downloading Babel...");
  const Babel = await loadBabel();

  const source = iconShim + readComponentSource() + `

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(LeagueSportsbook));
`;

  console.log("Compiling JSX...");
  const { code } = Babel.transform(source, {
    presets: ["react"],
    filename: "preview.jsx",
  });

  const buildId = new Date().toISOString();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <meta http-equiv="Pragma" content="no-cache" />
  <meta http-equiv="Expires" content="0" />
  <title>League Sportsbook</title>
  <!-- build: ${buildId} -->
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { margin: 0; min-height: 100%; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-between { justify-content: space-between; }
    .flex-wrap { flex-wrap: wrap; }
    .gap-2 { gap: 0.5rem; }
    .gap-3 { gap: 0.75rem; }
  </style>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script>
${code}
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, "index.html"), html);
  console.log("Wrote index.html (" + html.length + " bytes)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
