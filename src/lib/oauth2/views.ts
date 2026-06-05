/**
 * Default HTML views for the OAuth2 login/consent flow.
 *
 * Minimal, self-contained, black & white. Apps can override each one via
 * `defineServer({ oauth2: { views: { login, consent, tenantSelect } } })` —
 * analogous to how `emailTemplates` are overridden.
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
  :root{
    --ink:#111113; --muted:#6b6b70; --line:#e6e6e8; --field:#cfcfd3;
    --bg:#ffffff; --hover:#f6f6f7; --err:#b42318;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    display:flex;align-items:center;justify-content:center;min-height:100%;padding:24px;
  }
  .card{
    width:100%;max-width:380px;background:var(--bg);
    border:1px solid var(--line);border-radius:14px;padding:40px 36px;
    box-shadow:0 1px 2px rgba(17,17,19,.04),0 12px 32px rgba(17,17,19,.05);
  }
  .brand{text-align:center;margin-bottom:28px}
  .brand img{max-height:40px;width:auto}
  .brand .name{font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
  h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0 0 6px;line-height:1.25}
  p{margin:0 0 18px;color:var(--muted);font-size:14px;line-height:1.55}
  label{display:block;font-size:13px;font-weight:500;margin:0 0 6px;color:var(--ink)}
  input{
    width:100%;padding:11px 13px;margin-bottom:14px;font-size:15px;color:var(--ink);
    background:var(--bg);border:1px solid var(--field);border-radius:9px;outline:none;
    transition:border-color .15s ease,box-shadow .15s ease;
  }
  input:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(17,17,19,.07)}
  input::placeholder{color:#a7a7ac}
  #code{text-align:center;letter-spacing:.35em;font-size:19px;padding-left:.35em}
  button{
    width:100%;padding:11px 16px;margin-top:4px;font-size:15px;font-weight:500;
    border-radius:9px;cursor:pointer;border:1px solid var(--ink);background:var(--ink);color:#fff;
    transition:background .15s ease,border-color .15s ease,opacity .15s ease;
  }
  button:hover{background:#2c2c30;border-color:#2c2c30}
  button.secondary{background:var(--bg);color:var(--ink);border:1px solid var(--field)}
  button.secondary:hover{background:var(--hover);border-color:var(--field)}
  .row{display:flex;gap:10px}
  .row button{margin-top:0}
  .muted{margin:14px 0 0;text-align:center;font-size:13px;color:var(--muted)}
  .muted a,a{color:var(--ink);text-decoration:underline;text-underline-offset:2px}
  .err{color:var(--err);font-size:13px;min-height:18px;margin-top:10px}
  .hidden{display:none}
  .scopes{list-style:none;margin:0 0 20px;padding:14px 16px;border:1px solid var(--line);border-radius:10px}
  .scopes li{font-size:14px;color:var(--ink);padding:5px 0 5px 22px;position:relative}
  .scopes li::before{content:"";position:absolute;left:4px;top:11px;width:6px;height:6px;border-radius:50%;background:var(--ink)}
  .tenants{display:flex;flex-direction:column;gap:8px}
  .tenants button{text-align:left}
</style></head><body><div class="card">
<div class="brand">${
  logoUrl
    ? `<img src="${logoUrl}" alt="${appName}"/>`
    : `<span class="name">${appName}</span>`
}</div>
${body}
</div></body></html>`;

/** HTML-attribute / text escaping (entities). */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Safe escaping for embedding a value inside a double-quoted JS string literal.
 * Crucially does NOT touch `&` — the authorize query is reused verbatim as a URL,
 * so HTML-entity-escaping it (`&` → `&amp;`) would corrupt the query parameters.
 * Escapes only what could break out of the JS string / <script> context.
 */
const jsStr = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\x3C")
    .replace(/\r?\n/g, "");

export const defaultLoginView = (d: OAuthViewData): string => {
  const q = jsStr(d.authorizeQuery);
  const body = `
  <h1>Sign in</h1>
  <p>Continue to ${esc(d.appName)}. Enter your email to receive a login code.</p>
  <div id="step-email">
    <input id="email" type="email" placeholder="you@example.com" autocomplete="email"/>
    <button onclick="startLogin()">Send code</button>
    <button class="secondary" onclick="togglePassword()">Use password instead</button>
    <p class="muted"><a href="#" onclick="usePasskey();return false">Use a passkey</a></p>
  </div>
  <div id="step-code" class="hidden">
    <p>We sent a 6-digit code to <span id="email-label"></span>.</p>
    <input id="code" inputmode="numeric" maxlength="6" placeholder="······"/>
    <button onclick="verifyCode()">Continue</button>
    <p class="muted"><a href="#" onclick="backToEmail();return false">Use a different email</a></p>
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
      document.getElementById("email-label").textContent=email; window.__email=email; show("step-code"); document.getElementById("code").focus(); }
    async function verifyCode(){ err(""); var code=document.getElementById("code").value.trim();
      var r=await fetch("/oauth/login/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:window.__email,code:code})});
      if(r.ok){cont();}else{err("Invalid or expired code");} }
    function backToEmail(){ err(""); show("step-email"); }
    function togglePassword(){ err(""); show(document.getElementById("step-password").classList.contains("hidden")?"step-password":"step-email"); }
    async function passwordLogin(){ err(""); var email=document.getElementById("pw-email").value.trim(); var pw=document.getElementById("pw").value;
      var r=await fetch("/oauth/login/password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,password:pw})});
      if(r.ok){cont();}else{err("Invalid credentials");} }
    function usePasskey(){ err("Passkey: please use the standard login, then return."); }
    document.getElementById("code").addEventListener("keyup",function(e){if(e.key==="Enter")verifyCode();});
    document.getElementById("email").addEventListener("keyup",function(e){if(e.key==="Enter")startLogin();});
  </script>`;
  return shell(d.appName, d.logoUrl, body);
};

export const defaultConsentView = (d: ConsentViewData): string => {
  const q = esc(d.authorizeQuery);
  const items = d.scopes.map((s) => `<li>${esc(s)}</li>`).join("");
  const body = `
  <h1>Authorize access</h1>
  <p><strong>${esc(d.clientName)}</strong> wants to access your account.</p>
  <ul class="scopes">${items}</ul>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="authorize_query" value="${q}"/>
    <div class="row">
      <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </div>
  </form>`;
  return shell(d.appName, d.logoUrl, body);
};

export const defaultTenantSelectView = (d: TenantSelectViewData): string => {
  const q = jsStr(d.authorizeQuery);
  const opts = d.tenants
    .map(
      (t) =>
        `<button class="secondary" onclick="pick('${esc(t.id)}')">${esc(t.name)}</button>`
    )
    .join("");
  const body = `
  <h1>Choose organization</h1>
  <p>Select which organization to continue with.</p>
  <div class="tenants">${opts}</div>
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
