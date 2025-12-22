// ════════════════════════════════════════════════════════════════════
// XAVI for NetSuite - Cloudflare Worker Proxy
// ════════════════════════════════════════════════════════════════════
// 
// Copyright (c) 2025 Celigo, Inc.
// All rights reserved.
// 
// This source code is proprietary and confidential. Unauthorized copying,
// modification, distribution, or use of this software, via any medium,
// is strictly prohibited without the express written permission of Celigo, Inc.
// 
// For licensing inquiries, contact: legal@celigo.com
// 
// ════════════════════════════════════════════════════════════════════
// 
// INSTRUCTIONS:
// 1. Go to: https://dash.cloudflare.com
// 2. Navigate to: Workers & Pages → Your Worker
// 3. Click: Edit Code
// 4. Replace ALL code with this file
// 5. Click: Save and Deploy
//
// CURRENT TUNNEL URLS:
// - Python Backend: https://comfortable-honest-garage-desired.trycloudflare.com
// - .NET Backend: (set DOTNET_TUNNEL_URL below - get from cloudflared output)
// CURRENT ACCOUNT: 589861 (Production)
// Last Updated: Jan 2025
// ════════════════════════════════════════════════════════════════════

export default {
  async fetch(request) {
    // Python backend tunnel (for most endpoints)
    const PYTHON_TUNNEL_URL = 'https://comfortable-honest-garage-desired.trycloudflare.com';
    
    // .NET backend tunnel (for balance-sheet/report endpoint)
    // ⚠️ UPDATE THIS when .NET backend tunnel URL changes
    // To get the URL, run: cloudflared tunnel --url http://localhost:5003
    // Copy the https://xxxxx.trycloudflare.com URL and paste it here
    const DOTNET_TUNNEL_URL = 'https://arcade-pharmaceuticals-configurations-former.trycloudflare.com';

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Expose-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // Route balance-sheet/report to .NET backend
      // All other requests go to Python backend
      let targetUrl;
      let backendType;
      if (pathname.startsWith('/balance-sheet/report')) {
        targetUrl = DOTNET_TUNNEL_URL + pathname + url.search;
        backendType = '.NET';
      } else {
        targetUrl = PYTHON_TUNNEL_URL + pathname + url.search;
        backendType = 'Python';
      }
      
      // Log routing decision (remove in production if needed)
      console.log(`[Worker] Routing ${pathname} to ${backendType} backend: ${targetUrl}`);
      
      const headers = new Headers(request.headers);
      headers.delete('host');

      // Note: Cloudflare Tunnel has a ~100s timeout limit
      // For balance-sheet/report, we need to work within this constraint
      // The Workers proxy timeout is less restrictive, but tunnel is the bottleneck
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
      });

      // Add CORS headers to response
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', '*');
      newHeaders.set('Access-Control-Expose-Headers', '*');
      newHeaders.set('Cache-Control', 'no-cache');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
      
    } catch (error) {
      // Error response with CORS
      const url = new URL(request.url);
      const pathname = url.pathname;
      const backendType = pathname.startsWith('/balance-sheet/report') ? '.NET' : 'Python';
      const tunnelUrl = pathname.startsWith('/balance-sheet/report') ? DOTNET_TUNNEL_URL : PYTHON_TUNNEL_URL;
      
      return new Response(JSON.stringify({
        error: 'Proxy error',
        message: error.message,
        path: pathname,
        backendType: backendType,
        tunnelUrl: tunnelUrl,
        pythonTunnel: PYTHON_TUNNEL_URL,
        dotNetTunnel: DOTNET_TUNNEL_URL,
        timestamp: new Date().toISOString()
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
        }
      });
    }
  }
};
