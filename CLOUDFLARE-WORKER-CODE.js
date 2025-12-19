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
// CURRENT TUNNEL URL: https://designing-navigation-surgery-sacred.trycloudflare.com
// CURRENT ACCOUNT: 589861 (Production)
// Last Updated: Dec 17, 2025
// ════════════════════════════════════════════════════════════════════

export default {
  async fetch(request) {
    // ⚠️ UPDATE THIS LINE when tunnel URL changes:
    const TUNNEL_URL = 'https://designing-navigation-surgery-sacred.trycloudflare.com';

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
      // Forward request to tunnel
      const url = new URL(request.url);
      const targetUrl = TUNNEL_URL + url.pathname + url.search;
      
      const headers = new Headers(request.headers);
      headers.delete('host');

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
      return new Response(JSON.stringify({
        error: 'Proxy error',
        message: error.message,
        tunnel: TUNNEL_URL,
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
