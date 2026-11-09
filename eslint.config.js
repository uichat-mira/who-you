import js from "@eslint/js";
import tseslint from "typescript-eslint";

const runtimeGlobals = {
	Buffer: "readonly",
	console: "readonly",
	crypto: "readonly",
	fetch: "readonly",
	process: "readonly",
	setInterval: "readonly",
	clearInterval: "readonly",
	setTimeout: "readonly",
	clearTimeout: "readonly",
	Response: "readonly",
	Request: "readonly",
	Headers: "readonly",
	ReadableStream: "readonly",
	TextEncoder: "readonly",
	TextDecoder: "readonly",
	URL: "readonly",
	URLSearchParams: "readonly",
	btoa: "readonly",
	atob: "readonly",
};

export default tseslint.config(
	{ ignores: ["dist/", "node_modules/"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: { ecmaVersion: 2024, sourceType: "module" },
			globals: {
				...runtimeGlobals,
				NodeJS: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: "module",
			globals: runtimeGlobals,
		},
	},
);
