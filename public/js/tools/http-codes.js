// HTTP STATUS CODES
// ============================================================
const HTTP_CODES=[
  {code:100,name:'Continue',desc:'Server received request headers; client should continue.',cat:'1',info:'The server has received the request headers and the client should proceed to send the request body.',example:'Client sends headers, server responds 100 Continue, client sends POST data.'},
  {code:101,name:'Switching Protocols',desc:'Server is switching protocols as requested (e.g. WebSocket).',cat:'1',info:'The requester has asked the server to switch protocols and the server has agreed to do so.',example:'HTTP/1.1 Upgrade: websocket\nConnection: Upgrade'},
  {code:200,name:'OK',desc:'Request succeeded. Mendix REST returns this for successful GET operations.',cat:'2',info:'Standard response for successful HTTP requests. The actual response will depend on the request method used.',example:'GET /api/v1/users -> 200 OK\n{\n  "users": [...]\n}'},
  {code:201,name:'Created',desc:'Resource created. Returned by Mendix REST on successful POST.',cat:'2',info:'The request has been fulfilled, resulting in the creation of a new resource.',example:'POST /api/v1/users -> 201 Created\nLocation: /api/v1/users/123'},
  {code:204,name:'No Content',desc:'Request succeeded, no body. Common for DELETE operations.',cat:'2',info:'The server successfully processed the request and is not returning any content.',example:'DELETE /api/v1/users/123 -> 204 No Content'},
  {code:206,name:'Partial Content',desc:'Server delivering part of the resource (range requests, downloads).',cat:'2',info:'The server is delivering only part of the resource due to a range header sent by the client.',example:'GET /video.mp4 (Range: bytes=0-1023) -> 206 Partial Content'},
  {code:301,name:'Moved Permanently',desc:'Resource permanently moved. Update your hardcoded URLs.',cat:'3',info:'This and all future requests should be directed to the given URI.',example:'GET /old-api -> 301 Moved Permanently\nLocation: /new-api'},
  {code:302,name:'Found (Redirect)',desc:'Temporary redirect. Common in Mendix SSO login flows.',cat:'3',info:'Tells the client to look at (browse to) another URL. Commonly used for SSO integration.',example:'GET /login -> 302 Found\nLocation: https://sso.provider.com/auth'},
  {code:304,name:'Not Modified',desc:'Client cache is valid; no body returned.',cat:'3',info:'Indicates that the resource has not been modified since the version specified by the request headers.',example:'GET /script.js (If-None-Match: "xyz") -> 304 Not Modified'},
  {code:400,name:'Bad Request',desc:'Malformed request or invalid parameters. Check request body and headers in your Mendix REST call.',cat:'4',info:'The server cannot or will not process the request due to an apparent client error (e.g., malformed request syntax, size too large, invalid request message framing, or deceptive request routing).',example:'POST /api/v1/users\n{"age": "twenty"} -> 400 Bad Request'},
  {code:401,name:'Unauthorized',desc:'Authentication required. Check user credentials or API token in your Mendix integration.',cat:'4',info:'Similar to 403 Forbidden, but specifically for use when authentication is required and has failed or has not yet been provided.',example:'GET /api/v1/secure-data -> 401 Unauthorized\nWWW-Authenticate: Basic'},
  {code:403,name:'Forbidden',desc:'Authenticated but not authorized. Review Mendix security roles and microflow access.',cat:'4',info:'The request contained valid data and was understood by the server, but the server is refusing action. This may be due to the user not having the necessary permissions for a resource.',example:'GET /admin-dashboard (User Role: Guest) -> 403 Forbidden'},
  {code:404,name:'Not Found',desc:"Resource doesn't exist. Check published REST URL or OData entity path.",cat:'4',info:'The requested resource could not be found but may be available in the future. Subsequent requests by the client are permissible.',example:'GET /api/v1/users/9999 -> 404 Not Found'},
  {code:405,name:'Method Not Allowed',desc:'HTTP method not supported. Check published REST service operation methods.',cat:'4',info:'A request method is not supported for the requested resource; for example, a GET request on a form that requires data to be presented via POST.',example:'POST /api/v1/read-only-data -> 405 Method Not Allowed'},
  {code:409,name:'Conflict',desc:'Conflict with current state. Usually uniqueness constraint violations.',cat:'4',info:'Indicates that the request could not be processed because of conflict in the current state of the resource, such as an edit conflict between multiple simultaneous updates.',example:'POST /api/v1/users (Email already exists) -> 409 Conflict'},
  {code:413,name:'Payload Too Large',desc:'Request body exceeds limit. Check Mendix file upload size settings.',cat:'4',info:'The request is larger than the server is willing or able to process.',example:'POST /api/v1/upload (100MB file, limit 10MB) -> 413 Payload Too Large'},
  {code:422,name:'Unprocessable Entity',desc:'Request well-formed but semantically invalid. Common in REST API validation.',cat:'4',info:'The request was well-formed but was unable to be followed due to semantic errors.',example:'POST /api/v1/users\n{"username": "a"} -> 422 Unprocessable Entity (Username too short)'},
  {code:429,name:'Too Many Requests',desc:'Rate limit exceeded. Implement retry logic with exponential backoff in Mendix.',cat:'4',info:'The user has sent too many requests in a given amount of time. Intended for use with rate-limiting schemes.',example:'GET /api/v1/data (Rate limit: 100/min, Request 101) -> 429 Too Many Requests\nRetry-After: 60'},
  {code:500,name:'Internal Server Error',desc:'Mendix runtime error. Check application logs for stack trace and error details.',cat:'5',info:'A generic error message, given when an unexpected condition was encountered and no more specific message is suitable.',example:'GET /api/v1/data -> 500 Internal Server Error (NullPointerException in Microflow)'},
  {code:502,name:'Bad Gateway',desc:'Proxy received invalid response. Check Mendix cloud/on-prem network config.',cat:'5',info:'The server was acting as a gateway or proxy and received an invalid response from the upstream server.',example:'Nginx -> Tomcat (Connection Refused) -> 502 Bad Gateway'},
  {code:503,name:'Service Unavailable',desc:'Server temporarily unavailable. May appear during Mendix app deployments.',cat:'5',info:'The server cannot handle the request (because it is overloaded or down for maintenance). Generally, this is a temporary state.',example:'GET / -> 503 Service Unavailable (Mendix App is restarting)'},
  {code:504,name:'Gateway Timeout',desc:'Gateway timed out waiting for Mendix. Check for long-running microflows or DB queries.',cat:'5',info:'The server was acting as a gateway or proxy and did not receive a timely response from the upstream server.',example:'AWS ALB -> Mendix (Microflow takes 120s, ALB timeout 60s) -> 504 Gateway Timeout'},
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
function renderHttpGrid(){
  const filtered=HTTP_CODES.filter(c=>{if(httpCurFilter!=='all'&&!String(c.code).startsWith(httpCurFilter))return false;if(httpCurSearch&&!String(c.code).includes(httpCurSearch)&&!c.name.toLowerCase().includes(httpCurSearch)&&!c.desc.toLowerCase().includes(httpCurSearch))return false;return true;});
  let html='';
  const grouped={};
  filtered.forEach(c=>{if(!grouped[c.cat])grouped[c.cat]=[];grouped[c.cat].push(c);});
  ['2','3','4','5','1'].forEach(cat=>{
    if(grouped[cat]&&grouped[cat].length>0){
      const ci=HTTP_CATS[cat];
      html+='<div style="grid-column: 1 / -1; margin-top: var(--sp-4); margin-bottom: 4px; border-bottom: 1px solid var(--border-subtle); padding-bottom: var(--sp-2);"><h3 style="font-size: 1.1rem; color: var(--text-primary); margin-bottom: 4px;">'+ci.title+'</h3><p style="font-size: .8rem; color: var(--text-secondary);">'+ci.desc+'</p></div>';
      html+=grouped[cat].map(c=>'<div class="http-card" style="cursor:pointer" onclick="showHttpModal('+c.code+')"><div class="http-code http-'+c.cat+'xx">'+c.code+'</div><div><div class="http-name">'+escHtml(c.name)+'</div><div class="http-desc">'+escHtml(c.desc)+'</div></div></div>').join('');
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

export function init() {
  renderHttpGrid();
}
