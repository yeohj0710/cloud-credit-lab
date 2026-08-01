const encoder = new TextEncoder();
export async function signature(secret) { const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode("work-memory-authorized")));return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""); }
export function readCookie(request,name){const cookie=request?.headers?.get?.("cookie")||request?.headers?.cookie||"";const pair=cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${name}=`));return pair?decodeURIComponent(pair.slice(name.length+1)):"";}
export async function isAuthorized(request){const secret=process.env.SESSION_SECRET;if(!secret)return false;return readCookie(request,"wm_session")===await signature(secret);}

export function secureEqual(a,b){const left=String(a||""),right=String(b||"");if(left.length!==right.length)return false;let result=0;for(let i=0;i<left.length;i+=1)result|=left.charCodeAt(i)^right.charCodeAt(i);return result===0;}
export function isExecutionPassword(value){const expected=process.env.EXECUTION_PASSWORD||process.env.APP_PASSWORD||"";return Boolean(expected)&&secureEqual(value,expected);}
export function requireExecutionPassword(value){if(!isExecutionPassword(value))throw new Error("execution_password_invalid");return true;}
