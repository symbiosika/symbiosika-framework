/**
 * Default HTML views for the OAuth2 login/consent flow.
 *
 * These are intentionally minimal and self-contained. Apps can override each
 * one via `defineServer({ oauth2: { views: { login, consent, tenantSelect } } })`
 * — analogous to how `emailTemplates` are overridden — or replace them entirely
 * with their own static pages.
 *
 * The login default uses a tiny bit of inline JS to drive the JSON endpoints
 * (`/oauth/login/start`, `/oauth/login/verify`) and then continues the flow by
 * navigating back to `/oauth/authorize`. Email-code is the default method;
 * password and passkey are manual alternatives the user chooses.
 */

export type OAuthViewData = {
  appName: string;
  logoUrl?: string;
  /** The original /oauth/authorize query string (without leading "?"). */
  authorizeQuery: string;
};

export type ConsentViewData = OAuthViewData & {
  clientName: string;
  scopes: string[];
};

export type TenantSelectViewData = OAuthViewData & {
  tenants: { id: string; name: string }[];
};

export type OAuthViews = {
  login: (data: OAuthViewData) => string;
  consent: (data: ConsentViewData) => string;
  tenantSelect: (data: TenantSelectViewData) => string;
};

const shell = (appName: string, logoUrl: string | undefined, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${appName}</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;background:#f4f4f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;max-width:380px;width:100%;padding:32px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:20px;margin:0 0 4px} p{color:#555;font-size:14px}
  input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border:1px solid #ddd;border-radius:8px;font-size:15px}
  button{width:100%;padding:11px;border:0;border-radius:8px;background:#a7476f;color:#fff;font-size:15px;cursor:pointer;margin-top:8px}
  button.secondary{background:#fff;color:#a7476f;border:1px solid #a7476f}
  .row{display:flex;gap:8px} .muted{color:#888;font-size:13px;text-align:center;margin-top:12px}
  .scopes{background:#faf7f8;border-radius:8px;padding:12px;margin:12px 0} .scopes li{font-size:14px}
  .hidden{display:none} .err{color:#b91c1c;font-size:13px;min-height:16px}
  .logo{max-height:48px;margin-bottom:12px}
</style></head><body><div class="card">
${logoUrl ? `<img class="logo" src="${logoUrl}" alt="${appName}"/>` : ""}
${body}
</div></body></html>`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const defaultLoginView = (d: OAuthViewData): string => {
  const q = esc(d.authorizeQuery);
  const body = `
  <h1>Sign in to ${esc(d.appName)}</h1>
  <p>Enter your email to receive a login code.</p>
  <div id="step-email">
    <input id="email" type="email" placeholder="you@example.com" autocomplete="email"/>
    <button onclick="startLogin()">Send code</button>
    <button class="secondary" onclick="togglePassword()">Use password instead</button>
    <p class="muted"><a href="#" onclick="usePasskey();return false">Use a passkey</a></p>
  </div>
  <div id="step-code" class="hidden">
    <p>We sent a 6-digit code to <span id="email-label"></span>.</p>
    <input id="code" inputmode="numeric" maxlength="6" placeholder="123456"/>
    <button onclick="verifyCode()">Continue</button>
  </div>
  <div id="step-password" class="hidden">
    <input id="pw-email" type="email" placeholder="you@example.com" autocomplete="email"/>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password"/>
    <button onclick="passwordLogin()">Sign in</button>
    <button class="secondary" onclick="togglePassword()">Use email code instead</button>
  </div>
  <div class="err" id="err"></div>
  <script>
    var Q = "${q}";
    function show(id){["step-email","step-code","step-password"].forEach(function(s){document.getElementById(s).classList.add("hidden")});document.getElementById(id).classList.remove("hidden");}
    function err(m){document.getElementById("err").textContent=m||"";}
    function cont(){ location.href = "/oauth/authorize?" + Q; }
    async function startLogin(){ err(""); var email=document.getElementById("email").value.trim(); if(!email)return err("Email required");
      await fetch("/oauth/login/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email})});
      document.getElementById("email-label").textContent=email; window.__email=email; show("step-code"); }
    async function verifyCode(){ err(""); var code=document.getElementById("code").value.trim();
      var r=await fetch("/oauth/login/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:window.__email,code:code})});
      if(r.ok){cont();}else{err("Invalid or expired code");} }
    function togglePassword(){ err(""); show(document.getElementById("step-password").classList.contains("hidden")?"step-password":"step-email"); }
    async function passwordLogin(){ err(""); var email=document.getElementById("pw-email").value.trim(); var pw=document.getElementById("pw").value;
      var r=await fetch("/oauth/login/password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,password:pw})});
      if(r.ok){cont();}else{err("Invalid credentials");} }
    function usePasskey(){ err("Passkey: please use the standard login, then return."); }
  </script>`;
  return shell(d.appName, d.logoUrl, body);
};

export const defaultConsentView = (d: ConsentViewData): string => {
  const q = esc(d.authorizeQuery);
  const items = d.scopes.map((s) => `<li>${esc(s)}</li>`).join("");
  const body = `
  <h1>Authorize ${esc(d.clientName)}</h1>
  <p><strong>${esc(d.clientName)}</strong> wants to access your account:</p>
  <ul class="scopes">${items}</ul>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="authorize_query" value="${q}"/>
    <button type="submit" name="decision" value="approve">Allow</button>
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  </form>`;
  return shell(d.appName, d.logoUrl, body);
};

export const defaultTenantSelectView = (d: TenantSelectViewData): string => {
  const q = esc(d.authorizeQuery);
  const opts = d.tenants
    .map(
      (t) =>
        `<button onclick="pick('${esc(t.id)}')">${esc(t.name)}</button>`
    )
    .join("");
  const body = `
  <h1>Choose an organization</h1>
  <p>Select which organization to continue with.</p>
  ${opts}
  <script>
    var Q="${q}";
    function pick(id){ var u=new URLSearchParams(Q); u.set("tenant_id",id); location.href="/oauth/authorize?"+u.toString(); }
  </script>`;
  return shell(d.appName, d.logoUrl, body);
};

export const defaultOAuthViews: OAuthViews = {
  login: defaultLoginView,
  consent: defaultConsentView,
  tenantSelect: defaultTenantSelectView,
};
