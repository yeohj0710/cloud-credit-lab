import { isAuthorized } from "./lib/auth.js";
export default async function middleware(request) {
  const url = new URL(request.url);
  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/api/public-dashboard" ||
    url.pathname === "/login" ||
    url.pathname === "/login.html" ||
    url.pathname === "/api/login" ||
    url.pathname === "/api/worker-callback" ||
    url.pathname === "/api/cleanup"
  )
    return;
  if (await isAuthorized(request)) return;
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const login = new URL("/login.html", request.url);
  login.searchParams.set("next", `${url.pathname}${url.search}`);
  return Response.redirect(login, 307);
}
export const config = {
  matcher: [
    "/",
    "/index.html",
    "/ncp",
    "/ncp.html",
    "/storage",
    "/storage.html",
    "/ncp-storage",
    "/ncp-storage.html",
    "/jobs",
    "/jobs.html",
    "/explorer",
    "/explorer.html",
    "/research",
    "/research.html",
    "/persona",
    "/persona.html",
    "/api/:path*",
  ],
};
