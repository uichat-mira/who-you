import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/", ".cloudflare/", "node_modules/"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: { ecmaVersion: 2024, sourceType: "module" },
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
			globals: { URL: "readonly", console: "readonly", process: "readonly" },
		},
	},
);
