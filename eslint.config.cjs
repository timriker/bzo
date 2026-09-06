const js = require("@eslint/js");

const sharedGlobals = {
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  Math: "readonly",
  JSON: "readonly",
  Date: "readonly",
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "public/obj/**",
      "server.log",
    ],
  },
  js.configs.recommended,
  {
    files: ["server.js", "server/**/*.cjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...sharedGlobals,
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        global: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },
  {
    files: ["public/**/*.js", "public/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...sharedGlobals,
        Blob: "readonly",
        DeviceOrientationEvent: "readonly",
        document: "readonly",
        Element: "readonly",
        fetch: "readonly",
        FileReader: "readonly",
        FormData: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        screen: "readonly",
        sessionStorage: "readonly",
        URLSearchParams: "readonly",
        window: "readonly",
        WebSocket: "readonly",
      },
    },
  },
  {
    // Service worker: a classic worker script, not an ES module.
    files: ["public/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        caches: "readonly",
        self: "readonly",
      },
    },
  },
];
