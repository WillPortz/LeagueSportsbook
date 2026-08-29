const fs = require("fs");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const script = html.match(/<script>\n([\s\S]*)\n  <\/script>/)[1];

global.React = {
  createElement(type, props, ...children) {
    if (typeof type === "function") {
      try {
        return type(props || {});
      } catch (e) {
        console.error("RENDER ERROR in", type.name || "component", e.message);
        console.error(e.stack.split("\n").slice(0, 12).join("\n"));
        throw e;
      }
    }
    return { type, props, children };
  },
  useState(init) {
    const v = typeof init === "function" ? init() : init;
    return [v, () => {}];
  },
  useMemo(fn) { return fn(); },
  useEffect() {},
  useCallback(fn) { return fn; },
  Fragment: "fragment",
};

global.ReactDOM = {
  createRoot() {
    return {
      render(el) {
        if (typeof el?.type === "function") el.type(el.props || {});
        else if (typeof el === "function") el();
      },
    };
  },
};

global.document = { getElementById: () => ({}) };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window = global;
global.confirm = () => true;
global.alert = () => {};

try {
  eval(script);
  console.log("OK - no throw during mount");
} catch (e) {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
}
