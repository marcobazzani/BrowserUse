// Injected into a claimed tab. Idempotent: re-running is a no-op.
(() => {
  if (document.querySelector('div[data-browseruse="overlay"]')) return;
  const host = document.createElement("div");
  host.setAttribute("data-browseruse", "overlay");
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      @keyframes browseruse-pulse {
        0%, 100% { box-shadow: inset 0 0 0 4px #FFB020, inset 0 0 24px rgba(255,140,0,0.35); }
        50%      { box-shadow: inset 0 0 0 4px #FF8C00, inset 0 0 32px rgba(255,140,0,0.55); }
      }
      .frame { position: fixed; inset: 0; pointer-events: none; animation: browseruse-pulse 2s ease-in-out infinite; }
      .pill {
        position: fixed; top: 12px; right: 12px; padding: 6px 12px;
        background: #FF8C00; color: white; border-radius: 9999px;
        font: 600 12px/1.2 system-ui, sans-serif; letter-spacing: 0.02em;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2); pointer-events: auto;
      }
    </style>
    <div class="frame"></div>
    <div class="pill" title="This tab is being controlled by Claude">Claude is using this tab</div>
  `;
  document.documentElement.appendChild(host);
})();
