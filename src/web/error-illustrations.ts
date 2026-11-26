// Original editorial illustrations, not the brand mark or generic UI icons.
// Shared palette uses runtime design tokens; each scene has its own silhouette.
const scenes = {
  lost: `
    <path d="M38 195C10 164 31 113 73 122S116 201 159 183 173 137 190 119" fill="none" stroke-dasharray="6 10" stroke-width="3"/>
    <g transform="translate(138 28) rotate(-12 78 56)">
      <rect x="8" y="8" width="150" height="94" rx="12" class="art-ink"/>
      <rect width="150" height="94" rx="12" class="art-paper"/>
      <path d="m5 7 70 53 70-53" class="art-orange"/>
      <path d="m5 87 49-39m91 39-49-39" fill="none"/>
    </g>
    <path d="M217 140v36m-15-18h30M64 44v24m-12-12h24" stroke-width="3"/>
    <circle cx="90" cy="181" r="6" class="art-orange"/>
    <path d="M37 222h76m128 0h28" stroke-width="3"/>
    <path d="M244 169c0-22 35-22 35 0 0 15-17 13-17 28" fill="none" stroke-width="8"/>
    <circle cx="262" cy="213" r="4" class="art-ink" stroke="none"/>
  `,
  locked: `
    <g transform="translate(46 45) rotate(-7 91 75)">
      <rect x="8" y="8" width="182" height="122" rx="12" class="art-ink"/>
      <rect width="182" height="122" rx="12" class="art-paper"/>
      <path d="m5 8 86 60 86-60" class="art-orange"/>
      <path d="m5 115 55-45m117 45-55-45" fill="none"/>
    </g>
    <g transform="translate(176 114)">
      <path d="M20 43V25a27 27 0 0 1 54 0v18" fill="none" stroke-width="13"/>
      <rect x="8" y="45" width="94" height="70" rx="13" class="art-ink"/>
      <rect y="37" width="94" height="70" rx="13" class="art-orange"/>
      <circle cx="47" cy="65" r="8" class="art-ink"/>
      <path d="M47 72v13" stroke-width="7"/>
    </g>
    <path d="M39 32v21M29 42h20m233 51v22m-11-11h22" stroke-width="3"/>
  `,
  expired: `
    <g transform="translate(40 29) rotate(-8 90 80)">
      <rect x="8" y="8" width="174" height="150" rx="13" class="art-ink"/>
      <rect width="174" height="150" rx="13" class="art-paper"/>
      <path d="M0 36h174" fill="none"/>
      <circle cx="18" cy="18" r="4" class="art-orange"/><circle cx="33" cy="18" r="4" class="art-orange"/>
      <circle cx="52" cy="77" r="18" class="art-orange"/>
      <path d="M26 126c0-28 52-28 52 0m24-56h46m-46 19h36" fill="none" stroke-width="4"/>
    </g>
    <circle cx="232" cy="160" r="55" class="art-ink"/>
    <circle cx="224" cy="152" r="55" class="art-orange"/>
    <circle cx="224" cy="152" r="42" class="art-paper"/>
    <path d="M224 121v31l20 13" fill="none" stroke-width="6"/>
    <path d="M267 77v20m-10-10h20M25 199l14 14m0-14-14 14" stroke-width="3"/>
  `,
  disconnected: `
    <g transform="translate(23 57)">
      <rect x="7" y="7" width="122" height="90" rx="10" class="art-ink"/>
      <rect width="122" height="90" rx="10" class="art-paper"/>
      <path d="m5 6 56 43 56-43" class="art-orange"/>
      <path d="m5 84 37-35m75 35L80 49" fill="none"/>
    </g>
    <path d="M145 101h23q12 0 12 12v16q0 12 12 12h7m-6-16v32m14-24h14m-14 16h14" fill="none" stroke-width="5"/>
    <g transform="translate(224 108)">
      <rect x="7" y="7" width="56" height="68" rx="12" class="art-ink"/>
      <rect width="56" height="68" rx="12" class="art-orange"/>
      <path d="M28 68v30q0 15-15 15H-8" fill="none" stroke-width="5"/>
      <path d="M14 20h28m-28 13h28" fill="none"/>
    </g>
    <path d="m188 61-10 19m37-16-18 17m39 5-22 6" class="art-accent-line" stroke-width="5"/>
    <path d="M48 190h89m-65 14h46" stroke-width="3" stroke-dasharray="6 7"/>
  `,
  invalid: `
    <g transform="translate(75 26) rotate(8 75 89)">
      <rect x="8" y="8" width="150" height="177" rx="12" class="art-ink"/>
      <path d="M0 12Q0 0 12 0h100l38 38v127q0 12-12 12H12Q0 177 0 165Z" class="art-paper"/>
      <path d="M112 0v38h38" class="art-orange"/>
      <path d="M23 58h75M23 81h100M23 104h84M23 127h49" fill="none" stroke-width="4"/>
    </g>
    <circle cx="242" cy="174" r="42" class="art-ink"/>
    <circle cx="236" cy="168" r="42" class="art-orange"/>
    <path d="M236 145v26" stroke-width="8"/><circle cx="236" cy="185" r="4" class="art-ink"/>
    <path d="M36 57v22M25 68h22m12 132 13 13m0-13-13 13" stroke-width="3"/>
  `,
  repair: `
    <g transform="translate(38 46)">
      <rect x="8" y="8" width="184" height="138" rx="13" class="art-ink"/>
      <rect width="184" height="138" rx="13" class="art-paper"/>
      <rect x="15" y="15" width="154" height="45" rx="6" class="art-orange"/>
      <rect x="15" y="76" width="154" height="45" rx="6" class="art-paper"/>
      <circle cx="35" cy="37" r="5" class="art-ink"/><circle cx="35" cy="98" r="5" class="art-orange"/>
      <path d="M59 37h85M59 98h55" stroke-width="4"/>
      <path d="M28 138v12m128-12v12" stroke-width="7"/>
    </g>
    <g transform="translate(171 117) rotate(-32 49 48)">
      <path d="M37 44C10 35 10 5 32 1l2 22 18 9 19-12L66 0c25 3 33 36 10 50L72 105q0 14-14 14t-14-14Z" class="art-ink" transform="translate(6 6)"/>
      <path d="M37 44C10 35 10 5 32 1l2 22 18 9 19-12L66 0c25 3 33 36 10 50L72 105q0 14-14 14t-14-14Z" class="art-orange"/>
      <circle cx="58" cy="103" r="4" class="art-paper"/>
    </g>
    <path d="M255 33v24m-12-12h24m-37 38 13 13m0-13-13 13" stroke-width="3"/>
  `,
  paused: `
    <g transform="translate(40 75)">
      <rect x="8" y="8" width="223" height="98" rx="14" class="art-ink"/>
      <rect width="223" height="98" rx="14" class="art-paper"/>
      <rect x="16" y="17" width="191" height="64" rx="8" class="art-orange"/>
      <path d="M24 73 74 24m2 49 50-49m2 49 50-49m2 49 20-20" stroke-width="9"/>
      <path d="M38 98v36m147-36v36M19 134h38m109 0h38" stroke-width="7"/>
    </g>
    <g transform="translate(118 7)">
      <path d="M8 51 30 4h24l22 47Z" class="art-ink"/>
      <path d="M0 45 22-2h24l22 47Z" class="art-orange"/>
      <path d="M34 10v14m0 9v2" stroke-width="5"/>
    </g>
    <path d="M24 36v22M13 47h22m249 150v24m-12-12h24" stroke-width="3"/>
  `,
  signedOut: `
    <g transform="translate(56 27)">
      <rect x="8" y="8" width="135" height="178" rx="10" class="art-ink"/>
      <rect width="135" height="178" rx="10" class="art-paper"/>
      <path d="M19 22h92v134H19Z" class="art-orange"/>
      <path d="M19 22 91 45v111l-72 22Z" class="art-paper"/>
      <circle cx="75" cy="107" r="5" class="art-ink"/>
    </g>
    <path d="M166 111h90m-27-27 27 27-27 27" fill="none" stroke-width="9"/>
    <path d="M241 41v23m-11-11h22m-20 122 13 13m0-13-13 13" stroke-width="3"/>
  `,
} as const;

type Scene = keyof typeof scenes;
function sceneFor(status: number, code: string): Scene {
  if (code === "logout_unconfirmed") return "signedOut";
  if (code === "invalid_state" || code === "provider_reauth_required") return "disconnected";
  if (code === "login_incomplete" || code === "cloud_auth_code_rejected" ||
      code === "authentication_link_unavailable" || status === 401) return "expired";
  if (status === 404) return "lost";
  if (status === 403) return "locked";
  if (status === 503) return "paused";
  if (status >= 500) return "repair";
  return "invalid";
}

export function errorIllustration(status: number, code: string): string {
  const scene = sceneFor(status, code);
  return `<svg class="error-illustration" data-scene="${scene}" viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${scenes[scene]}</svg>`;
}
