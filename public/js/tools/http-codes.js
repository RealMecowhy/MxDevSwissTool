// HTTP STATUS CODES
// ============================================================
const HTTP_CODES=[
  {code:100,name:'Continue',desc:'Server received request headers; client should continue.',cat:'1',info:'The server has received the request headers and the client should proceed to send the request body.',example:'Client sends headers, server responds 100 Continue, client sends POST data.',mendix:'Rarely surfaced in day-to-day Mendix development — mostly relevant to low-level HTTP clients doing chunked uploads, not to app logic.'},
  {code:101,name:'Switching Protocols',desc:'Server is switching protocols as requested (e.g. WebSocket).',cat:'1',info:'The requester has asked the server to switch protocols and the server has agreed to do so.',example:'HTTP/1.1 Upgrade: websocket\nConnection: Upgrade',mendix:'Not seen in standard Mendix apps — would only appear if a custom Java action or widget opens a raw WebSocket connection.'},
  {code:200,name:'OK',desc:'Request succeeded.',cat:'2',info:'Standard response for successful HTTP requests. The actual response will depend on the request method used.',example:'GET /api/v1/users -> 200 OK\n{\n  "users": [...]\n}',mendix:'Returned by Mendix published REST/OData services for a successful GET.'},
  {code:201,name:'Created',desc:'Resource created.',cat:'2',info:'The request has been fulfilled, resulting in the creation of a new resource.',example:'POST /api/v1/users -> 201 Created\nLocation: /api/v1/users/123',mendix:'Returned by Mendix published REST services on a successful POST that creates an object.'},
  {code:204,name:'No Content',desc:'Request succeeded, no body.',cat:'2',info:'The server successfully processed the request and is not returning any content.',example:'DELETE /api/v1/users/123 -> 204 No Content',mendix:'Typical for Mendix REST DELETE operations, which do not return a body.'},
  {code:206,name:'Partial Content',desc:'Server delivering part of the resource (range requests, downloads).',cat:'2',info:'The server is delivering only part of the resource due to a range header sent by the client.',example:'GET /video.mp4 (Range: bytes=0-1023) -> 206 Partial Content',mendix:'Seen when downloading a large FileDocument/Image via the runtime’s file endpoint with Range requests (e.g. video/PDF scrubbing).'},
  {code:301,name:'Moved Permanently',desc:'Resource permanently moved. Update your hardcoded URLs.',cat:'3',info:'This and all future requests should be directed to the given URI.',example:'GET /old-api -> 301 Moved Permanently\nLocation: /new-api',mendix:'Not issued by the Mendix runtime itself — usually configured at the load balancer/custom-domain level (enforcing HTTPS, or redirecting a retired app URL).'},
  {code:302,name:'Found (Redirect)',desc:'Temporary redirect.',cat:'3',info:'Tells the client to look at (browse to) another URL. Commonly used for SSO integration.',example:'GET /login -> 302 Found\nLocation: https://sso.provider.com/auth',mendix:'Common in Mendix SAML/OIDC SSO login flows, redirecting to and back from the identity provider.'},
  {code:303,name:'See Other',desc:'Redirect after POST — follow with GET. Very common in Mendix SSO and Deep Link.',cat:'3',info:'Tells the client to fetch the target with GET, regardless of the method that produced this response. That method switch is what separates it from 307/308, and is why it is the correct code to end a POST with.',example:'POST /SSO/assertion -> 303 See Other\nLocation: /index.html',mendix:'One of the most frequent non-200 codes in a real Mendix access log, and normally <strong>not</strong> a problem. In 7.8M requests from ten production apps it appeared 62 769× — every one of them either the SAML module completing a login (<code>/SSO/assertion</code>, 41 170×) or the Deep Link module resolving a <code>/link/…</code> URL into the page it points at. Treat a steady 303 rate as the SSO and deep-link flows working; investigate only if it disappears or spikes far above your login volume.'},
  {code:304,name:'Not Modified',desc:'Client cache is valid; no body returned.',cat:'3',info:'Indicates that the resource has not been modified since the version specified by the request headers.',example:'GET /script.js (If-None-Match: "xyz") -> 304 Not Modified',mendix:'Seen on static resources (theme CSS/JS, images) that the Mendix runtime serves with caching headers.'},
  {code:400,name:'Bad Request',desc:'Malformed request or invalid parameters.',cat:'4',info:'The server cannot or will not process the request due to an apparent client error (e.g., malformed request syntax, size too large, invalid request message framing, or deceptive request routing).',example:'POST /api/v1/users\n{"age": "twenty"} -> 400 Bad Request',mendix:'Check the request body/headers against what your Mendix published REST service expects — often a type mismatch.'},
  {code:401,name:'Unauthorized',desc:'Authentication required.',cat:'4',info:'Similar to 403 Forbidden, but specifically for use when authentication is required and has failed or has not yet been provided.',example:'GET /api/v1/secure-data -> 401 Unauthorized\nWWW-Authenticate: Basic',mendix:'In a Mendix access log this is really <strong>two unrelated problems that share one code</strong> — the URL tells them apart. On <code>/xas/</code> it is a browser session that has expired or was never established, so the client re-authenticates and the user sees a login screen; a steady background rate is normal (11 165× across ten production apps) and needs no action. On <code>/odata/…</code> or <code>/rest/…</code> it is an integration whose credentials or API token are wrong, expired, or missing — that one is a real fault, and it is worth splitting your 401s by path before concluding anything.'},
  {code:403,name:'Forbidden',desc:'Authenticated but not authorized.',cat:'4',info:'The request contained valid data and was understood by the server, but the server is refusing action. This may be due to the user not having the necessary permissions for a resource.',example:'GET /admin-dashboard (User Role: Guest) -> 403 Forbidden',mendix:'Review Mendix security: user roles, entity access rules, and microflow/page access on the called resource.'},
  {code:404,name:'Not Found',desc:"Resource doesn't exist.",cat:'4',info:'The requested resource could not be found but may be available in the future. Subsequent requests by the client are permissible.',example:'GET /api/v1/users/9999 -> 404 Not Found',mendix:'Check the published REST URL / OData entity path, and that the service is actually deployed and enabled.'},
  {code:405,name:'Method Not Allowed',desc:'HTTP method not supported.',cat:'4',info:'A request method is not supported for the requested resource; for example, a GET request on a form that requires data to be presented via POST.',example:'POST /api/v1/read-only-data -> 405 Method Not Allowed',mendix:'Check which HTTP methods the published REST service operation actually allows.'},
  {code:408,name:'Request Timeout',desc:'Client took too long to send the request.',cat:'4',info:'The server closed an idle connection because the client did not finish sending its request in time. It concerns the request being received, not the work the server then does — a slow microflow produces 504, never 408.',example:'POST /ws/import (client stalls mid-upload) -> 408 Request Timeout',mendix:'Rare and usually benign: a mobile client on a dropping connection, or a keep-alive connection reaped by the proxy. If it clusters on one upload endpoint, look at request size and client bandwidth rather than at the app — the runtime never saw a complete request to process.'},
  {code:409,name:'Conflict',desc:'Conflict with current state.',cat:'4',info:'Indicates that the request could not be processed because of conflict in the current state of the resource, such as an edit conflict between multiple simultaneous updates.',example:'POST /api/v1/users (Email already exists) -> 409 Conflict',mendix:'Returned by Mendix REST/OData when a unique attribute/association constraint is violated on create or update.'},
  {code:413,name:'Payload Too Large',desc:'Request body exceeds limit.',cat:'4',info:'The request is larger than the server is willing or able to process.',example:'POST /api/v1/upload (100MB file, limit 10MB) -> 413 Payload Too Large',mendix:'Check the Mendix file upload size / max request size settings for the app.'},
  {code:422,name:'Unprocessable Entity',desc:'Request well-formed but semantically invalid.',cat:'4',info:'The request was well-formed but was unable to be followed due to semantic errors.',example:'POST /api/v1/users\n{"username": "a"} -> 422 Unprocessable Entity (Username too short)',mendix:'Returned by Mendix REST/OData when entity validation (a validation microflow or attribute validation rule) rejects the submitted data.'},
  {code:429,name:'Too Many Requests',desc:'Rate limit exceeded.',cat:'4',info:'The user has sent too many requests in a given amount of time. Intended for use with rate-limiting schemes.',example:'GET /api/v1/data (Rate limit: 100/min, Request 101) -> 429 Too Many Requests\nRetry-After: 60',mendix:'Implement retry logic with exponential backoff in your Mendix integration/microflow calling the rate-limited service.'},
  {code:500,name:'Internal Server Error',desc:'Unexpected server-side error.',cat:'5',info:'A generic error message, given when an unexpected condition was encountered and no more specific message is suitable.',example:'GET /api/v1/data -> 500 Internal Server Error (NullPointerException in Microflow)',mendix:'A Mendix runtime error — check the application logs for the stack trace and the failing microflow/Java action.'},
  {code:502,name:'Bad Gateway',desc:'Proxy received an invalid response.',cat:'5',info:'The server was acting as a gateway or proxy and received an invalid response from the upstream server.',example:'Nginx -> Tomcat (Connection Refused) -> 502 Bad Gateway',mendix:'Check the Mendix Cloud/on-premises network path — the runtime process may be down or unreachable from the proxy.'},
  {code:503,name:'Service Unavailable',desc:'Server temporarily unavailable.',cat:'5',info:'The server cannot handle the request (because it is overloaded or down for maintenance). Generally, this is a temporary state.',example:'GET / -> 503 Service Unavailable (Mendix App is restarting)',mendix:'Common right after a Mendix app deployment/restart, while the runtime is still starting up.'},
  {code:504,name:'Gateway Timeout',desc:'Gateway timed out waiting for the upstream server.',cat:'5',info:'The server was acting as a gateway or proxy and did not receive a timely response from the upstream server.',example:'AWS ALB -> Mendix (Microflow takes 120s, ALB timeout 60s) -> 504 Gateway Timeout',mendix:'Check for a long-running microflow or slow database query exceeding the load balancer/proxy timeout.'},
  {code:560,name:'Mendix: application error',desc:'Non-standard code the Mendix runtime returns to its own client when a request throws.',cat:'5',info:'560 is outside the IANA-registered range — no generic HTTP reference defines it, because it is the Mendix runtime\'s own code rather than a web standard. It appears on the client protocol endpoint <code>/xas/</code> (and on <code>/file</code>), which is how the Mendix browser client talks to the runtime.',example:'POST /xas/ -> 560\n{"errorMessage":"An error has occurred while handling the request.","errorCode":"MENDIX_ERROR"}',mendix:'<strong>Established by correlation, not by documentation:</strong> across ten production apps every 560 on <code>/xas/</code> lines up to the millisecond with a <code>Connector: An error has occurred while handling the request. [User \'…\']</code> line in the runtime log. So a 560 in the access log <em>is</em> a user-visible application error, and the matching runtime line names the user, session and roles — that is where to look next, since the access log alone never says what failed. Paste that runtime line into the Error Decoder. Neighbouring codes in the same custom 5xx range (551 was observed once) come from the same client protocol; their exact meanings are not documented, so read the runtime log at the same timestamp rather than the code.'},
];
let httpCurFilter='all',httpCurSearch='';
function httpSearch(){httpCurSearch=document.getElementById('http-search').value.toLowerCase();renderHttpGrid();}
function httpFilter(cat,btn){httpCurFilter=cat;document.querySelectorAll('#http-cat-filter .btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderHttpGrid();}
const HTTP_CATS={
  '2':{title:'2xx: Success (Everything went well)',desc:'The server successfully received, understood, and processed the request.'},
  '3':{title:'3xx: Redirection (You need to go elsewhere)',desc:'Further action needs to be taken by the client to complete the request.'},
  '4':{title:'4xx: Client Error (You messed up / Your bad)',desc:'The request contains bad syntax or cannot be fulfilled (e.g., lack of permissions).'},
  '5':{title:'5xx: Server Error (The server messed up)',desc:'The server failed to fulfill a valid request due to its own error.'},
  '1':{title:'1xx: Informational',desc:'Technical information meaning "processing continues", rarely encountered in daily work.'}
};
function httpMatchesSearch(c,q){return String(c.code).includes(q)||c.name.toLowerCase().includes(q)||c.desc.toLowerCase().includes(q)||(c.mendix&&c.mendix.toLowerCase().includes(q));}
function renderHttpGrid(){
  const filtered=HTTP_CODES.filter(c=>{if(httpCurFilter!=='all'&&!String(c.code).startsWith(httpCurFilter))return false;if(httpCurSearch&&!httpMatchesSearch(c,httpCurSearch))return false;return true;});
  let html='';
  const grouped={};
  filtered.forEach(c=>{if(!grouped[c.cat])grouped[c.cat]=[];grouped[c.cat].push(c);});
  ['2','3','4','5','1'].forEach(cat=>{
    if(grouped[cat]&&grouped[cat].length>0){
      const ci=HTTP_CATS[cat];
      html+='<div style="grid-column: 1 / -1; margin-top: var(--sp-4); margin-bottom: 4px; border-bottom: 1px solid var(--border-subtle); padding-bottom: var(--sp-2);"><h3 style="font-size: 1.1rem; color: var(--text-primary); margin-bottom: 4px;">'+ci.title+'</h3><p style="font-size: .8rem; color: var(--text-secondary);">'+ci.desc+'</p></div>';
      html+=grouped[cat].map(c=>'<div class="http-card" style="cursor:pointer" onclick="showHttpModal('+c.code+')"><div class="http-code http-'+c.cat+'xx">'+c.code+'</div><div><div class="http-name">'+escHtml(c.name)+'</div><div class="http-desc">'+escHtml(c.desc)+'</div>'+(c.mendix?'<div class="http-desc" style="color:var(--accent);margin-top:2px"><strong>In Mendix:</strong> '+escHtml(c.mendix)+'</div>':'')+'</div></div>').join('');
    }
  });
  document.getElementById('http-grid').innerHTML=html;
}
function showHttpModal(code) {
  const c = HTTP_CODES.find(x => x.code === code);
  if (!c) return;
  const modal = document.getElementById('http-modal');
  const codeEl = document.getElementById('http-modal-code');
  const titleEl = document.getElementById('http-modal-title');
  const bodyEl = document.getElementById('http-modal-body');

  codeEl.textContent = c.code;
  codeEl.className = 'http-' + c.cat + 'xx';
  titleEl.textContent = c.name;

  bodyEl.innerHTML = '<p>' + escHtml(c.desc) + '</p>' +
    (c.mendix ? '<h4>In Mendix</h4><p>' + escHtml(c.mendix) + '</p>' : '') +
    (c.info ? '<h4>More Information</h4><p>' + escHtml(c.info) + '</p>' : '') +
    (c.example ? '<h4>Example</h4><div class="modal-example">' + escHtml(c.example) + '</div>' : '');
    
  modal.classList.add('active');
}
function closeHttpModal() {
  document.getElementById('http-modal').classList.remove('active');
}

// ============================================================


// --- AUTO-GENERATED ESM EXPORTS ---
window.httpSearch = httpSearch;
window.httpFilter = httpFilter;
window.renderHttpGrid = renderHttpGrid;
window.showHttpModal = showHttpModal;
window.closeHttpModal = closeHttpModal;
window.httpMatchesSearch = httpMatchesSearch;
window.HTTP_CODES = HTTP_CODES;

export function init() {
  renderHttpGrid();
}
