import { bindings, defineConfig, triggers } from "cf/config";

const APP_ID = "whoyou:911c7752-8b36-4f37-8a68-6f4a2e4559e8";

export default defineConfig({
  worker: {
    name: "who-you-tomz-preview",
    compatibilityDate: "2026-08-06",
    entrypoint: "./src/index.ts",
    env: {
      DB: bindings.d1({ name: "who-you-tomz-preview", id: "d1bea1ba-466c-414b-8988-99978678bd9f" }),
      MAIL_BUCKET: bindings.r2({ name: "who-you-tomz-preview-attachments" }),

      CLOUD_AUTH_ISSUER: bindings.text("https://cloud-auth.tomzlab.cn"),
      CLOUD_AUTH_JWKS_URL: bindings.text("https://cloud-auth.tomzlab.cn/.well-known/jwks.json"),
      MCP_RESOURCE_URL: bindings.text("https://who-you.tomz.io/mcp"),

      WHOYOU_APP_ID: bindings.text(APP_ID),
      WHOYOU_APP_SECRET: bindings.secret(),
      WHOYOU_MANIFEST_REVISION: bindings.text("1"),
      WHOYOU_WEB_SESSION_KEY: bindings.secret(),
      WHOYOU_OWNER_INITIAL_PASSWORD: bindings.secret(),

      GMAIL_OAUTH_CLIENT_ID: bindings.text("1045297918167-a0c8jjpbji34lhnf6i1chnbo17rvv9ab.apps.googleusercontent.com"),
      GMAIL_OAUTH_CLIENT_SECRET: bindings.secret(),
      GMAIL_OAUTH_REDIRECT_URI: bindings.text("https://who-you.tomz.io/mail/oauth/gmail/callback"),

      MAIL_CREDENTIAL_KEK: bindings.secret(),
      MAIL_CREDENTIAL_KEK_VERSION: bindings.text("1"),
      MAIL_SCHEDULE_SYNC_PROVIDERS: bindings.text("gmail"),
    },
    triggers: [
      triggers.scheduled({ schedule: "17 3 * * *" }),
      triggers.scheduled({ schedule: "*/5 * * * *" }),
    ],
  },
});
