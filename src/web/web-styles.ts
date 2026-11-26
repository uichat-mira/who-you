// Shared server-rendered Web styles. Colors and reusable values live in design-tokens.ts.
import { designTokensCss } from "./design-tokens";

export const webStylesCss = `
${designTokensCss}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:var(--weight-normal) var(--text-base)/var(--leading-normal) var(--font-sans)}
main{min-height:100vh}.page-auth .content{max-width:var(--reading-width);margin:auto}.page-app .content,.page-app .appnav{max-width:var(--workspace-width);margin:auto}.page-app .content{padding-block:var(--space-10)}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);max-width:var(--site-width);margin:auto;padding:var(--space-6) var(--gutter)}
.brand{display:inline-flex;align-items:center;min-width:0;max-width:100%;text-decoration:none}.brand img{display:block;height:var(--brand-logo-height);width:auto;max-width:100%;object-fit:contain}.brand:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
.session-mark{font-size:var(--text-xs);color:var(--success);background:var(--success-bg);border:1px solid var(--success-border);border-radius:var(--radius-pill);padding:3px 9px}
.appnav{display:flex;gap:var(--space-1);padding:0 20px 10px;border-bottom:1px solid var(--border)}.appnav a{color:var(--foreground-secondary);text-decoration:none;padding:7px 10px;border-radius:var(--radius-md)}
.appnav a[aria-current="page"]{color:var(--foreground);background:var(--surface-subtle);font-weight:var(--weight-semibold)}
.content{padding:var(--gutter)}.content.auth{padding-block:var(--space-10)}.page-home .content{padding:0}
h1{font:var(--weight-bold) var(--text-title)/var(--leading-tight) var(--font-sans);margin:0 0 10px}h2{font-size:var(--text-section);margin:28px 0 10px}p{color:var(--foreground-secondary);margin:8px 0 14px}.lead{font-size:var(--text-lead);max-width:44ch}.eyebrow{font-size:var(--text-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--foreground-muted);margin:0 0 12px}
a{color:var(--link)}.button,button{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);min-height:var(--control-height);border-radius:var(--radius-md);padding:10px 18px;border:var(--stroke-control) solid var(--ink-outline);background:var(--primary);color:var(--primary-foreground);text-decoration:none;font:inherit;font-weight:var(--weight-bold);cursor:pointer;box-shadow:var(--shadow-control);transition:transform 120ms ease,box-shadow 120ms ease,background-color 120ms ease;text-align:center}
.button.secondary{background:var(--surface);color:var(--foreground)}
.button:focus-visible,button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--focus-ring);outline-offset:4px}
.button:not(.secondary):hover,button:not(.secondary):not([disabled]):hover{background:var(--primary-hover)}
.button.secondary:hover:not([disabled]){background:var(--surface-subtle)}
.button:hover,button:not([disabled]):hover{transform:translate(2px,2px);box-shadow:var(--shadow-control-hover)}
.button:active,button:not([disabled]):active{transform:translate(4px,4px);box-shadow:none}
button[disabled]{background:var(--disabled-bg);border-color:var(--border-strong);color:var(--disabled-fg);cursor:not-allowed;box-shadow:none}
input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,textarea{font:inherit;color:var(--foreground);background:var(--surface);border:var(--stroke-control) solid var(--ink-outline);border-radius:var(--radius-md);min-height:var(--control-height);padding:var(--space-2) var(--space-3);max-width:100%}
@media(prefers-reduced-motion:reduce){.button,button{transition:none}}
.auth-actions{margin:22px 0 14px}.footnote{font-size:var(--text-sm);color:var(--foreground-muted);max-width:50ch}
.settings{border-top:1px solid var(--border);margin-top:22px}.setting-row{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:18px 0;border-bottom:1px solid var(--border)}
.setting-row strong{font-size:var(--text-base)}.setting-row p{margin:4px 0 0}.setting-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:var(--space-5)}.setting-actions form{margin:0}
code{overflow-wrap:anywhere;font-family:var(--font-mono);font-size:var(--text-sm);background:var(--surface-subtle);padding:2px 5px;border-radius:var(--radius-sm)}
.mailboxes,.providers{list-style:none;margin:0;padding:0}.mailbox,.providers li{border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;margin:0 0 10px}
.address{overflow-wrap:anywhere;margin:0 0 6px}.meta{margin:0 0 6px;color:var(--foreground-secondary)}.hint{color:var(--foreground-muted);font-size:var(--text-sm);margin:4px 0 0}
.pill{display:inline-block;border:1px solid currentColor;border-radius:var(--radius-pill);padding:1px 9px;font-size:var(--text-xs);line-height:1.55;white-space:nowrap}.pill.ok{color:var(--success)}.pill.warn{color:var(--warning)}.pill.bad{color:var(--danger)}.pill.muted{color:var(--foreground-muted)}
.notice{background:var(--surface-subtle);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px;margin:var(--space-4) 0}.notice p:last-child{margin-bottom:0}.notice.error{background:var(--danger-bg);border-color:var(--danger-border)}.notice.auth-required{background:var(--primary-soft);border-color:var(--primary-border)}
.inline-actions{display:flex;gap:14px;flex-wrap:wrap}.inline-actions a{text-decoration:none;font-weight:var(--weight-semibold)}
.mailbox-actions{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)}.mailbox-actions form{margin:0}
.notice.ok{background:var(--success-bg);border-color:var(--success-border)}
.public-intro{border-top:1px solid var(--border);margin-top:26px;padding-top:var(--space-1)}.public-intro h2,.legal h2{margin-top:22px}.legal p,.legal li,.public-intro p{overflow-wrap:anywhere}.legal ul{padding-left:1.3em}.public-footer{border-top:1px solid var(--border);padding:var(--space-4) var(--space-5);text-align:center;font-size:var(--text-sm);color:var(--foreground-muted)}.public-footer a{color:var(--foreground-muted);margin:0 7px;text-decoration:underline;text-underline-offset:3px}

.site-nav{display:flex;align-items:center;gap:var(--space-5);flex-wrap:wrap;justify-content:flex-end}
.site-nav a:not(.button){color:var(--foreground);font-weight:var(--weight-semibold);text-decoration:none}
.site-nav a:not(.button):hover{text-decoration:underline;text-underline-offset:4px}
.site-nav .button{min-height:40px;padding:6px 16px}
.hero{max-width:var(--site-width);margin:auto;padding:var(--section-space) var(--gutter);display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);align-items:center;gap:clamp(32px,6vw,88px)}
.hero-copy{min-width:0}
.brand-ruby{ruby-position:over;ruby-align:center;white-space:nowrap}.brand-ruby rt{font-size:.25em;line-height:1.25;font-weight:var(--weight-bold);letter-spacing:.06em;color:var(--link);text-align:center;padding-bottom:.30em}
.hero h1{font-size:var(--text-display);line-height:1.14;letter-spacing:-.055em;margin:0 0 var(--space-6);font-weight:var(--weight-bold)}
.hero .lead{font-size:var(--text-hero-lead);line-height:1.7;max-width:34ch}
.hero .auth-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-5);margin:var(--space-8) 0 var(--space-6)}
.hero .auth-actions .button{min-height:56px;padding-inline:var(--space-6)}
.hero .footnote{font-size:var(--text-sm);max-width:44ch}
.hero-poster{position:relative;isolation:isolate;display:flex;flex-direction:column;justify-content:space-between;align-items:center;min-height:390px;aspect-ratio:1.03;background:var(--foreground);color:var(--on-dark);border:var(--stroke-control) solid var(--ink-outline);border-radius:var(--radius-xl);box-shadow:var(--shadow-poster);padding:var(--space-6);overflow:hidden}
.poster-top,.poster-bottom{align-self:stretch;display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);position:relative;z-index:1;font-size:var(--text-xs);font-weight:var(--weight-bold);letter-spacing:.11em}
.poster-top span:last-child,.poster-bottom span:last-child{color:var(--on-dark-muted)}
.poster-orbit{position:absolute;z-index:-1;left:50%;top:50%;width:78%;aspect-ratio:1;border:1px dashed var(--on-dark-muted);border-radius:50%;transform:translate(-50%,-50%);opacity:.42}
.poster-orbit:after{content:"";position:absolute;inset:10%;border:1px solid var(--on-dark-muted);border-radius:50%;opacity:.45}
.poster-mark{display:block;width:min(78%,350px);height:auto;object-fit:contain;filter:drop-shadow(0 12px 12px rgb(0 0 0 / 18%));position:relative;z-index:1}
.poster-dot{position:absolute;width:14px;height:14px;background:var(--primary);border-radius:50%;top:25%;right:17%}
.capabilities{background:var(--foreground);color:var(--on-dark)}
.capabilities-inner{max-width:var(--site-width);margin:auto;padding:var(--space-10) var(--gutter);display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-8)}
.capability{display:grid;grid-template-columns:auto 1fr;align-items:start;gap:var(--space-3)}
.web-icon{display:inline-block;width:1.25em;height:1.25em;flex:none;vertical-align:middle}
.capability-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;color:var(--primary);border:var(--stroke-control) solid currentColor;border-radius:var(--radius-md)}
.capability-icon .web-icon{width:30px;height:30px}
.intro-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:var(--space-4);color:var(--foreground);background:var(--primary-soft);border:var(--stroke-control) solid var(--ink-outline);border-radius:var(--radius-md);box-shadow:var(--shadow-control)}
.intro-icon .web-icon{width:26px;height:26px}
.capability h2{color:var(--on-dark);font-size:var(--text-section);margin:0 0 var(--space-2)}
.capability p{color:var(--on-dark-muted);margin:0;font-size:var(--text-base)}
.page-home .public-intro{max-width:var(--site-width);margin:auto;padding:var(--section-space) var(--gutter);border:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-8) clamp(32px,7vw,100px)}
.page-home .public-intro h2{font-size:clamp(1.4rem,2.5vw,2rem);margin:0 0 var(--space-4)}
.page-home .public-intro p{max-width:65ch}
.page-home .public-intro .disclosure-links{grid-column:1/-1;margin:0}
.public-footer{max-width:var(--site-width);margin:auto;padding:var(--space-6) var(--gutter)}
@media(max-width:800px){.hero{grid-template-columns:1fr;gap:var(--space-8)}.hero-poster{min-height:0;aspect-ratio:1.45;max-width:580px;width:calc(100% - 8px);justify-self:center}.poster-mark{width:min(54%,280px)}.capabilities-inner{grid-template-columns:1fr;gap:var(--space-5)}.page-home .public-intro{grid-template-columns:1fr}.page-home .public-intro .disclosure-links{grid-column:auto}}
@media(max-width:480px){.brandbar{gap:var(--space-2);padding-block:var(--space-4)}.brand img{height:34px}.site-nav{gap:var(--space-2)}.site-nav a:not(.button){display:none}.site-nav .button{min-height:36px;padding:5px 12px}.hero{padding-top:var(--space-8)}.hero h1{font-size:clamp(2.3rem,10vw,3.2rem)}.hero-poster{aspect-ratio:1.1;padding:var(--space-4)}.poster-mark{width:65%}.poster-top,.poster-bottom{font-size:var(--text-xs)}.content{padding-inline:var(--space-5)}.setting-row{gap:var(--space-2)}}

.error-page{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.72fr);align-items:center;gap:var(--space-10);padding-block:var(--space-8)}
.page-auth .content:has(.error-page){max-width:var(--workspace-width)}
.error-copy .eyebrow{color:var(--link);font-weight:var(--weight-bold);letter-spacing:.12em}
.error-copy h1{font-size:clamp(2rem,4vw,3.5rem);letter-spacing:-.035em}
.error-copy .auth-actions{display:flex;gap:var(--space-4);flex-wrap:wrap}
.error-art{display:flex;align-items:center;justify-content:center;min-width:0;color:var(--ink-outline);padding:var(--space-3)}
.error-illustration{display:block;width:100%;max-width:420px;height:auto;overflow:visible}
.error-illustration .art-ink{fill:var(--ink-outline)}
.error-illustration .art-paper{fill:var(--surface)}
.error-illustration .art-orange{fill:var(--primary)}
.error-illustration .art-accent-line{stroke:var(--primary)}
.notice-heading{display:flex;align-items:center;gap:var(--space-2);color:var(--danger)}
@media(max-width:680px){.error-page{grid-template-columns:1fr;gap:var(--space-8);padding-block:var(--space-4)}.error-art{max-width:360px;width:100%;justify-self:center}}

.mira-feature{background:var(--primary);color:var(--foreground)}
.mira-feature-inner{max-width:var(--site-width);margin:auto;padding:var(--section-space) var(--gutter);display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);align-items:center;gap:clamp(32px,7vw,96px)}
.mira-feature-brand{display:flex;flex-direction:column;align-items:flex-start}
.mira-feature-kicker{font-size:var(--text-sm);font-weight:var(--weight-bold);letter-spacing:.14em}
.mira-feature-wordmark{font-size:clamp(4rem,10vw,8.5rem);font-weight:var(--weight-bold);letter-spacing:-.075em;line-height:.95;margin-block:var(--space-4)}
.mira-feature-wordmark span{color:var(--on-dark)}
.mira-feature-signature{font-weight:var(--weight-semibold)}
.mira-feature-copy h2{font-size:clamp(1.6rem,3vw,2.65rem);letter-spacing:-.035em;line-height:var(--leading-tight);margin:0 0 var(--space-4)}
.mira-feature-copy p{color:var(--foreground);max-width:44ch;font-size:var(--text-lead)}
.mira-feature-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-6);margin-top:var(--space-6)}
.mira-source{display:inline-flex;align-items:center;gap:var(--space-1);color:var(--foreground);font-weight:var(--weight-semibold);text-underline-offset:4px}
@media(max-width:720px){.mira-feature-inner{grid-template-columns:1fr;gap:var(--space-6)}}

.account-identity{display:flex;align-items:flex-start;gap:var(--space-3);min-width:0}
.account-avatar{display:block;flex:none;width:var(--control-height);height:var(--control-height);object-fit:contain}
.account-identity code{overflow-wrap:anywhere}
.instance-details{margin-top:var(--space-10);border-top:1px solid var(--border);padding-top:var(--space-4)}
.instance-details summary{cursor:pointer;font-weight:var(--weight-semibold);color:var(--foreground)}
.instance-content{padding-block:var(--space-3)}
.instance-fields{margin:var(--space-4) 0;display:grid;gap:var(--space-3)}
.instance-fields div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:var(--space-3)}
.instance-fields dt{color:var(--foreground-secondary)}.instance-fields dd{margin:0;overflow-wrap:anywhere;user-select:text}
@media(max-width:520px){.instance-fields div{grid-template-columns:1fr;gap:var(--space-1)}.setting-row{flex-wrap:wrap}}
`;
